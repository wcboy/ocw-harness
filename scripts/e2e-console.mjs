/**
 * End-to-end tests for the harness console, driven through a real browser.
 *
 * Run with `npm run e2e`. Deliberately excluded from `npm run check` so the fast
 * gate stays fast; this needs a build, two spawned servers and a Chromium.
 *
 * Everything runs against synthetic workflow roots in a temp directory with an
 * isolated `OCW_HARNESS_REGISTRY_DIR`, so no test touches the developer's real
 * registry or any canonical workflow data.
 */

import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { writeFixtureWorkflow } from "./e2e-fixture.mjs";
import { registerHarness } from "./harness-registry.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OCW_E2E_PORT || 4321);
const BASE = `http://127.0.0.1:${PORT}`;

/** Wait for the server to answer, so tests never race a cold start. */
async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`server did not become healthy at ${BASE}`);
}

async function startServer(registryDir) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, PORT: String(PORT), OCW_HARNESS_REGISTRY_DIR: registryDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  try {
    await waitForHealth();
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${error.message}\nserver output:\n${logs.join("")}`);
  }
  return {
    stop: () =>
      new Promise((done) => {
        child.once("exit", done);
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, 3000).unref();
      }),
  };
}

/**
 * Two harnesses that deliberately share one sessionId, so isolation is tested
 * for the case that would actually collide.
 */
async function setupWorld(context) {
  const root = await mkdtemp(join(tmpdir(), "ocw-e2e-"));
  const registryDir = join(root, "registry");
  const alpha = await writeFixtureWorkflow(join(root, "alpha"), {
    taskId: "TASK-E2E-ALPHA",
    prefix: "ALPHA",
    phase: "exploring",
    working: true,
  });
  const beta = await writeFixtureWorkflow(join(root, "beta"), {
    taskId: "TASK-E2E-BETA",
    prefix: "BETA",
    phase: "complete",
    working: false,
  });

  const sharedSession = "shared-session";
  const alphaReg = await registerHarness({ source: alpha.root, sessionId: sharedSession, registryDir, processId: process.pid });
  const betaReg = await registerHarness({ source: beta.root, sessionId: sharedSession, registryDir, processId: process.pid });

  const server = await startServer(registryDir);
  const browser = await chromium.launch();

  context.after(async () => {
    await browser.close();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });

  return { root, registryDir, alpha, beta, alphaReg, betaReg, browser, sharedSession };
}

/** A page that records console errors, since a silent exception is a failure. */
async function openPage(browser, path, viewport = { width: 1600, height: 1000 }) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  return { page, consoleErrors };
}

test("two tasks sharing one sessionId stay isolated end to end", async (context) => {
  const world = await setupWorld(context);

  assert.notEqual(world.alphaReg.registrationId, world.betaReg.registrationId);
  assert.equal(world.alphaReg.sessionId, world.betaReg.sessionId, "the collision case is what is under test");

  const registry = await (await fetch(`${BASE}/api/registry`)).json();
  assert.equal(registry.registrations.length, 2);
  assert.equal(registry.counts.sessions, 2, "same sessionId under two tasks counts as two sessions");

  const alphaSnapshot = await (await fetch(`${BASE}/api/snapshot?harness=${world.alphaReg.registrationId}`)).json();
  const betaSnapshot = await (await fetch(`${BASE}/api/snapshot?harness=${world.betaReg.registrationId}`)).json();
  assert.equal(alphaSnapshot.task.id, "TASK-E2E-ALPHA");
  assert.equal(betaSnapshot.task.id, "TASK-E2E-BETA");
  assert.notEqual(alphaSnapshot.sourceRoot, betaSnapshot.sourceRoot);

  // No identifier from one task may appear anywhere in the other's snapshot.
  assert.equal(JSON.stringify(alphaSnapshot).includes("BETA"), false);
  assert.equal(JSON.stringify(betaSnapshot).includes("ALPHA"), false);
});

test("the registry overview lists both harnesses with their own progress", async (context) => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, "/");

  await page.waitForSelector('[data-testid="harness-registry"], .registry-card, .harness-card', { timeout: 15000 });
  const body = await page.locator("body").innerText();
  assert.ok(body.includes("TASK-E2E-ALPHA"), "alpha appears in the overview");
  assert.ok(body.includes("TASK-E2E-BETA"), "beta appears in the overview");
  assert.deepEqual(consoleErrors, []);
});

test("a working agent is visible on the task that owns it, and only there", async (context) => {
  const world = await setupWorld(context);

  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`);
  await page.waitForSelector('[data-testid="journey-track"]', { timeout: 15000 });
  const alphaText = await page.locator('[data-testid="journey-track"]').innerText();
  assert.ok(alphaText.includes(world.alpha.agentName), `alpha canvas shows ${world.alpha.agentName}`);

  const workingPill = page.locator(".highlight-pill", { hasText: "只看工作中" });
  assert.match(await workingPill.innerText(), /\(1\)/, "one working agent is counted");

  // Beta is complete, so its agent must not be reported as working.
  await page.goto(`${BASE}/?harness=${world.betaReg.registrationId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="journey-track"]', { timeout: 15000 });
  await page.waitForFunction(() => document.body.innerText.includes("TASK-E2E-BETA"), null, { timeout: 15000 });
  const betaWorking = page.locator(".highlight-pill", { hasText: "只看工作中" });
  assert.match(await betaWorking.innerText(), /\(0\)/, "a complete task reports no working agents");
  assert.deepEqual(consoleErrors, []);
});

test("switching harness leaves no data from the previous task on screen", async (context) => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`);
  await page.waitForSelector('[data-testid="journey-track"]', { timeout: 15000 });
  await page.waitForFunction((id) => document.body.innerText.includes(id), world.alpha.goalA, { timeout: 15000 });

  await page.selectOption(".harness-select", world.betaReg.registrationId);
  await page.waitForFunction((id) => document.body.innerText.includes(id), world.beta.goalA, { timeout: 15000 });

  // Let the 1s poll run a few times; stale data would reappear here if the
  // stream applied a snapshot belonging to the previous registration.
  await page.waitForTimeout(2500);

  // The switcher names every registered harness by design, so the bleed check
  // covers the workspace and the active-binding header, not the whole document.
  const workspace = await page.locator("main.workspace").innerText();
  const binding = await page.locator(".brand-block").innerText();
  for (const region of [workspace, binding]) {
    assert.equal(region.includes("TASK-E2E-ALPHA"), false, "the previous task id is gone");
    assert.equal(region.includes(world.alpha.goalA), false, "the previous task's goal id is gone");
    assert.equal(region.includes(world.alpha.checkpoints[0]), false, "the previous task's checkpoints are gone");
    assert.equal(region.includes(world.alpha.agentName), false, "the previous task's agent is gone");
  }
  assert.ok(binding.includes("TASK-E2E-BETA"), "the header names the harness now bound");
  assert.ok(workspace.includes(world.beta.goalA), "the canvas shows the new task's goals");
  assert.deepEqual(consoleErrors, []);
});

test("there is one topology, and its branches expand in place at any depth", async (context) => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`);
  await page.waitForSelector('[data-testid="journey-track"]', { timeout: 15000 });

  assert.equal(await page.locator('[data-testid="journey-track"]').count(), 1, "exactly one topology");
  assert.equal(await page.locator(".view-mode-tabs, .mode-tab-button").count(), 0, "no redundant view-mode tabs remain");

  // The overview starts collapsed, with details disclosed at each depth.
  assert.equal(await page.locator(".branch-node").count(), 0);
  assert.equal(await page.getByTestId("detail-drawer").count(), 0);
  await page.locator(".graph-root").click();
  assert.ok((await page.getByTestId("detail-drawer").innerText()).includes("合成根目标"), "the diagram root resolves to the actual goal tree");
  await page.reload();
  await page.getByTestId("detail-drawer").waitFor();
  assert.ok((await page.getByTestId("detail-drawer").innerText()).includes("合成根目标"), "root deep links survive reload");
  await page.keyboard.press("Escape");
  await page.getByTestId(`expand-${world.alpha.goalA}`).click();
  const branchTree = page.locator(`[data-testid="branch-tree-${world.alpha.goalA}"]`);
  await branchTree.waitFor({ timeout: 15000 });
  const toggle = branchTree.locator(".branch-toggle").first();
  assert.ok((await branchTree.locator(".branch-toggle").count()) > 0, "a nested branch offers a toggle");

  const collapsed = await branchTree.locator(".branch-node").count();
  await toggle.click();
  const expanded = await branchTree.locator(".branch-node").count();
  assert.ok(expanded > collapsed, "expanding reveals nested checkpoints");
  await page.waitForTimeout(2200);
  assert.equal(await branchTree.locator(".branch-node").count(), expanded, "polls preserve the disclosure state");
  await toggle.click();
  assert.equal(await branchTree.locator(".branch-node").count(), collapsed, "collapsing hides descendants");
  await page.waitForTimeout(1100);
  assert.equal(await branchTree.locator(".branch-node").count(), collapsed, "polls do not reopen a collapsed branch");
  assert.deepEqual(consoleErrors, []);
});

test("the highlight filter changes what is visible, not just its own state", async (context) => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`);
  await page.locator(".graph-path-toggle").first().click();
  await page.waitForSelector(".mini-path-pill", { timeout: 15000 });

  const opacities = () => page.$$eval(".mini-path-pill", (nodes) => nodes.map((node) => Number(getComputedStyle(node).opacity)));
  const before = await opacities();
  assert.ok(before.length >= 2, "the fixture has several paths to filter");
  assert.ok(before.every((value) => value > 0.9), "nothing is dimmed before filtering");

  await page.locator(".highlight-pill", { hasText: "只看采纳路线" }).click();
  await page.waitForTimeout(400);
  assert.equal(await page.getAttribute('[data-testid="journey-track"]', "data-filter"), "selected_route");
  const after = await opacities();
  assert.ok(after.some((value) => value < 0.5), "non-matching paths are dimmed");
  assert.ok(after.some((value) => value > 0.9), "the adopted path stays legible");

  await page.locator(".highlight-pill", { hasText: "全部" }).click();
  await page.waitForTimeout(400);
  assert.ok((await opacities()).every((value) => value > 0.9), "clearing the filter restores everything");
  assert.deepEqual(consoleErrors, []);
});

test("a filter that would match nothing says so instead of dimming everything", async (context) => {
  const world = await setupWorld(context);
  // Beta is complete, so it has no working agents.
  const { page } = await openPage(world.browser, `/?harness=${world.betaReg.registrationId}`);
  await page.waitForSelector('[data-testid="journey-track"]', { timeout: 15000 });

  await page.locator(".highlight-pill", { hasText: "只看工作中" }).click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="filter-empty-note"]').waitFor({ timeout: 5000 });
  assert.equal(
    await page.getAttribute('[data-testid="journey-track"]', "data-filter"),
    "all",
    "an empty filter falls back to showing everything rather than a blank canvas",
  );
});

test("the console reflects a real state change within about a second", async (context) => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`);
  await page.waitForSelector('[data-testid="journey-track"]', { timeout: 15000 });
  await page.waitForFunction(() => document.body.innerText.includes("REV 2"), null, { timeout: 15000 });

  const statePath = join(world.alpha.root, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const eventsPath = join(world.alpha.root, "events.jsonl");
  const events = await readFile(eventsPath, "utf8");
  await writeFile(eventsPath, events + JSON.stringify({ event_id: "EV-3", from_revision: 2, to_revision: 3, from_phase: state.phase, to_phase: state.phase, at: new Date().toISOString() }) + "\n");
  state.revision = 3;
  state.updated_at = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify(state, null, 1)}\n`);

  const started = Date.now();
  await page.waitForFunction(() => document.body.innerText.includes("REV 3"), null, { timeout: 8000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `change surfaced in ${elapsed}ms`);
  assert.deepEqual(consoleErrors, []);
});

test("the SSE stream and the 1s poll coexist without errors or duplicate clients", async (context) => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`);
  await page.waitForSelector('[data-testid="journey-track"]', { timeout: 15000 });

  await page.waitForFunction(
    () => document.querySelector('[data-testid="connection-status"]')?.getAttribute("data-state") === "live",
    null,
    { timeout: 15000 },
  );

  // Both transports run for several seconds; the poll must not re-hash unchanged
  // files, and the stream must stay attached.
  const before = await (await fetch(`${BASE}/api/diagnostics`)).json();
  await page.waitForTimeout(5000);
  const after = await (await fetch(`${BASE}/api/diagnostics`)).json();

  assert.equal(
    await page.getAttribute('[data-testid="connection-status"]', "data-state"),
    "live",
    "the stream is still live after several poll cycles",
  );
  assert.ok(
    after.snapshotBuilds - before.snapshotBuilds <= 2,
    `an idle workflow triggers almost no rebuilds (saw ${after.snapshotBuilds - before.snapshotBuilds} over ~5s)`,
  );
  assert.ok(after.connectedClients >= 1, "the SSE client is registered");
  assert.deepEqual(consoleErrors, []);
});

test("the layout has no page-level horizontal overflow at 390x844", async (context) => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`, {
    width: 390,
    height: 844,
  });
  await page.waitForSelector('[data-testid="journey-track"]', { timeout: 15000 });
  await page.waitForTimeout(600);

  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  assert.equal(overflow.doc, 0, "the document does not scroll sideways");
  assert.equal(overflow.body, 0, "the body does not scroll sideways");

  // The topology itself is a scroller by design; that must stay true.
  const scroller = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="journey-scroller"]');
    return node ? { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth } : null;
  });
  assert.ok(scroller && scroller.scrollWidth > scroller.clientWidth, "the canvas scrolls inside its own frame");
  assert.deepEqual(consoleErrors, []);
});

test("the read-only contract is enforced at the API surface", async (context) => {
  const world = await setupWorld(context);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${BASE}/api/snapshot?harness=${world.alphaReg.registrationId}`, { method });
    assert.equal(response.status, 405, `${method} is refused`);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
  assert.equal((await fetch(`${BASE}/api/snapshot?harness=${world.alphaReg.registrationId}`)).status, 200);
});

test("labels fall back to raw identifiers when no overlay exists for the task", async (context) => {
  const world = await setupWorld(context);
  const snapshot = await (await fetch(`${BASE}/api/snapshot?harness=${world.alphaReg.registrationId}`)).json();

  // No labels/TASK-E2E-ALPHA.json is shipped, so the console must show ids
  // rather than inventing prose for them.
  const layerNode = snapshot.journey.layers[0].nodes[0];
  assert.equal(layerNode.goalId, world.alpha.goalA);
  assert.equal(layerNode.label, world.alpha.goalA);

  const edge = snapshot.journey.transitions[0].edges[0];
  assert.equal(edge.id, world.alpha.edgeA);
  assert.equal(edge.label, world.alpha.goalA, "an unlabeled edge shows its derived goal id");

  // But a real memory_ref heading is used where the data provides one.
  const adopted = edge.paths.find((path) => path.id === world.alpha.pathOk);
  assert.ok(adopted, "the accepted path is present");
  assert.match(adopted.label, /合成的确定性 ALPHA 机制/, "the label comes from the path memo heading");
  assert.equal(adopted.summary, "来自 r2 结果的补充摘要", "the summary comes from the r2 result");
});

test("ownership and status provenance are reported rather than implied", async (context) => {
  const world = await setupWorld(context);
  const snapshot = await (await fetch(`${BASE}/api/snapshot?harness=${world.alphaReg.registrationId}`)).json();
  const checkpoints = snapshot.journey.layers.flatMap((layer) => layer.nodes.flatMap((node) => node.checkpoints));

  // The assignment spec names checkpoints[1] only.
  const direct = checkpoints.find((item) => item.id === world.alpha.checkpoints[1]);
  const inherited = checkpoints.find((item) => item.id === world.alpha.checkpoints[0]);
  assert.equal(direct.worker.scope, "checkpoint");
  assert.equal(direct.worker.inherited, false, "a checkpoint named by the spec owns its agent directly");
  assert.equal(inherited.worker.scope, "edge");
  assert.equal(inherited.worker.inherited, true, "a sibling only inherits the edge's agent");

  // An accepted interface is edge scoped, so a complete status must say so.
  const acceptedNode = snapshot.journey.layers[0].nodes[0];
  assert.equal(acceptedNode.status, "complete");
  assert.equal(acceptedNode.statusSource, "edge_accepted");

  const pendingNode = snapshot.journey.layers[1].nodes[0];
  assert.equal(pendingNode.statusSource, "phase_inferred");

  // A single-writer assignment carries no edge_id. It must still be listed,
  // scoped to its route rather than dropped for lacking an edge.
  const writer = snapshot.agentActivity.assignments.find((item) => item.assignmentId === world.alpha.assignmentWriter);
  assert.ok(writer, "the edge-less assignment survives projection");
  assert.equal(writer.edgeId, null);
  assert.equal(writer.routeId, world.alpha.routeId);
  assert.equal(writer.role, "R4 单写者实现", "the role comes from the assignment spec, not a per-edge table");
});

test("late GET cannot roll back a newer SSE snapshot", async (context) => {
  const world = await setupWorld(context);
  const page = await world.browser.newPage();
  let captured;
  let release;
  const delayed = new Promise(resolve => release = resolve);
  await page.route('**/api/snapshot?**', async route => {
    if (!captured) {
      const response = await route.fetch();
      captured = await response.json();
      await delayed;
      await route.fulfill({ json: captured });
    } else await route.continue();
  });
  await page.goto(`${BASE}/?harness=${world.alphaReg.registrationId}`);
  await page.waitForFunction(() => document.body.innerText.includes('REV 2'));
  const statePath = join(world.alpha.root, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const eventsPath = join(world.alpha.root, 'events.jsonl');
  await writeFile(eventsPath, await readFile(eventsPath, 'utf8') + JSON.stringify({ event_id: 'EV-3', from_revision: 2, to_revision: 3, from_phase: state.phase, to_phase: state.phase }) + '\n');
  await writeFile(statePath, JSON.stringify({ ...state, revision: 3, updated_at: new Date().toISOString() }));
  await page.waitForFunction(() => document.body.innerText.includes('REV 3'));
  release();
  await page.waitForTimeout(300);
  assert.match(await page.locator('body').innerText(), /REV 3/);
  if (process.env.OCW_SCREENSHOT_DIR) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(process.env.OCW_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.OCW_SCREENSHOT_DIR, 'ocw-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(process.env.OCW_SCREENSHOT_DIR, 'ocw-mobile.png'), fullPage: true });
  }
});

test('executor checkpoint progress and an older backup resync by explicit recovery epoch', async context => {
  const world = await setupWorld(context);
  const run = promisify(execFile);
  const root = join(world.root, 'executor');
  const plan = join(world.root, 'executor-plan.json');
  await writeFile(plan, JSON.stringify({ task_id: 'TASK-RECOVERY-BROWSER', delivery_dir: join(world.root, 'delivery'), checkpoints: [
    { id: 'BROWSER-PROOF', objective: '验证真实执行后的恢复展示', execution: 'replay_safe', cwd: appRoot, argv: [process.execPath, '-e', 'console.log("browser proof")'] },
  ] }));
  const cli = async (script, ...args) => JSON.parse((await run('python3', ['scripts/' + script, ...args], { cwd: appRoot })).stdout);
  await cli('ocw_runtime.py', 'init', '--root', root, '--plan', plan);
  const config = join(world.root, 'backup.json');
  await writeFile(config, JSON.stringify({ items: [{ name: 'runtime', kind: 'runtime', path: root }] }));
  const backup = await cli('ocw_backup.py', 'create', '--config', config, '--destination', join(world.root, 'backups'));
  await cli('ocw_runtime.py', 'run', '--root', root);
  const reg = await registerHarness({ source: root, sessionId: 'proof', registryDir: world.registryDir });
  const page = await world.browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let captured, release;
  const delayed = new Promise(resolve => release = resolve);
  await page.route('**/api/snapshot?**', async route => {
    if (!captured) {
      captured = await (await route.fetch()).json();
      await delayed;
      await route.fulfill({ json: captured });
    } else await route.continue();
  });
  await page.goto(`${BASE}/?harness=${reg.registrationId}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="executor-recovery"]')?.textContent?.includes('1/1'));
  assert.match(await page.getByTestId('progress-board').innerText(), /100%/);
  assert.match(await page.getByTestId('progress-board').innerText(), /未启用/);
  const restored = join(world.root, 'restored');
  await cli('ocw_backup.py', 'restore', '--archive', backup.archive, '--destination', restored);
  // Explicit promotion in an isolated, stopped fixture. Keep the old root intact.
  await rename(root, root + '.retired');
  await rename(join(restored, 'runtime'), root);
  await page.waitForFunction(() => document.querySelector('[data-testid="executor-recovery"]')?.textContent?.includes('0/1'));
  assert.match(await page.locator('body').innerText(), /执行保持暂停/);
  assert.match(await page.locator('body').innerText(), /全阶段状态：需处理/);
  release();
  await page.waitForTimeout(350);
  await page.locator('.runtime-details > summary').click();
  assert.match(await page.getByTestId('executor-recovery').innerText(), /0\/1/);
  await run('python3', ['-c', 'from ocw_runtime import Runtime; import sys; Runtime(sys.argv[1]).record_backup({"status":"failed","error":"fixture disk unavailable"})', root], { cwd: join(appRoot, 'scripts') });
  await page.waitForFunction(() => document.querySelector('[data-testid="backup-status"]')?.textContent?.includes('未完成，需要处理'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual(errors, []);
  if (process.env.OCW_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.OCW_SCREENSHOT_DIR, 'ocw-recovery-mobile.png'), fullPage: true });
});


test("checkpoint details open on demand, close with Escape, and restore keyboard focus", async context => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`);
  await page.getByTestId("journey-track").waitFor();
  assert.equal(await page.getByTestId("detail-drawer").count(), 0);
  await page.locator(".graph-root").click();
  assert.ok((await page.getByTestId("detail-drawer").innerText()).includes("合成根目标"), "the diagram root resolves to the actual goal tree");
  await page.reload();
  await page.getByTestId("detail-drawer").waitFor();
  assert.ok((await page.getByTestId("detail-drawer").innerText()).includes("合成根目标"), "root deep links survive reload");
  await page.keyboard.press("Escape");
  await page.getByTestId(`expand-${world.alpha.goalA}`).click();
  await page.locator(`[data-testid="branch-tree-${world.alpha.goalA}"] .branch-toggle`).first().click();
  const checkpoint = page.locator(`.branch-node[data-checkpoint="${world.alpha.checkpoints[0]}"]`);
  await checkpoint.click();
  await page.getByTestId("checkpoint-detail").waitFor();
  assert.ok((await page.getByTestId("detail-drawer").innerText()).includes(world.alpha.checkpoints[0]));
  assert.ok(new URL(page.url()).searchParams.has("select"));
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("detail-drawer").count(), 0);
  assert.equal(new URL(page.url()).searchParams.has("select"), false);
  assert.equal(await checkpoint.evaluate(node => document.activeElement === node), true);
  await page.waitForTimeout(1200);
  assert.equal(await page.getByTestId("detail-drawer").count(), 0, "a poll never reopens the drawer");
  assert.deepEqual(consoleErrors, []);
});

test("path disclosure preserves branches, deep links, and evidence while the graph stays singular", async context => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`);
  await page.getByTestId("journey-track").waitFor();
  assert.equal(await page.locator(".mini-path-pill").count(), 0);
  const toggle = page.locator(".graph-path-toggle").first();
  await toggle.click();
  const path = page.locator('.mini-path-pill[data-selected="true"]').first();
  await path.click();
  await page.getByTestId("edge-detail").waitFor();
  assert.equal(await page.getByTestId("journey-track").count(), 1);
  assert.match(await page.locator(".detail-rows").textContent(), /机制/);
  assert.equal(await page.locator(".evidence-disclosure").getAttribute("open"), null);
  await page.locator(".evidence-disclosure > summary").click();
  assert.ok(await page.locator(".detail-rows").isVisible());
  const deepUrl = page.url();
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await toggle.click();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator(".mini-path-pill").count(), 0);
  await page.goto(deepUrl);
  await page.getByTestId("edge-detail").waitFor();
  assert.ok(await page.locator('.mini-path-pill[data-active="true"]').isVisible());
  assert.deepEqual(consoleErrors, []);
});

test("measured wires follow real dependency endpoints when nodes expand or zoom", async context => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`);
  await page.locator(".graph-wires path").first().waitFor({ state: "attached" });
  const snapshot = await (await fetch(`${BASE}/api/snapshot?harness=${world.alphaReg.registrationId}`)).json();
  assert.equal(await page.locator('.graph-wires path:not([data-edge=""])').count(), snapshot.journey.transitions.flatMap(t => t.edges).reduce((count, edge) => count + edge.from.length, 0));
  const edge = snapshot.journey.transitions[0].edges[0];
  const wire = page.locator(`.graph-wires path[data-edge="${edge.id}"]`).first();
  const checkEndpoint = () => wire.evaluate((path, destination) => {
    const point = path.getPointAtLength(path.getTotalLength());
    const matrix = path.getScreenCTM();
    const endpoint = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    const node = [...document.querySelectorAll("[data-graph-node]")].find(node => node.dataset.graphNode === destination).getBoundingClientRect();
    return Math.abs(endpoint.x - node.left) < 2 && Math.abs(endpoint.y - (node.top + node.height / 2)) < 2;
  }, edge.to);
  assert.ok(await checkEndpoint());
  await page.getByRole("button", { name: "展开检查点", exact: true }).click();
  await page.waitForTimeout(150);
  assert.ok(await checkEndpoint());
  await page.getByRole("button", { name: "缩小路径图" }).click();
  assert.ok(await checkEndpoint(), "zoom keeps the SVG and card ports aligned");
  assert.deepEqual(consoleErrors, []);
});

test("mobile drawers, phase disclosure and dark theme keep controls reachable", async context => {
  const world = await setupWorld(context);
  const { page, consoleErrors } = await openPage(world.browser, `/?harness=${world.alphaReg.registrationId}`, { width: 390, height: 844 });
  await page.getByTestId("journey-track").waitFor();
  await page.locator(".compact-stages button").first().click();
  assert.ok(await page.locator(".phase-disclosure").isVisible());
  await page.locator(".compact-stages button").first().click();
  assert.equal(await page.locator(".phase-disclosure").count(), 0);
  await page.getByRole("button", { name: "切换深色主题" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.locator(".graph-task-title").first().click();
  const drawer = await page.getByTestId("detail-drawer").boundingBox();
  assert.ok(drawer.x >= 0 && drawer.x + drawer.width <= 390);
  assert.ok(drawer.y >= 0 && drawer.y + drawer.height <= 844);
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(consoleErrors, []);
});

test("demo renders parallel states and all-required regions using the shared interactive graph", async context => {
  const world = await setupWorld(context);
  const page = await world.browser.newPage({ viewport: { width: 1440, height: 1040 } });
  const apiRequests = [], errors = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url()); });
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${BASE}/?demo=paths&harness=${world.alphaReg.registrationId}`);
  await page.getByRole("button", { name: "暂停演示", exact: true }).click();
  await page.locator(".connection-flow").first().waitFor({ state: "attached" });
  assert.match(await page.locator(".demo-topbar").innerText(), /不代表真实任务/);
  assert.equal(await page.locator(".checkpoint-region").count(), 3);
  assert.equal(await page.locator(".checkpoint-point").count(), 9);
  assert.equal(await page.locator(".path-line-label").count(), 9);
  for (const region of await page.locator(".checkpoint-region").all()) {
    assert.equal(await region.evaluate(node => getComputedStyle(node).borderTopStyle), "dashed");
    assert.match(await region.innerText(), /全部满足/);
  }
  const styles = await page.locator('.graph-wires g[data-kind="path"]').evaluateAll(groups => groups.map(group => ({
    tone: group.dataset.tone,
    dash: getComputedStyle(group.querySelector(".connection-line")).strokeDasharray,
    color: getComputedStyle(group.querySelector(".connection-line")).stroke,
    hasFlow: !!group.querySelector(".connection-flow"),
  })));
  assert.ok(styles.filter(s => s.tone === "pending").every(s => s.dash !== "none"));
  assert.ok(styles.filter(s => s.tone === "adopted").every(s => s.dash === "none" && s.hasFlow));
  assert.ok(styles.filter(s => s.tone === "refuted").every(s => s.dash === "none" && !s.hasFlow));
  assert.notEqual(styles.find(s => s.tone === "refuted").color, styles.find(s => s.tone === "adopted").color);
  assert.match(await page.locator('.path-line-label[data-tone="refuted"]').first().innerText(), /×/);
  assert.equal(await page.locator(".dependency-join").count(), 1);
  const geometry = await page.locator('.graph-wires g[data-kind="path"] .connection-line').evaluateAll(paths => {
    const grouped = {};
    for (const path of paths) { const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength()); (grouped[path.dataset.edge] ||= []).push([start.x, start.y, end.x, end.y].map(n => Math.round(n)).join()); }
    return grouped;
  });
  for (const endpoints of Object.values(geometry)) { assert.equal(endpoints.length, 3); assert.equal(new Set(endpoints).size, 1); }
  await page.locator('.path-line-label[data-tone="refuted"]').first().click();
  assert.match(await page.getByTestId("edge-detail").innerText(), /已证伪/);
  await page.keyboard.press("Escape");
  await page.locator('.checkpoint-point[data-status="active"]').first().click();
  assert.match(await page.getByTestId("checkpoint-detail").innerText(), /演示状态/);
  assert.match(await page.locator(".inspector-foot").innerText(), /DEMO/);
  assert.equal(await page.locator(".branch-tree").count(), 0, "opening a point does not expand unrelated decomposition");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "收起路径", exact: true }).click();
  assert.equal(await page.locator(".path-line-label").count(), 0);
  await page.getByRole("button", { name: "展开路径", exact: true }).click();
  assert.equal(await page.locator(".path-line-label").count(), 9);
  await page.getByRole("button", { name: "深色", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.deepEqual(apiRequests, [], "demo must never bind, poll, or mutate a real harness");
  assert.deepEqual(errors, []);
});

test("demo playback pauses, advances, recovers and replays without losing an open checkpoint", async context => {
  const world = await setupWorld(context);
  const page = await world.browser.newPage();
  await page.clock.install();
  await page.goto(`${BASE}/?demo=paths`);
  await page.getByTestId("journey-track").waitFor();
  await page.getByRole("button", { name: "暂停演示", exact: true }).click();
  assert.match(await page.getByTestId("demo-step").innerText(), /01/);
  await page.clock.fastForward(10000);
  assert.match(await page.getByTestId("demo-step").innerText(), /01/);
  const point = page.locator('.checkpoint-point[data-checkpoint="DEMO-evidence-2"]');
  await point.click();
  for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "单步", exact: true }).click();
  assert.equal(await point.getAttribute("data-status"), "attention");
  assert.match(await page.getByTestId("checkpoint-detail").innerText(), /需处理/);
  await page.getByRole("button", { name: "单步", exact: true }).click();
  assert.equal(await point.getAttribute("data-status"), "complete");
  assert.match(await page.getByTestId("checkpoint-detail").innerText(), /已完成/);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "继续播放", exact: true }).click();
  await page.clock.fastForward(5000);
  assert.match(await page.getByTestId("demo-step").innerText(), /05/);
  assert.equal(await page.locator('[data-graph-node="DEMO-verification"]').getAttribute("data-status"), "active");
  await page.getByRole("button", { name: "重播", exact: true }).click();
  assert.match(await page.getByTestId("demo-step").innerText(), /01/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".connection-flow").first().evaluate(node => getComputedStyle(node).animationName), "none");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(await page.getByRole("button", { name: "单步", exact: true }).isVisible());
});

test('native runtime drives mixed ALL groups, stable paths, independent evidence and invalidations', async context => {
  const world=await setupWorld(context),run=promisify(execFile);
  const root=join(world.root,'native');
  const advance=action=>run('python3',['scripts/e2e-native.py',action,root],{cwd:appRoot});
  await advance('seed');
  const registration=await registerHarness({source:root,sessionId:'native',registryDir:world.registryDir,processId:process.pid});
  const {page,consoleErrors}=await openPage(world.browser,`/?harness=${registration.registrationId}`);
  await page.getByTestId('journey-track').waitFor();
  assert.equal(await page.locator('.checkpoint-region').count(),3);
  assert.equal(await page.locator('.checkpoint-point').count(),6);
  assert.ok(await page.getByText('执行与验收',{exact:true}).isVisible());
  for (const [id,status] of [['CP-A1','complete'],['CP-A2','active'],['CP-A3','pending']]) assert.equal(await page.locator(`.checkpoint-point[data-checkpoint="${id}"]`).getAttribute('data-status'),status);
  assert.equal(await page.locator('.checkpoint-point[data-checkpoint="CP-A3"] .graph-worker').count(),0,'another checkpoint owner must not leak into a pending point');
  await page.getByRole('button',{name:'展开路径',exact:true}).click();
  assert.equal(await page.locator('.path-line-label').count(),9);
  await page.locator('.path-line-label').filter({hasText:'版本投影'}).first().click();
  assert.match(await page.getByTestId('attempt-history').innerText(),/3 次执行尝试/);
  assert.equal(await page.locator('.path-line-label[data-active="true"]').getAttribute('data-tone'),'adopted','failed execution does not refute the stable path');
  await page.keyboard.press('Escape');
  await page.locator('.checkpoint-point[data-checkpoint="CP-A1"]').click();
  await page.getByTestId('runtime-evidence').locator('summary').click();
  assert.match(await page.getByTestId('runtime-evidence').innerText(),/local-receipt-v1/);
  assert.match(await page.getByTestId('runtime-evidence').innerText(),/input_digest/);
  await page.keyboard.press('Escape');
  await page.locator('.checkpoint-point[data-checkpoint="CP-C1"]').click();
  await advance('advance');
  await page.waitForFunction(()=>document.querySelector('.checkpoint-point[data-checkpoint="CP-C1"]')?.dataset.status==='active');
  assert.match(await page.getByTestId('checkpoint-detail').innerText(),/fixture-agent-c/);
  assert.equal(await page.locator('.checkpoint-point[data-status="complete"]').count(),5);
  await advance('refute');
  await page.waitForFunction(()=>document.querySelector('.checkpoint-point[data-checkpoint="CP-C1"]')?.dataset.status==='pending');
  assert.match(await page.getByTestId('checkpoint-detail').innerText(),/未分配/);
  assert.equal(await page.locator('.graph-wires g[data-tone="refuted"]').count(),2);
  assert.deepEqual(consoleErrors,[]);
});

test('a new UI release reloads once and preserves the selected task and checkpoint',async context=>{
  const world=await setupWorld(context);
  const {page}=await openPage(world.browser,`/?harness=${world.alphaReg.registrationId}`);
  await page.locator('.checkpoint-point').first().click();
  const selected=new URL(page.url()).searchParams.get('select');
  let requests=0;
  await page.route('**/ui-build.json',async route=>{requests++;await route.fulfill({json:{designVersion:'checkpoint-paths-2',sourceDigest:'new-ui-test-release'}});});
  let ready=false;
  await page.route('**/index.html',async route=>{if(route.request().method()==='HEAD' && !ready)await route.fulfill({status:503,body:'publishing'});else await route.continue();});
  let premature=0;const observed=()=>premature++;page.on('framenavigated',observed);
  await page.waitForTimeout(5200);assert.equal(premature,0,'an incomplete release must preserve the working page');
  page.off('framenavigated',observed);ready=true;
  const navigation=page.waitForNavigation({waitUntil:'domcontentloaded'});
  await navigation;
  await page.getByTestId('checkpoint-detail').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('select'),selected);
  assert.equal(new URL(page.url()).searchParams.get('harness'),world.alphaReg.registrationId);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('ocw-ui-reloaded:new-ui-test-release')),'1');
  let repeated=0;page.on('framenavigated',()=>repeated++);
  await page.waitForTimeout(5200);
  assert.equal(repeated,0,'an inconsistent version response cannot cause an endless reload');
  assert.ok(requests>=2);
});

// Optional refactor gate: compare every computed property (including pseudo
// elements) on the same frozen DOM. Supply the original styles.css + graph.css.
test('CSS refactor preserves computed styles across registry and graph interactions', {skip: !process.env.OCW_CSS_BASELINE}, async context => {
  const world = await setupWorld(context);
  const page = await world.browser.newPage({ viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce' });
  const baseline = await readFile(process.env.OCW_CSS_BASELINE, 'utf8');
  const current = (await Promise.all(['styles.css','graph.css'].map(name => readFile(join(appRoot,'src',name),'utf8')))).join('\n');
  async function compare(label) {
    const differences = await page.evaluate(({baseline,current}) => {
      const sheets = [...document.styleSheets];
      const disabled = sheets.map(sheet => sheet.disabled);
      sheets.forEach(sheet => {sheet.disabled = true;});
      const override = document.createElement('style');
      document.head.append(override);
      const freeze = '\n*,*::before,*::after { animation:none !important; transition:none !important; caret-color:transparent !important; }';
      const elements = [...document.body.querySelectorAll('*')];
      function capture(css) {
        override.textContent = css + freeze;
        return elements.flatMap(element => [null,'::before','::after'].map(pseudo => {
          const style = getComputedStyle(element,pseudo);
          return Object.fromEntries([...style].map(key => [key,style.getPropertyValue(key)]));
        }));
      }
      try {
        const before = capture(baseline), after = capture(current), differences = [];
        before.forEach((properties,index) => {
          for (const key of Object.keys(properties)) if(properties[key] !== after[index][key]) differences.push({
            element:elements[Math.floor(index/3)].outerHTML.slice(0,220), pseudo:index%3, property:key, before:properties[key], after:after[index][key],
          });
        });
        return differences.slice(0,12);
      } finally {
        override.remove(); sheets.forEach((sheet,index) => {sheet.disabled = disabled[index];});
      }
    }, {baseline,current});
    assert.deepEqual(differences, [], label);
  }
  await page.goto(BASE);
  await page.locator('.harness-card').first().waitFor();
  await compare('registry desktop');
  await page.goto(`${BASE}/?demo=paths`);
  await page.locator('.checkpoint-point').first().waitFor();
  await page.getByRole('button',{name:'暂停演示',exact:true}).click();
  await page.getByRole('button',{name:'收起路径',exact:true}).click();
  await compare('folded paths and ALL checkpoints');
  await page.getByRole('button',{name:'展开路径',exact:true}).click();
  await compare('parallel paths');
  await page.locator('.path-line-label').first().click();
  await page.getByTestId('edge-detail').waitFor();
  await compare('path inspector');
  await page.keyboard.press('Escape');
  await page.locator('.checkpoint-point[data-status="active"]').first().click();
  await page.getByTestId('checkpoint-detail').waitFor();
  await compare('working checkpoint inspector');
  await page.locator('.checkpoint-point[data-status="active"]').first().hover();
  await compare('hover');
  await page.evaluate(() => {document.documentElement.dataset.theme='dark';});
  await compare('dark theme');
  await page.setViewportSize({width:390,height:844});
  await compare('mobile dark inspector');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {document.documentElement.dataset.theme='light';});
  await compare('mobile light graph');
});
