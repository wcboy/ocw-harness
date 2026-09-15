// A CLI must behave the same however the caller spelled the path to it.
//
// The previous main-module guard compared `path.resolve(process.argv[1])` with
// `import.meta.url`. `resolve` does not follow symlinks and `import.meta.url` is
// always the real path, so invoking a CLI through a symlinked path made the
// guard false: the command exited 0, printed nothing, and did nothing. Silent
// success is the worst available failure, and nothing tested for it because the
// repo is normally invoked by its real path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const app = resolve(import.meta.dirname, '..');

/** A directory whose path contains a real symlink component. */
async function symlinkedApp(context) {
  const base = await mkdtemp(join(tmpdir(), 'ocw-entrypoint-'));
  const link = join(base, 'linked-app');
  await symlink(app, link);
  context.after(() => rm(base, { recursive: true, force: true }));
  return link;
}

test('a CLI invoked through a symlinked path still runs', async context => {
  const link = await symlinkedApp(context);

  // ui-release prints its identity JSON; through the old guard this printed
  // nothing at all while still exiting 0.
  const { stdout } = await run(process.execPath, [join(link, 'scripts/ui-release.mjs')], { cwd: app });
  assert.ok(stdout.trim(), 'the CLI produced no output through a symlinked path');
  const identity = JSON.parse(stdout);
  assert.ok(identity.designVersion, `expected a release identity, got ${stdout}`);

  // The same file by its real path must give the same answer.
  const direct = JSON.parse((await run(process.execPath, [join(app, 'scripts/ui-release.mjs')], { cwd: app })).stdout);
  assert.deepEqual(identity, direct, 'the two spellings disagree about the same file');
});

test('the registry CLI reports a real error through a symlinked path', async context => {
  const link = await symlinkedApp(context);
  const registryDir = await mkdtemp(join(tmpdir(), 'ocw-entrypoint-registry-'));
  context.after(() => rm(registryDir, { recursive: true, force: true }));

  // Registering a source that does not exist must fail loudly. Through the old
  // guard this exited 0 with empty output, which reads as success.
  const failed = await run(process.execPath, [
    join(link, 'scripts/harness-registry.mjs'), 'register',
    '--source', join(registryDir, 'nope'), '--session', 'entrypoint',
  ], { cwd: app, env: { ...process.env, OCW_HARNESS_REGISTRY_DIR: registryDir } }).catch(error => error);

  assert.ok(failed instanceof Error, 'registering a missing source through a symlink silently succeeded');
  assert.ok((failed.stderr || '').trim(), 'the failure produced no diagnostic on stderr');
});

test('importing a module does not trigger its CLI', async () => {
  // The guard exists so that importing these modules is side-effect free: every
  // other test in the suite imports them and must not get stray CLI output.
  const { isEntrypoint } = await import('../scripts/entrypoint.mjs');
  assert.equal(isEntrypoint(new URL('../scripts/ui-release.mjs', import.meta.url).href), false);
  assert.equal(isEntrypoint(new URL('../scripts/harness-registry.mjs', import.meta.url).href), false);

  // It is true for whatever node was actually asked to run, which under the
  // test runner is this file -- reached through a symlinked tmpdir or not.
  assert.equal(isEntrypoint(import.meta.url), true);
});
