import { appendFile, chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RevConfig {
  url: string;
  token: string;
}

export function configPath(env: NodeJS.ProcessEnv = process.env) {
  if (env.REV_CONFIG) return env.REV_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "rev", "config.json");
}

/** Env vars (REV_URL / REV_TOKEN) win over the file written by `rev login`. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Partial<RevConfig>> {
  let file: Partial<RevConfig> = {};
  try {
    file = JSON.parse(await readFile(configPath(env), "utf8")) as Partial<RevConfig>;
  } catch {
    // No config yet.
  }
  return {
    url: env.REV_URL || file.url,
    token: env.REV_TOKEN || file.token,
  };
}

export async function saveConfig(config: RevConfig, env: NodeJS.ProcessEnv = process.env, file = configPath(env)) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

/** The agent credentials saved in a file (not REV_URL / REV_TOKEN), or null. Node tokens don't count. */
export async function savedCredentials(file: string): Promise<RevConfig | null> {
  try {
    const c = JSON.parse(await readFile(file, "utf8")) as Partial<RevConfig>;
    return typeof c.url === "string" && typeof c.token === "string" && !c.token.startsWith("rev_node_")
      ? { url: c.url, token: c.token }
      : null;
  } catch {
    return null;
  }
}

/** Where one more agent on this machine keeps its credentials: next to `beside`, named after the agent. */
export function agentConfigFile(beside: string, agentName: string) {
  return path.join(path.dirname(beside), `${agentName.replace(/[^\w.-]+/g, "_")}.json`);
}

/** Every agent credentials file directly in these folders. */
export async function findConfigs(dirs: string[]) {
  const found: { file: string; config: RevConfig }[] = [];
  for (const dir of new Set(dirs.map((d) => path.resolve(d)))) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      const file = path.join(dir, name);
      const config = await savedCredentials(file);
      if (config) found.push({ file, config });
    }
  }
  return found;
}

/**
 * Points Claude Code in `dir` at an agent: turns the Rev plugin on and sets REV_CONFIG in
 * .claude/settings.local.json. That file is machine-specific, so it is kept out of git.
 */
export async function linkClaude(dir: string, agentConfig: string, opts: { allowRevTools?: boolean } = {}) {
  const file = path.join(dir, ".claude", "settings.local.json");
  type Settings = { enabledPlugins?: Record<string, boolean>; env?: Record<string, string>; permissions?: { allow?: string[] } };
  let settings: Settings = {};
  try {
    settings = JSON.parse(await readFile(file, "utf8")) as Settings;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot update ${file}: ${(e as Error).message}`);
  }
  settings.enabledPlugins = { ...settings.enabledPlugins, "rev@vibotaku": true };
  settings.env = { ...settings.env, REV_CONFIG: agentConfig };
  if (opts.allowRevTools) {
    settings.permissions = { ...settings.permissions, allow: [...new Set([...(settings.permissions?.allow ?? []), "mcp__plugin_rev_rev"])] };
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n");
  const gitDir = await commonGitDir(dir);
  if (gitDir) {
    const exclude = path.join(gitDir, "info", "exclude");
    const current = (await readFile(exclude, "utf8").catch(() => "")) || "";
    if (!current.split("\n").includes(".claude/settings.local.json")) {
      await mkdir(path.dirname(exclude), { recursive: true });
      await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.claude/settings.local.json\n`);
    }
  }
  return file;
}

/** The repository's git folder holding info/exclude, also for worktrees (where .git is a file). */
async function commonGitDir(dir: string) {
  const dotGit = path.join(dir, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (!info) return null;
  if (info.isDirectory()) return dotGit;
  const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
  if (!pointer) return null;
  const gitDir = path.resolve(dir, pointer);
  const common = (await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
  return common ? path.resolve(gitDir, common) : gitDir;
}
