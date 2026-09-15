import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listRegistrations,
  registerHarness,
  updateRegistration,
} from "../scripts/harness-registry.mjs";

async function makeCanonicalSource(root, taskId) {
  const source = join(root, taskId);
  await mkdir(source, { recursive: true });
  await Promise.all([
    writeFile(join(source, "state.json"), `${JSON.stringify({ task_id: taskId })}\n`),
    writeFile(join(source, "events.jsonl"), ""),
    writeFile(join(source, "checkpoint-graph.json"), "{}\n"),
  ]);
  return source;
}

test("registers concurrent task/session records atomically", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ocw-harness-registry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registryDir = join(root, "registry");
  const sourceA = await makeCanonicalSource(root, "TASK-A");
  const sourceB = await makeCanonicalSource(root, "TASK-B");
  const inputs = [
    { source: sourceA, sessionId: "session-1" },
    { source: sourceA, sessionId: "session-2" },
    { source: sourceB, sessionId: "session-1" },
    { source: sourceB, sessionId: "session-2" },
  ];

  const registrations = await Promise.all(inputs.map((input) => registerHarness({ ...input, registryDir })));
  assert.equal(new Set(registrations.map((item) => item.registrationId)).size, inputs.length);

  const listed = await listRegistrations(registryDir);
  assert.equal(listed.errors.length, 0);
  assert.equal(listed.registrations.length, inputs.length);
  assert.deepEqual(new Set(listed.registrations.map((item) => item.taskId)), new Set(["TASK-A", "TASK-B"]));

  const names = await readdir(registryDir);
  const files = names.filter((name) => name.endsWith(".json"));
  assert.equal(files.length, inputs.length);
  assert.equal(names.some((name) => name.endsWith(".tmp")), false);
  assert.equal((await stat(registryDir)).mode & 0o777, 0o700);
  await Promise.all(files.map(async (name) => {
    assert.equal((await stat(join(registryDir, name))).mode & 0o777, 0o600);
    const body = await readFile(join(registryDir, name), "utf8");
    assert.doesNotThrow(() => JSON.parse(body));
  }));
});

test("heartbeat and close update only the selected registration", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ocw-harness-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registryDir = join(root, "registry");
  const source = await makeCanonicalSource(root, "TASK-LIFECYCLE");
  const first = await registerHarness({ source, sessionId: "first", registryDir });
  const second = await registerHarness({ source, sessionId: "second", registryDir });

  await updateRegistration(first.registrationId, { instanceId: first.instanceId, lifecycle: "closed", closedAt: new Date().toISOString() }, registryDir);
  const listed = await listRegistrations(registryDir);
  const firstAfter = listed.registrations.find((item) => item.registrationId === first.registrationId);
  const secondAfter = listed.registrations.find((item) => item.registrationId === second.registrationId);
  assert.equal(firstAfter.lifecycle, "closed");
  assert.equal(secondAfter.lifecycle, "registered");
});

test("rejects a source without the canonical contract", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ocw-harness-invalid-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    registerHarness({ source: root, sessionId: "missing-files", registryDir: join(root, "registry") }),
    /canonical source is missing state\.json/,
  );
});

test("isolates multiple tasks that share the exact same sessionId", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ocw-harness-isolation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registryDir = join(root, "registry");
  const source1 = await makeCanonicalSource(root, "TASK-ALPHA");
  const source2 = await makeCanonicalSource(root, "TASK-BETA");

  const reg1 = await registerHarness({ source: source1, sessionId: "default", registryDir });
  const reg2 = await registerHarness({ source: source2, sessionId: "default", registryDir });

  assert.notEqual(reg1.registrationId, reg2.registrationId);
  assert.equal(reg1.sessionId, "default");
  assert.equal(reg2.sessionId, "default");
  assert.equal(reg1.taskId, "TASK-ALPHA");
  assert.equal(reg2.taskId, "TASK-BETA");

  const listed = await listRegistrations(registryDir);
  assert.equal(listed.registrations.length, 2);
  const found1 = listed.registrations.find((r) => r.taskId === "TASK-ALPHA");
  const found2 = listed.registrations.find((r) => r.taskId === "TASK-BETA");
  assert.ok(found1);
  assert.ok(found2);
  assert.equal(found1.sessionId, "default");
  assert.equal(found2.sessionId, "default");
  assert.notEqual(found1.registrationId, found2.registrationId);
});

test("re-registering the same harness updates in place instead of duplicating", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ocw-harness-reuse-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registryDir = join(root, "registry");
  const source = await makeCanonicalSource(root, "TASK-REUSE");

  const first = await registerHarness({ source, sessionId: "session-1", registryDir, processId: 111 });
  const second = await registerHarness({ source, sessionId: "session-1", registryDir, processId: 222, newInstance: true });

  assert.equal(second.registrationId, first.registrationId);
  assert.equal(second.registeredAt, first.registeredAt, "the original registration time is preserved");
  assert.equal(second.processId, 222, "the newer process id wins");

  const listed = await listRegistrations(registryDir);
  assert.equal(listed.registrations.length, 1);
  assert.equal((await readdir(registryDir)).filter((name) => name.endsWith(".json")).length, 1);
});

test("a registration written under an older id derivation is reused, not duplicated", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ocw-harness-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registryDir = join(root, "registry");
  const source = await makeCanonicalSource(root, "TASK-MIGRATE");

  // Stand in for a record written before taskId entered the id hash.
  const legacyId = "harness-legacyidentity01";
  await registerHarness({ source, sessionId: "session-1", registryDir, registrationId: legacyId, label: "legacy label" });

  const migrated = await registerHarness({ source, sessionId: "session-1", registryDir });
  assert.equal(migrated.registrationId, legacyId, "the existing record is adopted rather than a second one created");
  assert.equal(migrated.label, "legacy label", "existing fields survive the reuse");

  const listed = await listRegistrations(registryDir);
  assert.equal(listed.registrations.length, 1, "no duplicate card appears in the registry");
});

test("a task_id change under a stable source root yields a distinct registration", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ocw-harness-taskid-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registryDir = join(root, "registry");
  const source = await makeCanonicalSource(root, "TASK-BEFORE");

  const before = await registerHarness({ source, sessionId: "session-1", registryDir });
  await writeFile(join(source, "state.json"), `${JSON.stringify({ task_id: "TASK-AFTER" })}\n`);
  const after = await registerHarness({ source, sessionId: "session-1", registryDir });

  assert.notEqual(after.registrationId, before.registrationId);
  assert.equal(after.taskId, "TASK-AFTER");
  const listed = await listRegistrations(registryDir);
  assert.deepEqual(
    new Set(listed.registrations.map((item) => item.taskId)),
    new Set(["TASK-BEFORE", "TASK-AFTER"]),
  );
});
