// Encryption for secrets stored in the database (e.g. the LDAP bind password).
// The key comes from REV_SECRET_KEY, or a key file created once in DATA_DIR.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PREFIX = "v1:";

export class Secrets {
  private constructor(private readonly key: Buffer) {}

  static async load(configuredKey: string | null, dataDir: string): Promise<Secrets> {
    if (configuredKey) return new Secrets(parseKey(configuredKey, "REV_SECRET_KEY"));
    const file = path.join(dataDir, "secret.key");
    if (!existsSync(file)) {
      await mkdir(dataDir, { recursive: true });
      await writeFile(file, randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" }).catch((err) => {
        if (err.code !== "EEXIST") throw err; // another process created it first
      });
    }
    return new Secrets(parseKey((await readFile(file, "utf8")).trim(), file));
  }

  encrypt(plain: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  decrypt(blob: string) {
    if (!blob.startsWith(PREFIX)) throw new Error("Unknown secret format");
    const raw = Buffer.from(blob.slice(PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}

function parseKey(value: string, source: string) {
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error(`${source} must be 32 bytes (base64 or hex)`);
  return key;
}
