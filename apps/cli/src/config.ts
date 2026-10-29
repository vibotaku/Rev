import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
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

export async function saveConfig(config: RevConfig, env: NodeJS.ProcessEnv = process.env) {
  const file = configPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
