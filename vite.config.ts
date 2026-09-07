import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
// @ts-expect-error Runtime build helper is deliberately shared with the launcher.
import { releaseIdentity } from "./scripts/ui-release.mjs";
const identity = await releaseIdentity();
const binding = JSON.parse(readFileSync(new URL("./harness-ui.json", import.meta.url), "utf8"));

export default defineConfig({
  define: { __OCW_UI__: JSON.stringify(identity) },
  plugins: [react(), { name: "ocw-release", writeBundle(options, bundle) {
    writeFileSync(`${options.dir}/source-project`, fileURLToPath(new URL(".", import.meta.url)));
    const index = readFileSync(`${options.dir}/index.html`);
    const assets = Object.fromEntries(Object.keys(bundle).filter(name => name.startsWith('assets/')).map(name => [name, createHash('sha256').update(readFileSync(`${options.dir}/${name}`)).digest('hex')]));
    writeFileSync(`${options.dir}/ui-build.json`, JSON.stringify({...identity, assets, indexDigest: createHash("sha256").update(index).digest("hex")}));
  } }],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: process.env.OCW_BUILD_DIR || fileURLToPath(new URL(binding.frontend_dir || "dist", import.meta.url)),
    emptyOutDir: true,
  },
});
