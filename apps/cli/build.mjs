// Bundles the CLI and all of its dependencies into one executable file: dist/rev.mjs.
// The server serves it at /downloads/rev.mjs so agent machines only need Node.
import { chmod, copyFile } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "dist/rev.mjs";
await build({
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: false,
  legalComments: "none",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
await chmod(outfile, 0o755);
console.log(`built ${outfile}`);

// The Claude Code plugin ships the same bundle (plugins are copied on install,
// so it must live inside the plugin directory). CI checks this copy is current.
const pluginCopy = new URL("../../plugins/rev/cli/rev.mjs", import.meta.url);
await copyFile(outfile, pluginCopy);
console.log("copied to plugins/rev/cli/rev.mjs");
