#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const app = fileURLToPath(new URL('..', import.meta.url));
let child, builder, timer, stopping = false;
const statePath = process.env.OCW_SUPERVISOR_STATE;
let saved = { crashes: [], tripped: false };
if (statePath) {
  try { saved = JSON.parse(readFileSync(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') { process.stderr.write('Supervisor state unreadable; stopping.\n'); process.exit(1); } }
}
const crashes = saved.crashes;
function persist(tripped = false) {
  if (!statePath) return;
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ crashes, tripped, at: new Date().toISOString() }), { mode: 0o600, flush: true });
  renameSync(temporary, statePath);
}
function hold() {
  process.stderr.write('Adapter circuit open. Inspect logs and use manage-service.py reset.\n');
  timer = setInterval(() => {}, 60000);
}
async function start() {
  if (stopping) return;
  builder = spawn(process.execPath, ['scripts/ensure-ui.mjs'], {cwd:app,env:process.env,stdio:'inherit',detached:true});
  const built = await new Promise(resolve => {builder.once('error',()=>resolve(false));builder.once('exit',code=>resolve(code===0));});
  if (stopping) return;
  if (!built) {persist(true); if (statePath) {hold(); return;} process.exit(1);}
  child = spawn(process.execPath, ['server.mjs'], { cwd: app, env: process.env, stdio: 'inherit' });
  process.stdout.write(JSON.stringify({ event: 'adapter-start', pid: child.pid, at: new Date().toISOString() }) + '\n');
  child.on('error', error => { process.stderr.write(error.message + '\n'); });
  child.on('exit', (code, signal) => {
    if (stopping) { process.exit(0); return; }
    const now = Date.now();
    while (crashes.length && now - crashes[0] > 60000) crashes.shift();
    crashes.push(now);
    persist(crashes.length >= 5);
    process.stderr.write(JSON.stringify({ event: 'adapter-exit', code, signal, recentCrashes: crashes.length }) + '\n');
    if (crashes.length >= 5) {
      process.stderr.write('Adapter 连续失败，停止自动重启；请检查端口、注册目录和日志。\n');
      if (statePath) { hold(); return; }
      process.exit(1);
    }
    timer = setTimeout(start, Math.min(5000, 300 * 2 ** (crashes.length - 1)));
  });
}
function stop() {
  stopping = true; clearTimeout(timer); clearInterval(timer);
  if (builder && builder.exitCode === null) { try {process.kill(-builder.pid,'SIGTERM');} catch {} }
  if (!child || child.exitCode !== null) { process.exit(0); return; }
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 2000).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
if (saved.tripped) hold(); else start();
