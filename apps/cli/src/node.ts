// `rev node`: turns this computer into a Rev node. The node long-polls Rev for jobs and
// runs only the fixed kinds in NODE_JOB_KINDS: create a workspace (a folder with its own
// agent), and start or stop a Claude Code session in it, inside tmux so a person can
// attach. What Claude Code may do unattended (claudeArgs) is set on this machine only.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gitUrl, workspaceName, workspaceSession, type NodeCapabilities, type NodeJob } from "@rev/shared";
import { RevApi, RevApiError } from "./api";
import { VERSION } from "./version";

const execFileAsync = promisify(execFile);

export interface NodeConfig {
  url: string;
  token: string;
  nodeId: string;
  name: string;
  /** Folder workspaces are created in. */
  workspaceRoot: string;
  /** Extra arguments for `claude`, e.g. ["--permission-mode", "acceptEdits"]. */
  claudeArgs: string[];
}

/** What this node knows about each workspace it created, by workspace id. */
interface WorkspaceEntry {
  name: string;
  path: string;
  /** The agent's Rev config (url + token), outside the workspace so it is never committed. */
  agentConfig: string;
  agentName: string;
}
type Registry = Record<string, WorkspaceEntry>;

/** Process and timer access, swappable in tests. */
export interface Sys {
  exec(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
  sleep(ms: number): Promise<void>;
}

export const realSys: Sys = {
  async exec(cmd, args, opts = {}) {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      timeout: opts.timeoutMs ?? 60_000,
      // A hung claude ignores SIGTERM.
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The node's files: its config, and next to it the workspaces it knows and their agents' tokens. */
export function nodePaths(env: NodeJS.ProcessEnv = process.env) {
  const home = env.HOME || os.homedir();
  const config = env.REV_NODE_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "rev", "node.json");
  const dir = path.dirname(config);
  return {
    home,
    config,
    registry: path.join(dir, "node-workspaces.json"),
    agents: path.join(dir, "agents"),
    defaultRoot: path.join(home, "rev-workspaces"),
  };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Writes a file only this user can read (tokens). */
export async function writePrivate(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
}

export const loadNodeConfig = (env: NodeJS.ProcessEnv = process.env) => readJson<NodeConfig>(nodePaths(env).config);

const sessionName = workspaceSession;

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const errorText = (e: unknown) => {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr?.trim() || err.message || String(e)).split("\n").slice(-5).join("\n").slice(0, 2000);
};

/** What a new session is asked to do first. */
export const START_PROMPT =
  "You are the Rev agent for this workspace. Using the Rev tools and the rev:workflow skill, list the Rev tasks assigned to you " +
  "and work through them one at a time: start each one, do the work in this folder, and deliver it with a review kit " +
  "(or the next round of its review). When none are left, say so and wait: a message arrives here when a new task is assigned to you.";

/** Dialogs Claude Code may show before its first prompt, and the option to pick. */
const STARTUP_ANSWERS = ["Yes, I trust this folder", "Yes, I accept"];

/** Why Claude Code may never get going when the node runs as a background service. */
const STUCK_HINT =
  process.platform === "darwin"
    ? " On macOS this usually means it is waiting for a privacy permission: Claude Code reads a file on an external volume or in " +
      "Desktop, Documents or Downloads (a skill, say), and background services have no access there. Allow node under " +
      "System Settings → Privacy & Security (Files and Folders, or Full Disk Access), or run the node from a terminal instead: " +
      "tmux new -d -s rev-node '~/.local/bin/rev node run'."
    : "";

export async function detectTools(sys: Sys): Promise<NodeCapabilities> {
  const version = async (cmd: string, args: string[]) => {
    try {
      const { stdout, stderr } = await sys.exec(cmd, args, { timeoutMs: 20_000 });
      return ((stdout || stderr).trim().split("\n")[0] ?? "").slice(0, 200) || cmd;
    } catch {
      return null;
    }
  };
  const [git, tmux, claude] = await Promise.all([version("git", ["--version"]), version("tmux", ["-V"]), version("claude", ["--version"])]);
  return { node: process.version, git, tmux, claude };
}

export class NodeRunner {
  readonly api: RevApi;
  private readonly paths: ReturnType<typeof nodePaths>;
  private tools: { at: number; value: NodeCapabilities } | null = null;
  /** Open tasks seen per running workspace, to notice new assignments. */
  private seen = new Map<string, Set<string>>();

  constructor(
    private readonly cfg: NodeConfig,
    private readonly sys: Sys = realSys,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly log: (line: string) => void = (l) => console.log(`${new Date().toISOString()} ${l}`),
  ) {
    this.api = new RevApi(cfg.url, cfg.token);
    this.paths = nodePaths(env);
  }

  private async capabilities() {
    if (!this.tools || Date.now() - this.tools.at > 10 * 60_000) this.tools = { at: Date.now(), value: await detectTools(this.sys) };
    return this.tools.value;
  }

  private async registry() {
    return (await readJson<Registry>(this.paths.registry)) ?? {};
  }

  private saveRegistry(r: Registry) {
    return writePrivate(this.paths.registry, r);
  }

  private tmux(args: string[]) {
    return this.sys.exec("tmux", args, { env: this.env, timeoutMs: 15_000 });
  }

  /** Runs one job; the result is reported to Rev. */
  async handle(job: NodeJob) {
    this.log(`job ${job.kind} ${job.payload.name}`);
    try {
      const result = await this.run(job);
      await this.api.reportJob(job.id, { ok: true, ...result });
      this.log(`job ${job.kind} ${job.payload.name}: done`);
    } catch (e) {
      const error = errorText(e);
      this.log(`job ${job.kind} ${job.payload.name} failed: ${error}`);
      await this.api.reportJob(job.id, { ok: false, error });
    }
  }

  run(job: NodeJob): Promise<{ path?: string }> {
    switch (job.kind) {
      case "workspace.create":
        return this.createWorkspace(job);
      case "session.start":
        return this.startSession(job).then(() => ({}));
      case "session.stop":
        return this.stopSession(job).then(() => ({}));
      default:
        throw new Error(`This version of rev (${VERSION}) does not know the job "${(job as NodeJob).kind}"; update it`);
    }
  }

  async createWorkspace(job: NodeJob) {
    if (!job.workspaceId) throw new Error("The job has no workspace");
    const name = workspaceName.parse(job.payload.name);
    const root = path.resolve(this.cfg.workspaceRoot);
    const dir = path.join(root, name);
    if (path.dirname(dir) !== root) throw new Error(`Refusing to create ${dir} outside ${root}`);
    await mkdir(root, { recursive: true });
    if (existsSync(dir) && (await readdir(dir)).length) throw new Error(`${dir} already exists and is not empty`);

    // Fail rather than wait for a password, passphrase or host key answer nobody can give.
    const gitEnv = { ...this.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: this.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
    try {
      if (job.payload.repoUrl) {
        const url = gitUrl.parse(job.payload.repoUrl);
        await this.sys.exec("git", ["clone", "--", url, dir], { env: gitEnv, timeoutMs: 15 * 60_000 }).catch((e) => {
          throw new Error(`git clone failed: ${errorText(e)}`);
        });
      } else {
        await mkdir(dir, { recursive: true });
        // Without git it is just a folder.
        await this.sys.exec("git", ["init", "-q"], { cwd: dir, env: gitEnv }).catch(() => undefined);
      }
      const grant = await this.api.createWorkspaceAgent(job.workspaceId);
      const agentConfig = path.join(this.paths.agents, `${job.workspaceId}.json`);
      await writePrivate(agentConfig, { url: this.cfg.url, token: grant.token });
      await this.wireClaude(dir, agentConfig);
      const reg = await this.registry();
      reg[job.workspaceId] = { name, path: dir, agentConfig, agentName: grant.agent.name };
      await this.saveRegistry(reg);
      this.log(`workspace ${name} at ${dir}, agent ${grant.agent.name}`);
    } catch (e) {
      // Only ever removes a folder this job created (it did not exist or was empty).
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    return { path: dir };
  }

  /** Points Claude Code in the workspace at its agent: Rev plugin on, its own REV_CONFIG, Rev tools allowed. */
  private async wireClaude(dir: string, agentConfig: string) {
    if ((await this.capabilities()).claude) {
      for (const args of [
        ["plugin", "marketplace", "add", "vibotaku/Rev"],
        ["plugin", "marketplace", "update", "vibotaku"],
        ["plugin", "install", "rev@vibotaku", "--scope", "local"],
      ]) {
        await this.sys.exec("claude", args, { cwd: dir, env: this.env, timeoutMs: 90_000 }).catch((e) => {
          const timedOut = (e as { killed?: boolean }).killed;
          this.log(`warning: claude ${args.join(" ")} ${timedOut ? "did not finish in 90 s." + STUCK_HINT : `failed: ${errorText(e)}`}`);
        });
      }
    }
    const file = path.join(dir, ".claude", "settings.local.json");
    type Settings = { enabledPlugins?: Record<string, boolean>; env?: Record<string, string>; permissions?: { allow?: string[] } };
    const settings = (await readJson<Settings>(file)) ?? {};
    settings.enabledPlugins = { ...settings.enabledPlugins, "rev@vibotaku": true };
    settings.env = { ...settings.env, REV_CONFIG: agentConfig };
    settings.permissions = { ...settings.permissions, allow: [...new Set([...(settings.permissions?.allow ?? []), "mcp__plugin_rev_rev"])] };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(settings, null, 2) + "\n");
    // Machine-specific: keep it out of commits.
    const exclude = path.join(dir, ".git", "info", "exclude");
    if (existsSync(path.join(dir, ".git"))) {
      const current = (await readFile(exclude, "utf8").catch(() => "")) || "";
      if (!current.split("\n").includes(".claude/settings.local.json")) {
        await mkdir(path.dirname(exclude), { recursive: true });
        await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.claude/settings.local.json\n`);
      }
    }
  }

  private async entry(workspaceId: string | null) {
    const e = workspaceId ? (await this.registry())[workspaceId] : undefined;
    if (!e) throw new Error("This node has no record of that workspace");
    return e;
  }

  /** Whether the session exists, and whether its program has exited (kept by remain-on-exit). */
  private async pane(session: string): Promise<{ alive: boolean; text: string } | null> {
    try {
      const dead = (await this.tmux(["display-message", "-p", "-t", session, "#{pane_dead}"])).stdout.trim();
      const text = (await this.tmux(["capture-pane", "-p", "-t", session])).stdout;
      return { alive: dead !== "1", text };
    } catch {
      return null;
    }
  }

  async startSession(job: NodeJob) {
    const e = await this.entry(job.workspaceId);
    const tools = await this.capabilities();
    if (!tools.tmux) throw new Error("tmux is not installed on this node");
    if (!tools.claude) throw new Error("Claude Code (claude) is not installed on this node");
    const session = sessionName(e.name);
    const existing = await this.pane(session);
    if (existing?.alive) return;
    if (existing) await this.tmux(["kill-session", "-t", session]);

    const command = ["claude", ...this.cfg.claudeArgs, START_PROMPT].map(shellQuote).join(" ");
    await this.tmux([
      "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", e.path, "-e", `REV_CONFIG=${e.agentConfig}`, command,
      ";", "set-option", "-t", session, "remain-on-exit", "on",
    ]);

    // Answer Claude Code's first-run dialogs for this folder, which the node created for it.
    let started = false;
    for (let i = 0; i < 60 && !started; i++) {
      await this.sys.sleep(1000);
      const pane = await this.pane(session);
      if (!pane || !pane.alive) {
        if (pane) await this.tmux(["kill-session", "-t", session]).catch(() => undefined);
        const lines = pane?.text.split("\n").filter((l) => l.trim()).slice(-8).join("\n");
        throw new Error(`Claude Code exited right after starting${lines ? `:\n${lines}` : ""}`);
      }
      const answer = STARTUP_ANSWERS.find((a) => pane.text.includes(a));
      if (answer) {
        const selected = pane.text.split("\n").find((l) => l.includes("❯"));
        await this.tmux(["send-keys", "-t", session, selected?.includes(answer) ? "Enter" : "Down"]);
        continue;
      }
      started = /Claude Code v\d/.test(pane.text);
    }
    if (!started) {
      await this.tmux(["kill-session", "-t", session]).catch(() => undefined);
      throw new Error(`Claude Code did not start within 60 s.${STUCK_HINT}`);
    }
    this.log(`session ${session} started in ${e.path}`);
  }

  async stopSession(job: NodeJob) {
    const reg = await this.registry();
    const known = job.workspaceId ? reg[job.workspaceId] : undefined;
    const name = known?.name ?? workspaceName.parse(job.payload.name);
    await this.tmux(["kill-session", "-t", sessionName(name)]).catch((e) => {
      if (!/can't find session|no server running|error connecting/i.test(errorText(e))) throw e;
    });
    if (!job.workspaceId) {
      // The workspace was removed in Rev: forget it here too, including its agent's token. Its folder stays.
      for (const [id, entry] of Object.entries(reg)) {
        if (entry.name !== name) continue;
        await rm(entry.agentConfig, { force: true });
        delete reg[id];
      }
      await this.saveRegistry(reg);
    }
  }

  /** Workspaces whose Claude Code session is running. */
  async runningSessions() {
    let out = "";
    try {
      out = (await this.tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}"])).stdout;
    } catch {
      return [];
    }
    const alive = new Set(
      out
        .split("\n")
        .map((l) => l.split("\t"))
        .filter(([, dead]) => dead === "0")
        .map(([name]) => name),
    );
    return Object.entries(await this.registry())
      .filter(([, e]) => alive.has(sessionName(e.name)))
      .map(([id]) => id);
  }

  /** Tells a running session about tasks newly assigned to its agent. */
  async nudge(running: string[]) {
    const reg = await this.registry();
    for (const id of running) {
      const e = reg[id];
      const creds = e && (await readJson<{ url: string; token: string }>(e.agentConfig));
      if (!e || !creds) continue;
      let open: { id: string; ref: string; title: string }[];
      try {
        open = await new RevApi(creds.url, creds.token).myTasks(["todo"]);
      } catch {
        continue;
      }
      const before = this.seen.get(id);
      this.seen.set(id, new Set(open.map((t) => t.id)));
      // The first look only records what the session already knows about.
      if (!before) continue;
      for (const t of open.filter((t) => !before.has(t.id))) {
        // Typed into the session as is, so no control characters (a Ctrl-C would interrupt it).
        const title = t.title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
        const text = `New Rev task assigned to you: ${t.ref} "${title}". Work on it with the rev:workflow skill.`;
        await this.tmux(["send-keys", "-t", sessionName(e.name), "-l", text]);
        await this.tmux(["send-keys", "-t", sessionName(e.name), "Enter"]);
        this.log(`told ${sessionName(e.name)} about ${t.ref}`);
      }
    }
    for (const id of [...this.seen.keys()]) if (!running.includes(id)) this.seen.delete(id);
  }

  async facts() {
    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      version: VERSION,
      workspaceRoot: path.resolve(this.cfg.workspaceRoot),
      capabilities: await this.capabilities(),
    };
  }

  async checkIn() {
    const sessions = await this.runningSessions();
    await this.api.reportState({ ...(await this.facts()), sessions });
    await this.nudge(sessions);
  }

  /** The service loop: check in every 30 s, and run jobs as they arrive. */
  async serve(signal?: AbortSignal) {
    this.log(`rev node ${VERSION}: ${this.cfg.name} serving ${this.cfg.url} (workspaces in ${this.cfg.workspaceRoot})`);
    let lastCheckIn = 0;
    let delay = 1000;
    while (!signal?.aborted) {
      try {
        if (Date.now() - lastCheckIn > 30_000) {
          await this.checkIn();
          lastCheckIn = Date.now();
        }
        const job = await this.api.nextJob(25);
        delay = 1000;
        if (job) {
          await this.handle(job);
          lastCheckIn = 0;
        }
      } catch (e) {
        const rejected = e instanceof RevApiError && e.status === 401;
        // macOS blocks background services from the local network until allowed.
        const blocked = process.platform === "darwin" && /EHOSTUNREACH/.test(errorText(e));
        this.log(
          rejected
            ? "Rev rejected this node's token (disabled or removed in Rev?); retrying in a minute"
            : `error: ${errorText(e)}${blocked ? " (macOS: allow node under System Settings → Privacy & Security → Local Network)" : ""}`,
        );
        await this.sys.sleep(rejected ? 60_000 : delay);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Background service: launchd on macOS, a systemd user service on Linux.

const LABEL = "com.vibotaku.rev-node";
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface ServiceInfo {
  kind: "launchd" | "systemd";
  file: string;
  logs: string;
}

/**
 * Installs (or reinstalls) the service that runs `rev node run`. The CLI copies itself to
 * ~/.local/share/rev/rev.mjs first, so the service does not depend on where it was run from.
 */
export async function installService(env: NodeJS.ProcessEnv, sys: Sys, scriptPath: string): Promise<ServiceInfo> {
  const { home } = nodePaths(env);
  const bin = path.join(home, ".local", "share", "rev", "rev.mjs");
  if (path.resolve(scriptPath) !== bin) {
    await mkdir(path.dirname(bin), { recursive: true });
    await copyFile(scriptPath, bin);
    await chmod(bin, 0o755);
  }
  const vars: Record<string, string> = { PATH: env.PATH ?? "/usr/bin:/bin", HOME: home };
  if (env.REV_NODE_CONFIG) vars.REV_NODE_CONFIG = env.REV_NODE_CONFIG;
  if (env.XDG_CONFIG_HOME) vars.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;

  if (process.platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const logs = path.join(home, "Library", "Logs", "rev-node.log");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(bin)}</string>
    <string>node</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(vars)
  .map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>WorkingDirectory</key><string>${xml(home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logs)}</string>
  <key>StandardErrorPath</key><string>${xml(logs)}</string>
</dict>
</plist>
`;
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.dirname(logs), { recursive: true });
    await writeFile(file, plist);
    const domain = `gui/${process.getuid!()}`;
    await sys.exec("launchctl", ["bootout", `${domain}/${LABEL}`]).catch(() => undefined);
    await sys.exec("launchctl", ["bootstrap", domain, file]);
    return { kind: "launchd", file, logs };
  }

  if (process.platform === "linux") {
    const file = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", "rev-node.service");
    const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const unit = `[Unit]
Description=Rev node (creates workspaces and runs agents for Rev)
After=network-online.target

[Service]
ExecStart=${quote(process.execPath)} ${quote(bin)} node run
${Object.entries(vars)
  .map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`)
  .join("\n")}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, unit);
    await sys.exec("systemctl", ["--user", "daemon-reload"]);
    await sys.exec("systemctl", ["--user", "enable", "rev-node.service"]);
    await sys.exec("systemctl", ["--user", "restart", "rev-node.service"]);
    return { kind: "systemd", file, logs: "journalctl --user -u rev-node -f" };
  }

  throw new Error(`Running rev node as a service is supported on macOS and Linux; on ${process.platform}, run \`rev node run\` yourself`);
}

export async function uninstallService(env: NodeJS.ProcessEnv, sys: Sys) {
  const { home } = nodePaths(env);
  if (process.platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    await sys.exec("launchctl", ["bootout", `gui/${process.getuid!()}/${LABEL}`]).catch(() => undefined);
    await rm(file, { force: true });
    return file;
  }
  if (process.platform === "linux") {
    const file = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", "rev-node.service");
    await sys.exec("systemctl", ["--user", "disable", "--now", "rev-node.service"]).catch(() => undefined);
    await rm(file, { force: true });
    await sys.exec("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    return file;
  }
  throw new Error(`No service to remove on ${process.platform}`);
}
