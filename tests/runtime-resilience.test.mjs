import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { registerHarness, listRegistrations } from '../scripts/harness-registry.mjs';
import { writeFixtureWorkflow } from './e2e-fixture.mjs';
import { SourceCache } from '../scripts/source-cache.mjs';
import { SnapshotStore } from '../scripts/snapshot-store.mjs';
import { managedSource, restoredArtifact } from '../scripts/managed-source.mjs';
import { attachSseWriter } from '../scripts/sse-writer.mjs';
const app = resolve(import.meta.dirname, '..');
const run = promisify(execFile);
const pause = ms => new Promise(r => setTimeout(r, ms));
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const write = (path, value) => writeFile(path, JSON.stringify(value) + '\n');
const cli = async (...args) => JSON.parse((await run('python3', [join(app, 'scripts/harness_registry.py'), ...args])).stdout);

async function world(context) {
  const root = await mkdtemp(join(tmpdir(), 'ocw-resilience-'));
  const registryDir = join(root, 'registry');
  const alpha = await writeFixtureWorkflow(join(root, 'alpha'), { taskId: 'TASK-RESILIENT-A', prefix: 'RHO' });
  const beta = await writeFixtureWorkflow(join(root, 'beta'), { taskId: 'TASK-RESILIENT-B', prefix: 'SIGMA', working: false, phase: 'failed' });
  const first = await registerHarness({ source: alpha.root, sessionId: 'one', processId: process.pid, registryDir });
  const second = await registerHarness({ source: alpha.root, sessionId: 'two', processId: process.pid, registryDir });
  const other = await registerHarness({ source: beta.root, sessionId: 'one', registryDir });
  let child;
  let logs = '';
  const net = createServer().listen(0, '127.0.0.1'); await once(net, 'listening');
  const port = net.address().port; await new Promise(r => net.close(r));
  const base = `http://127.0.0.1:${port}`;
  const get = async path => { const r = await fetch(base + path, { signal: AbortSignal.timeout(6000) }); return { status: r.status, body: await r.json() }; };
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: app, env: { ...process.env, PORT: String(port), OCW_HARNESS_REGISTRY_DIR: registryDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
    for (let i = 0; i < 80; i++) { try { if ((await get('/api/health')).status === 200) return; } catch {} await pause(100); }
    throw new Error(logs);
  }
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null) return;
    const done = once(child, 'exit'); child.kill(signal);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
    await done; clearTimeout(timeout);
  }
  context.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  await start();
  return { root, registryDir, alpha, beta, first, second, other, get, base, start, stop, snapshot: id => get(`/api/snapshot?harness=${id}`) };
}

async function eventually(fn, description) {
  let last;
  for (let i = 0; i < 40; i++) { try { last = await fn(); if (last) return; } catch (e) { last = e; } await pause(150); }
  assert.fail(`${description}: ${last}`);
}

test('shared task counts one worker and failed phase stays failed', async context => {
  const w = await world(context);
  const { body } = await w.get('/api/registry');
  assert.equal(body.counts.workingAgents, 1);
  assert.equal(body.counts.sessions, 3);
  assert.equal(body.registrations.find(r => r.registrationId === w.other.registrationId).presence, 'failed');
  assert.equal(body.registrations.find(r => r.registrationId === w.first.registrationId).ownership, 'task_shared');
});

test('dead PID and missing liveness never confirm active assignments', async context => {
  const w = await world(context);
  const path = join(w.registryDir, w.first.registrationId + '.json');
  const r = await read(path); r.processId = 2147483647; await write(path, r);
  const snap = (await w.snapshot(r.registrationId)).body;
  assert.equal(snap.runtime.liveness, 'lost');
  assert.equal(snap.agentActivity.workingCount, 0);
  assert.equal(snap.agentActivity.unverifiedAssignmentCount, 1);
  r.processId = null; r.processStartedAt = null; await write(path, r);
  assert.equal((await w.snapshot(r.registrationId)).body.runtime.liveness, 'unknown');
});

test('Python and Node registrations converge and old lifecycle writes are fenced', async context => {
  const w = await world(context);
  const repeated = await cli('register', '--source', w.alpha.root, '--session', 'one', '--registry', w.registryDir);
  assert.equal(repeated.registrationId, w.first.registrationId);
  assert.equal((await listRegistrations(w.registryDir)).registrations.length, 3);
  const common = ['--registry', w.registryDir, '--id', repeated.registrationId, '--instance', repeated.instanceId];
  await cli('heartbeat', ...common, '--seq', '1');
  await assert.rejects(cli('heartbeat', ...common, '--seq', '1'), /strictly increase/);
  await Promise.allSettled([cli('heartbeat', ...common, '--seq', '2'), cli('close', ...common)]);
  assert.equal((await read(join(w.registryDir, repeated.registrationId + '.json'))).lifecycle, 'closed');
  await assert.rejects(cli('heartbeat', ...common, '--seq', '3'), /closed instance/);
  await assert.rejects(registerHarness({ source: w.alpha.root, sessionId: 'one', registryDir: w.registryDir }), /new-instance/);
  const next = await registerHarness({ source: w.alpha.root, sessionId: 'one', registryDir: w.registryDir, newInstance: true });
  assert.notEqual(next.instanceId, repeated.instanceId);
  await assert.rejects(cli('close', ...common), /stale instance/);
  await assert.rejects(registerHarness({ source: w.beta.root, sessionId: 'one', registryDir: w.registryDir, registrationId: repeated.registrationId }), /identity conflict/);
});

test('live attachment is fresh on cached snapshots', async context => {
  const w = await world(context);
  assert.equal((await w.snapshot(w.first.registrationId)).body.runtime.connectedClients, 0);
  const controller = new AbortController(); context.after(() => controller.abort());
  const response = await fetch(w.base + `/api/stream?harness=${w.first.registrationId}`, { signal: controller.signal });
  const reader = response.body.getReader(); await reader.read();
  assert.equal((await w.snapshot(w.first.registrationId)).body.runtime.connectedClients, 1);
  controller.abort();
});

test('referenced file changes invalidate shared facts, idle polls do not rebuild', async context => {
  const w = await world(context);
  await w.snapshot(w.first.registrationId);
  await pause(250);
  const path = join(w.alpha.root, `accepted/${w.alpha.edgeA}.rev2.json`);
  const accepted = await read(path); accepted.accepted_attempts[0].mechanism_class = 'CHANGED-REFERENCE'; await write(path, accepted);
  await eventually(async () => JSON.stringify((await w.snapshot(w.first.registrationId)).body).includes('CHANGED-REFERENCE'), 'ref change is visible');
  // The changed content can be read during an earlier invalidation (e.g. a
  // missing optional label's initial watch notification). Drain subsequent
  // file-watch invalidations before measuring genuinely idle polling.
  let previous = -1, stable = 0;
  await eventually(async () => {
    await w.get('/api/registry');
    const builds = (await w.get('/api/diagnostics')).body.snapshotBuilds;
    stable = builds === previous ? stable + 1 : 0;
    previous = builds;
    await pause(500);
    return stable >= 2;
  }, 'source caches settle after the reference change');
  const before = (await w.get('/api/diagnostics')).body.snapshotBuilds;
  await Promise.all(Array.from({ length: 10 }, () => w.snapshot(w.second.registrationId)));
  assert.equal((await w.get('/api/diagnostics')).body.snapshotBuilds, before);
});

test('partial commit retains last verified revision then recovers; task replacement never leaks', async context => {
  const w = await world(context);
  const initial = (await w.snapshot(w.first.registrationId)).body;
  assert.equal(initial.task.revision, 2);
  const statePath = join(w.alpha.root, 'state.json'); const state = await read(statePath);
  state.revision = 3; await write(statePath, state);
  await eventually(async () => (await w.snapshot(w.first.registrationId)).body.sourceStatus === 'degraded', 'torn update degraded');
  const stale = (await w.snapshot(w.first.registrationId)).body;
  assert.equal(stale.task.revision, 2); assert.equal(stale.verifiedAt, initial.verifiedAt);
  const eventsPath = join(w.alpha.root, 'events.jsonl');
  await writeFile(eventsPath, await readFile(eventsPath, 'utf8') + JSON.stringify({ event_id: 'EV-3', from_revision: 2, to_revision: 3, from_phase: state.phase, to_phase: state.phase }) + '\n');
  await eventually(async () => (await w.snapshot(w.first.registrationId)).body.task.revision === 3, 'complete commit recovered');
  state.task_id = 'UNRELATED-REPLACEMENT'; await write(statePath, state);
  await eventually(async () => (await w.snapshot(w.first.registrationId)).body.sourceStatus === 'degraded', 'identity conflict degraded');
  assert.equal((await w.snapshot(w.first.registrationId)).body.task.id, w.alpha.taskId);
});

test('server crash preserves registrations and creates a new binding on restart', async context => {
  const w = await world(context);
  const before = (await w.get('/api/health')).body.binding;
  await w.stop('SIGKILL'); await w.start();
  const after = (await w.get('/api/health')).body.binding;
  assert.notEqual(before.bindingId, after.bindingId);
  assert.equal(after.registryCount, 3);
  assert.equal((await w.snapshot(w.first.registrationId)).body.task.id, w.alpha.taskId);
});

test('bounded source work isolates a hung job without starting duplicate work', async () => {
  const cache = new SourceCache({ concurrency: 2, timeoutMs: 30 });
  let calls = 0, unblock;
  const hung = () => { calls++; return new Promise(r => unblock = r); };
  const slow = cache.read('slow', 1, hung);
  assert.equal((await cache.read('fast', 1, async () => 42)).value, 42);
  await assert.rejects(slow, /超时/);
  await assert.rejects(cache.read('slow', 1, hung), /超时/);
  assert.equal(calls, 1); assert.equal(cache.active, 1);
  unblock(10); await pause(1);
  assert.equal((await cache.read('slow', 1, hung)).value, 10);
});

test('SSE coalesces blocked writes and destroys a persistently slow consumer', async () => {
  const response = new EventEmitter(); const frames = [];
  response.write = frame => { frames.push(frame); return false; };
  response.destroy = () => { response.destroyed = true; response.emit('close'); };
  const send = attachSseWriter(response, { stallMs: 20 });
  send('first'); send('second'); send('latest');
  assert.deepEqual(frames, ['first']);
  response.emit('drain'); assert.deepEqual(frames, ['first', 'latest']);
  await pause(30); assert.equal(response.destroyed, true);
});

test('frame gate rejects older revisions and retired bindings, accepts a valid restart', async () => {
  const source = await readFile(join(app, 'src/sync-state.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {}; vm.runInNewContext(code, { exports });
  const gate = new exports.FrameGate();
  const frame = { registrationId: 'A', taskId: 'TASK-A', bindingId: 'one', startedAt: '2026-09-06T00:00:00Z', revision: 11 };
  assert.equal(gate.accept(frame), true);
  assert.equal(gate.accept({ ...frame, revision: 10 }), false);
  const observations = new exports.FrameGate();
  assert.equal(observations.accept({...frame,sourceObservationSeq:4,observationSeq:20}),true);
  assert.equal(observations.accept({...frame,sourceObservationSeq:3,observationSeq:21}),false);
  assert.equal(observations.accept({...frame,sourceObservationSeq:4,observationSeq:19}),false);
  assert.equal(observations.accept({...frame,sourceObservationSeq:5,observationSeq:22}),true);
  const restored = new exports.FrameGate();
  assert.equal(restored.accept(frame), true);
  assert.equal(restored.accept({ ...frame, dataEpoch: 1, revision: 2 }), true);
  assert.equal(restored.accept({ ...frame, dataEpoch: 0, revision: 100 }), false);
  assert.equal(restored.accept({ ...frame, dataEpoch: 1, revision: 1 }), false);
  assert.equal(restored.accept({ ...frame, dataEpoch: 1.5, revision: 12 }), false);
  assert.equal(gate.accept({ ...frame, taskId: 'TASK-B' }), false);
  assert.equal(gate.accept({ ...frame, bindingId: 'two', startedAt: '2026-09-06T00:00:01Z' }), true);
  assert.equal(gate.accept(frame), false);
  assert.equal(gate.accept({ ...frame, bindingId: 'three', startedAt: '2026-09-06T00:00:02Z', revision: 5 }), false);
});

test('supervisor restarts only its own adapter after a crash', async context => {
  const w = await world(context);
  await w.stop();
  const port = new URL(w.base).port;
  const supervisor = spawn(process.execPath, ['scripts/supervise-console.mjs'], { cwd: app, env: { ...process.env, PORT: port, OCW_HARNESS_REGISTRY_DIR: w.registryDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const pids = []; let output = '';
  supervisor.stdout.on('data', buffer => {
    output += buffer;
    for (const line of output.split('\n').slice(0, -1)) {
      try { const event = JSON.parse(line); if (event.event === 'adapter-start' && !pids.includes(event.pid)) pids.push(event.pid); } catch {}
    }
  });
  supervisor.stderr.resume();
  context.after(async () => {
    const done = once(supervisor, 'exit'); supervisor.kill('SIGTERM');
    const timeout = setTimeout(() => supervisor.kill('SIGKILL'), 3000); await done; clearTimeout(timeout);
  });
  await eventually(async () => pids.length === 1 && (await w.get('/api/health')).status === 200, 'supervised initial health');
  const before = (await w.get('/api/health')).body.binding.bindingId;
  process.kill(pids[0], 'SIGKILL');
  await eventually(async () => pids.length === 2 && (await w.get('/api/health')).body.binding.bindingId !== before, 'automatic adapter restart');
  assert.equal((await w.get('/api/registry')).body.counts.registrations, 3);
});

test('100 registrations and 10 concurrent directory readers share source builds', async context => {
  const w = await world(context);
  // Monitor-load fixtures: valid per-session metadata, two canonical sources.
  for (let i = 0; i < 97; i++) {
    const item = { ...w.first, registrationId: `harness-load-${i}`, sessionId: `load-${i}` };
    await write(join(w.registryDir, item.registrationId + '.json'), item);
  }
  await eventually(async () => (await w.get('/api/registry')).body.counts.registrations === 100, 'directory sees 100 registrations');
  await pause(1000);
  const before = (await w.get('/api/diagnostics')).body.snapshotBuilds;
  const times = [];
  const results = await Promise.all(Array.from({ length: 10 }, async () => {
    const start = performance.now(); const value = await w.get('/api/registry'); times.push(performance.now() - start); return value;
  }));
  assert.ok(results.every(r => r.status === 200 && r.body.counts.registrations === 100 && r.body.counts.workingAgents === 1));
  assert.equal((await w.get('/api/diagnostics')).body.snapshotBuilds, before);
  times.sort((a, b) => a - b);
  context.diagnostic(`100 registrations / 10 simultaneous HTTP readers: p50=${times[4].toFixed(1)}ms, max=${times.at(-1).toFixed(1)}ms, additional source builds=0`);
});

test('persisted verified snapshot survives adapter crash and a corrupt source', async context => {
  const w = await world(context);
  const before = (await w.snapshot(w.first.registrationId)).body;
  await w.stop('SIGKILL');
  await writeFile(join(w.alpha.root, 'state.json'), '{broken');
  await w.start();
  const after = await w.snapshot(w.first.registrationId);
  assert.equal(after.status, 200);
  assert.equal(after.body.sourceStatus, 'degraded');
  assert.equal(after.body.task.revision, before.task.revision);
  assert.equal(after.body.verifiedAt, before.verifiedAt);
  assert.equal(after.body.agentActivity.workingCount, 0);
  assert.notEqual(after.body.runtime.bindingId, before.runtime.bindingId);
});

test('observer store rejects corruption and canonical rollback without a data epoch', async context => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-cache-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SnapshotStore(root);
  const cache = new SourceCache({ store });
  const data = (revision, dataEpoch = 0) => ({ task: { id: 'T', revision }, runtime: { dataEpoch } });
  await cache.read('T', 1, async () => data(5));
  const fresh = new SourceCache({ store });
  const refused = await fresh.read('T', 2, async () => data(2));
  assert.equal(refused.value.task.revision, 5);
  assert.match(refused.error, /dataEpoch/);
  const restored = await fresh.read('T', 3, async () => data(2, 1));
  assert.equal(restored.value.task.revision, 2); assert.equal(restored.error, undefined);
  const disk = JSON.parse(await readFile(store.path('T'), 'utf8'));
  disk.payload = disk.payload.replace('"revision":2', '"revision":999');
  await write(store.path('T'), disk);
  assert.equal(await store.load('T'), null);
});

test('restored external evidence follows exact backup mappings only', () => {
  const mapping = { '/old/source': '/restored/source', '/old/product.md': '/restored/product/product.md' };
  assert.equal(restoredArtifact('/old/product.md', mapping), '/restored/product/product.md');
  assert.equal(restoredArtifact('/old/source/file.md', mapping), '/restored/source/file.md');
  assert.equal(restoredArtifact('/old/source-other/file.md', mapping), '/old/source-other/file.md');
});

test('actual executor generations bind, advance and reject changed evidence', async context => {
  const w = await world(context);
  const root = join(w.root, 'executor');
  const planPath = join(w.root, 'plan.json');
  await write(planPath, { task_id: 'TASK-ACTUAL-EXECUTOR', delivery_dir: join(w.root, 'delivery'), checkpoints: [
    { id: 'VERIFY-X', execution: 'replay_safe', cwd: app, argv: [process.execPath, '-e', 'process.stdout.write("actual execution")'] },
  ] });
  await run('python3', ['scripts/ocw_runtime.py', 'init', '--root', root, '--plan', planPath], { cwd: app });
  const reg = await registerHarness({ source: root, sessionId: 'runtime', registryDir: w.registryDir, processId: process.pid });
  const before = (await w.snapshot(reg.registrationId)).body;
  assert.equal(before.execution.engine, 'ocw-local-executor-2');
  assert.equal(before.sourceRoot, reg.sourceRoot);
  assert.equal(before.runtime.dataEpoch, 1);
  await run('python3', ['scripts/ocw_runtime.py', 'run', '--root', root], { cwd: app });
  await eventually(async () => (await w.snapshot(reg.registrationId)).body.execution.accepted === 1, 'real completion projects');
  const after = (await w.snapshot(reg.registrationId)).body;
  assert.equal(after.task.phase, 'completed');
  assert.equal(after.metrics.checkpointsComplete, 1);
  assert.equal(after.integrity.chainHealthy, true);
  const generation = (await managedSource(root)).root;
  await writeFile(join(generation, 'accepted/VERIFY-X.json'), '{"tampered":true}');
  await eventually(async () => (await w.snapshot(reg.registrationId)).body.sourceStatus === 'degraded', 'manifest digest corruption rejected');
  await assert.rejects(registerHarness({ source: root, sessionId: 'new', registryDir: w.registryDir }), /digest mismatch/);
});

test('persistent supervisor breaker survives a restart without spawning an adapter', async context => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-breaker-'));
  const state = join(root, 'circuit.json');
  await write(state, { crashes: [Date.now()], tripped: true });
  const child = spawn(process.execPath, ['scripts/supervise-console.mjs'], { cwd: app, env: { ...process.env, OCW_SUPERVISOR_STATE: state }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
  context.after(async () => { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; await rm(root, { recursive: true, force: true }); });
  await eventually(() => errors.includes('circuit open'), 'restored breaker holds');
  assert.equal(output.includes('adapter-start'), false);
  assert.equal(child.exitCode, null);
});
