import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { randomToken } from "../lib/crypto";

/** Local-disk object storage rooted at DATA_DIR/media. Keys are relative POSIX paths. */
export class Storage {
  readonly root: string;
  private readonly tmp: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "media");
    this.tmp = path.join(dataDir, "tmp");
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.tmp, { recursive: true });
  }

  pathOf(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  }

  tempPath(ext = "") {
    return path.join(this.tmp, `${Date.now()}-${randomToken(8)}${ext}`);
  }

  async writeStream(key: string, stream: Readable) {
    const tmp = this.tempPath();
    try {
      await pipeline(stream, createWriteStream(tmp));
      await this.moveIn(tmp, key);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async moveIn(tmpPath: string, key: string) {
    const dest = this.pathOf(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(tmpPath, dest);
  }

  async size(key: string) {
    return (await stat(this.pathOf(key))).size;
  }

  read(key: string) {
    return createReadStream(this.pathOf(key));
  }

  async removePrefix(prefix: string) {
    await rm(this.pathOf(prefix), { recursive: true, force: true });
  }
}
