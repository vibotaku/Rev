import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NodeInfo } from "@rev/shared";
import { Client, startTestServer, type TestServer } from "../../server/test/helpers";
import { NodeRunner, START_PROMPT, lockNode, nodePaths, realSys, type NodeConfig, type Sys } from "../src/node";
import { buildProgram } from "../src/program";

const TRUST = " Quick safety check: Is this a project you created or one you trust?\n";

/** Real git; tmux, claude and launchctl are simulated. A session first shows Claude Code's trust dialog. */
class FakeSys implements Sys {
  calls: string[][] = [];
  sessions = new Map<string, { dead: boolean; screen: string; cursor: number }>();
  /** Other processes on the machine: pid → command line plus environment, and working directory. */
  processes = new Map<number, { command: string; env: string; cwd: string }>();

  async exec(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) {
    this.calls.push([cmd, ...args, ...(opts?.cwd ? [`(in ${opts.cwd})`] : [])]);
    const out = (stdout: string) => ({ stdout, stderr: "" });
    const fail = (stderr: string) => Object.assign(new Error(stderr), { stderr });
    if (cmd === "git" && args[0] === "clone") {
      if (args.at(-2)!.includes("missing")) throw fail("fatal: repository not found");
      return realSys.exec("git", ["init", "-q", args.at(-1)!]);
    }
    if (cmd === "git") return realSys.exec(cmd, args, opts);
    if (cmd === "claude") return out(args[0] === "--version" ? "2.1.0 (Claude Code)\n" : "");
    if (cmd === "ps" && args[0] === "axww") return out([...this.processes].map(([pid, p]) => `  ${pid} ${p.command}`).join("\n") + "\n");
    if (cmd === "ps" && args[0] === "-wwE") {
      const p = this.processes.get(Number(args.at(-1)));
      return out(p ? `${p.command} ${p.env}\n` : "");
    }
    if (cmd === "lsof") {
      const p = this.processes.get(Number(args[args.indexOf("-p") + 1]));
      return out(p ? `p1\nfcwd\nn${p.cwd}\n` : "");
    }
    if (cmd !== "tmux") throw fail(`${cmd}: command not found`);

    const target = (flag = "-t") => this.sessions.get(args[args.indexOf(flag) + 1]!);
    switch (args[0]) {
      case "-V":
        return out("tmux 3.8\n");
      case "new-session":
        this.sessions.set(args[args.indexOf("-s") + 1]!, { dead: false, screen: "", cursor: 0 });
        return out("");
      case "display-message": {
        const s = target();
        if (!s) throw fail("can't find session");
        return out(s.dead ? "1\n" : "0\n");
      }
      case "capture-pane": {
        const s = target()!;
        if (s.screen) return out(s.screen);
        return out(`${TRUST}${s.cursor === 0 ? " ❯ No, exit\n   Yes, I trust this folder\n" : "   No, exit\n ❯ Yes, I trust this folder\n"}`);
      }
      case "send-keys": {
        const s = target()!;
        if (args.at(-1) === "Down") s.cursor = 1;
        else if (args.at(-1) === "Enter" && !s.screen && s.cursor === 1) s.screen = " ▐▛███▜▌   Claude Code v2.1.0\n❯ \n";
        return out("");
      }
      case "kill-session": {
        const name = args[args.indexOf("-t") + 1]!;
        if (!this.sessions.delete(name)) throw fail(`can't find session: ${name}`);
        return out("");
      }
      case "list-panes":
        if (!this.sessions.size) throw fail("no server running on /tmp/tmux-501/default");
        return out([...this.sessions].map(([name, s]) => `${name}\t${s.dead ? 1 : 0}`).join("\n") + "\n");
      default:
        return out("");
    }
  }

  async sleep() {}
}

let server: TestServer;
let baseUrl: string;
let owner: Client;
let home: string;
let env: NodeJS.ProcessEnv;
const sys = new FakeSys();
let runner: NodeRunner;
let cfg: NodeConfig;
let nodeId: string;

async function cli(args: string[]) {
  const out: string[] = [];
  const program = buildProgram({ out: (t) => out.push(t), err: (t) => out.push(t), env, sys });
  program.exitOverride();
  await program.parseAsync(args, { from: "user" });
  return out.join("\n");
}
const nodeInfo = async () => ((await owner.get("/api/nodes")).json as NodeInfo[])[0]!;
const runNext = async () => {
  const job = await runner.api.nextJob(0);
  expect(job).not.toBeNull();
  await runner.handle(job!);
  return job!;
};

beforeAll(async () => {
  server = await startTestServer();
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  owner = new Client(server.app);
  await owner.post("/api/setup", { token: "setup-secret", email: "owner@example.com", name: "Olivia", password: "correct horse battery" });
  await owner.post("/api/projects", { key: "WEB", name: "Website" });
  home = mkdtempSync(path.join(tmpdir(), "rev-node-home-"));
  env = { PATH: process.env.PATH, HOME: home };
});

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("rev node", () => {
  it("registers this computer as a node", async () => {
    const key = (await owner.post("/api/enrollment-keys", { name: "machines" })).json.key;
    const out = await cli(["node", "install", "--url", `${baseUrl}/`, "--key", key, "--name", "box", "--no-service"]);
    expect(out).toContain(`Registered box as a node on ${baseUrl}`);
    expect(out).toContain("Tools: git yes, tmux yes, claude yes");
    const file = path.join(home, ".config", "rev", "node.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    cfg = JSON.parse(readFileSync(file, "utf8")) as NodeConfig;
    expect(cfg).toMatchObject({ url: baseUrl, name: "box", workspaceRoot: path.join(home, "rev-workspaces"), claudeArgs: [] });
    nodeId = cfg.nodeId;
    // Installing again keeps the registration.
    expect(await cli(["node", "install", "--claude-args", "--permission-mode acceptEdits", "--no-service"])).toContain("box is already a node");
    cfg = JSON.parse(readFileSync(file, "utf8")) as NodeConfig;
    expect(cfg.claudeArgs).toEqual(["--permission-mode", "acceptEdits"]);
    runner = new NodeRunner(cfg, sys, env, () => undefined);
    await runner.checkIn();
    expect(await nodeInfo()).toMatchObject({ name: "box", online: true, capabilities: { tmux: "tmux 3.8", claude: "2.1.0 (Claude Code)" } });
  });

  it("creates a workspace wired to its own agent", async () => {
    await owner.post(`/api/nodes/${nodeId}/workspaces`, { name: "web", projectKey: "WEB", start: true });
    await runNext();
    const ws = (await nodeInfo()).workspaces[0]!;
    const dir = path.join(home, "rev-workspaces", "web");
    expect(ws).toMatchObject({ status: "ready", path: dir, agent: { name: "claude-box-web" } });
    expect(existsSync(path.join(dir, ".git"))).toBe(true);

    const agentConfig = path.join(home, ".config", "rev", "agents", `${ws.id}.json`);
    expect(statSync(agentConfig).mode & 0o777).toBe(0o600);
    const creds = JSON.parse(readFileSync(agentConfig, "utf8"));
    expect(creds.url).toBe(baseUrl);
    const agent = new Client(server.app, { token: creds.token });
    expect((await agent.get("/api/auth/me")).json.user.name).toBe("claude-box-web");

    const settings = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8"));
    expect(settings).toEqual({
      enabledPlugins: { "rev@vibotaku": true },
      env: { REV_CONFIG: agentConfig },
      permissions: { allow: ["mcp__plugin_rev_rev"] },
    });
    expect(readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")).toContain(".claude/settings.local.json\n");
    expect(sys.calls).toContainEqual(["claude", "plugin", "install", "rev@vibotaku", "--scope", "local", `(in ${dir})`]);
  });

  it("starts Claude Code in tmux, answering the trust dialog", async () => {
    await runNext();
    const ws = (await nodeInfo()).workspaces[0]!;
    expect(ws.session).toBe("running");
    const start = sys.calls.find((c) => c[0] === "tmux" && c[1] === "new-session")!;
    expect(start).toContain("rev-web");
    expect(start[start.indexOf("-c") + 1]).toBe(ws.path);
    expect(start).toContain(`REV_CONFIG=${path.join(home, ".config", "rev", "agents", `${ws.id}.json`)}`);
    expect(start).toContain(`claude --permission-mode acceptEdits '${START_PROMPT}'`);
    const keys = sys.calls.filter((c) => c[1] === "send-keys").map((c) => c.at(-1));
    expect(keys).toEqual(["Down", "Enter"]);
  });

  it("reports the Rev sessions running on the machine", async () => {
    const ws = (await nodeInfo()).workspaces[0]!;
    // Another Claude Code session, using its own agent config, in some repo.
    const other = (await owner.post("/api/agents", { name: "claude-desk" })).json;
    const token = (await owner.post(`/api/agents/${other.id}/tokens`, { name: "t" })).json.token as string;
    const otherConfig = path.join(home, "desk.json");
    writeFileSync(otherConfig, JSON.stringify({ url: `${baseUrl}/`, token }));
    sys.processes.set(4242, { command: "node /plugins/rev/cli/rev.mjs mcp", env: `HOME=${home} REV_CONFIG=${otherConfig}`, cwd: "/code/desk" });
    // The workspace's own session.
    const wsConfig = path.join(home, ".config", "rev", "agents", `${ws.id}.json`);
    sys.processes.set(4343, { command: "node /plugins/rev/cli/rev.mjs mcp", env: `REV_CONFIG=${wsConfig} HOME=${home}`, cwd: ws.path! });
    // Not a Rev MCP server, and a Rev session for some other Rev instance.
    sys.processes.set(4444, { command: "node server.js --rev mcp-ish", env: `HOME=${home}`, cwd: "/" });
    sys.processes.set(4545, { command: "rev mcp", env: `REV_URL=https://elsewhere.example REV_TOKEN=${token} HOME=${home}`, cwd: "/x" });
    runner.platform = "darwin";
    await runner.checkIn();
    expect((await nodeInfo()).agents.map((a) => [a.agent.name, a.cwd, a.workspaceId])).toEqual([
      ["claude-desk", "/code/desk", null],
      ["claude-box-web", ws.path, ws.id],
    ]);
    sys.processes.clear();
  });

  it("tells a running session about newly assigned tasks", async () => {
    await runner.checkIn();
    const ws = (await nodeInfo()).workspaces[0]!;
    await owner.post("/api/projects/WEB/tasks", { title: "Fix the \u0003 header", assigneeId: ws.agent!.id });
    await runner.checkIn();
    const typed = sys.calls.filter((c) => c[1] === "send-keys" && c.includes("-l")).map((c) => c.at(-1));
    expect(typed).toEqual(['New Rev task assigned to you: WEB-1 "Fix the header". Work on it with the rev:workflow skill.']);
    // Told once.
    await runner.checkIn();
    expect(sys.calls.filter((c) => c[1] === "send-keys" && c.includes("-l"))).toHaveLength(1);
  });

  it("stops sessions, and forgets workspaces removed in Rev", async () => {
    let ws = (await nodeInfo()).workspaces[0]!;
    await owner.post(`/api/workspaces/${ws.id}/stop`);
    await runNext();
    await runner.checkIn();
    ws = (await nodeInfo()).workspaces[0]!;
    expect(ws.session).toBe("stopped");
    expect(sys.sessions.size).toBe(0);

    await owner.del(`/api/workspaces/${ws.id}`);
    await runNext();
    expect(existsSync(path.join(home, ".config", "rev", "agents", `${ws.id}.json`))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(home, ".config", "rev", "node-workspaces.json"), "utf8"))).toEqual({});
    // The folder is left alone.
    expect(existsSync(ws.path!)).toBe(true);
  });

  it("lets only one process serve a node", async () => {
    const { lock } = nodePaths(env);
    // Another live process holds it (the test runner's parent stands in for the service).
    writeFileSync(lock, `${process.ppid}\n`);
    await expect(lockNode(env)).rejects.toThrow(`already being served by process ${process.ppid}`);
    // A lock left by a process that is gone is taken over, and released again.
    writeFileSync(lock, "999999\n");
    const unlock = await lockNode(env);
    expect(readFileSync(lock, "utf8").trim()).toBe(String(process.pid));
    await unlock();
    expect(existsSync(lock)).toBe(false);
  });

  it("reports failed clones and leaves nothing behind", async () => {
    await owner.post(`/api/nodes/${nodeId}/workspaces`, { name: "api", projectKey: "WEB", repoUrl: "https://example.com/missing.git" });
    await runNext();
    const ws = (await nodeInfo()).workspaces.find((w) => w.name === "api")!;
    expect(ws).toMatchObject({ status: "failed", error: "git clone failed: fatal: repository not found", agent: null });
    expect(existsSync(path.join(home, "rev-workspaces", "api"))).toBe(false);

    await owner.post(`/api/nodes/${nodeId}/workspaces`, { name: "web2", projectKey: "WEB", repoUrl: "https://example.com/web.git" });
    await runNext();
    expect((await nodeInfo()).workspaces.find((w) => w.name === "web2")!.status).toBe("ready");

    // The removed workspace's folder is still there: a new "web" is refused, and the folder kept.
    await owner.post(`/api/nodes/${nodeId}/workspaces`, { name: "web", projectKey: "WEB" });
    await runNext();
    expect((await nodeInfo()).workspaces.find((w) => w.name === "web")!.error).toMatch(/web already exists and is not empty$/);
    expect(existsSync(path.join(home, "rev-workspaces", "web", ".git"))).toBe(true);
  });
});
