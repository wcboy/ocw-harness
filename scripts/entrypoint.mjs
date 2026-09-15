import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether this module is the script node was asked to run.
 *
 * The obvious spelling, comparing `path.resolve(process.argv[1])` against
 * `import.meta.url`, is wrong in a way that fails silently: `resolve` normalizes
 * a path but does not follow symlinks, while `import.meta.url` is always the real
 * path. Invoke a CLI through any symlinked path -- anything under `/tmp` on
 * macOS, a symlinked checkout, a linked install prefix -- and the comparison
 * fails, so the CLI block never runs and the command exits 0 having printed
 * nothing and done nothing.
 *
 * Comparing real paths is what makes "was I run directly" mean the same thing
 * however the caller spelled the path.
 */
export function isEntrypoint(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(moduleUrl);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    // A deleted or unreadable argv[1] cannot be this module; fall back to the
    // textual comparison rather than throwing out of a module's top level.
    return resolve(entry) === self;
  }
}
