#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const log = process.argv[2];
if (!log) throw new Error('A supervisor log path is required');
const output = openSync(log, 'a', 0o600);
const child = spawn(process.execPath, [fileURLToPath(new URL('./supervise-console.mjs', import.meta.url))], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), env: process.env,
  detached: true, stdio: ['ignore', output, output],
});
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.once('spawn', () => { process.stdout.write(String(child.pid) + '\n'); child.unref(); });
closeSync(output);
