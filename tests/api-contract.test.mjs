// Checks a live adapter against docs/openapi.json.
//
// The wire format is produced in server.mjs and hand-mirrored in src/types.ts
// and docs/. Nothing generates one from another, so the only thing that keeps
// them honest is a test that reads the real responses. This asserts both
// directions: a field the document declares must exist, and a field the server
// returns must be declared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerHarness } from '../scripts/harness-registry.mjs';
import { writeFixtureWorkflow } from './e2e-fixture.mjs';

const app = resolve(import.meta.dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const spec = JSON.parse(await readFile(join(app, 'docs/openapi.json'), 'utf8'));

function schemaFor(path, status) {
  const media = spec.paths[path].get.responses[status].content['application/json'].schema;
  const name = media.$ref?.split('/').at(-1);
  return name ? spec.components.schemas[name] : media;
}

/** Compare one object's own keys against what the document declares. */
function assertKeys(label, body, schema) {
  const declared = new Set(schema.required || Object.keys(schema.properties || {}));
  const actual = new Set(Object.keys(body));
  const missing = [...declared].filter(key => !actual.has(key)).sort();
  const undeclared = [...actual].filter(key => !declared.has(key)).sort();
  assert.deepEqual(missing, [], `${label}: docs/openapi.json declares keys the server did not return: ${missing}`);
  assert.deepEqual(undeclared, [], `${label}: server returned keys docs/openapi.json does not declare: ${undeclared}`);
}

async function adapter(context) {
  const root = await mkdtemp(join(tmpdir(), 'ocw-api-contract-'));
  const registryDir = join(root, 'registry');
  const fixture = await writeFixtureWorkflow(join(root, 'task'), { taskId: 'TASK-CONTRACT', prefix: 'API' });
  const registration = await registerHarness({ source: fixture.root, sessionId: 'contract', processId: process.pid, registryDir });

  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const base = `http://127.0.0.1:${port}`;

  let logs = '';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: app,
    env: { ...process.env, PORT: String(port), OCW_HARNESS_REGISTRY_DIR: registryDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  context.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(force);
    }
    await rm(root, { recursive: true, force: true });
  });

  const request = async (path, options) => {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(6000), ...options });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await request('/api/health')).status === 200) return { request, registration }; } catch {}
    await pause(100);
  }
  throw new Error(`adapter did not start: ${logs}`);
}

test('health, registry, snapshot and diagnostics match docs/openapi.json', async context => {
  const { request, registration } = await adapter(context);

  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assertKeys('GET /api/health', health.body, schemaFor('/api/health', '200'));
  assertKeys('GET /api/health binding', health.body.binding, spec.components.schemas.Binding);
  assertKeys('GET /api/health binding.capabilities', health.body.binding.capabilities, spec.components.schemas.Capabilities);

  const registry = await request('/api/registry');
  assert.equal(registry.status, 200);
  assertKeys('GET /api/registry', registry.body, schemaFor('/api/registry', '200'));
  assertKeys('GET /api/registry counts', registry.body.counts, spec.components.schemas.RegistryCounts);

  const snapshot = await request(`/api/snapshot?harness=${registration.registrationId}`);
  assert.equal(snapshot.status, 200);
  assertKeys('GET /api/snapshot', snapshot.body, schemaFor('/api/snapshot', '200'));
  assertKeys('GET /api/snapshot agentActivity', snapshot.body.agentActivity, spec.components.schemas.AgentActivity);

  const diagnostics = await request('/api/diagnostics');
  assert.equal(diagnostics.status, 200);
  assertKeys('GET /api/diagnostics', diagnostics.body, spec.components.schemas.Diagnostics);
});

test('documented caching, error shapes and read-only enforcement hold', async context => {
  const { request } = await adapter(context);

  const health = await request('/api/health');
  assert.equal(health.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(health.headers.get('cache-control'), 'no-store');

  // An unknown harness is a 409 carrying registryRequired, not a 404.
  const missing = await request('/api/snapshot?harness=harness-does-not-exist');
  assert.equal(missing.status, 409);
  assertKeys('GET /api/snapshot 409', missing.body, schemaFor('/api/snapshot', '409'));
  assert.equal(missing.body.registryRequired, true);

  // No route mutates canonical state, so anything but GET/HEAD is refused.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const rejected = await request('/api/registry', { method });
    assert.equal(rejected.status, 405, `${method} must be refused`);
    assert.deepEqual(rejected.body.allow, ['GET', 'HEAD']);
    assert.equal(typeof rejected.body.error, 'string');
  }
});

test('every path in docs/openapi.json is reachable and no documented path 404s', async context => {
  const { request, registration } = await adapter(context);
  const query = { '/api/snapshot': `?harness=${registration.registrationId}` };
  for (const path of Object.keys(spec.paths)) {
    if (path === '/api/stream') continue;  // Long-lived; covered by the e2e suite.
    const { status } = await request(path + (query[path] || ''));
    assert.equal(status, 200, `${path} should answer 200`);
  }
});
