import type { Config } from "./config";
import type { Db } from "./db";
import type { Directory } from "./lib/directory";
import type { MediaProcessor } from "./media/processor";
import type { Storage } from "./media/storage";

export interface AppContext {
  config: Config;
  db: Db;
  storage: Storage;
  processor: MediaProcessor;
  /** Active Directory sign-in, when configured. */
  directory: Directory | null;
  /** One-time token required to create the first admin; null once any user exists. */
  setup: { token: string | null };
}
