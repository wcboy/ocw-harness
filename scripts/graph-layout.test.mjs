import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importSource(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
const { pathTone, shortPathLabel, buildConnections } = await importSource("graph-layout");
const { createDemoSnapshot, demoSteps } = await importSource("demo");
const ports = new Map([
  ["root", { x: 0, y: 120, width: 160, column: 0 }],
  ["a", { x: 400, y: 100, width: 238, column: 1 }],
  ["b", { x: 400, y: 500, width: 238, column: 1 }],
  ["c", { x: 900, y: 300, width: 238, column: 2 }],
]);
const paths = [{ id: "p1", selected: true, status: "succeeded" }, { id: "p2", selected: false, status: "failed" }, { id: "p3", selected: false, status: "inconclusive" }];
const edge = { id: "edge", from: ["root"], to: "a", paths };

test("path verdict overrides stale selection; unselected feasible is distinct from pending", () => {
  assert.equal(pathTone(paths[0]), "adopted");
  for (const status of ["failed", "refuted", "invalidated"]) assert.equal(pathTone({ selected: true, status }), "refuted");
  assert.equal(pathTone(paths[2]), "pending");
  assert.equal(pathTone({ selected: false, status: "succeeded" }), "feasible");
  assert.equal(pathTone({ selected: false, status: "unexpected" }), "pending");
});

test("alternatives are distinct lanes sharing exactly the same endpoints", () => {
  const result = buildConnections([edge], ports, new Set(["a"]), new Map([["a", 260]]));
  assert.equal(result.wires.length, 3);
  assert.equal(new Set(result.wires.map(w => w.d)).size, 3);
  assert.equal(new Set(result.wires.map(w => [w.sourceX, w.sourceY, w.targetX, w.targetY].join())).size, 1);
  assert.deepEqual(result.wires.map(w => w.tone), ["adopted", "refuted", "pending"]);
  assert.deepEqual(result.wires.map(w => w.labelY), [68, 110, 152]);
});

test("AND prerequisites join once before alternatives, never an N times M fanout", () => {
  const result = buildConnections([{ ...edge, from: ["a", "b"], to: "c" }], ports, new Set(["c"]), new Map([["c", 260]]));
  assert.equal(result.joins.length, 1);
  assert.equal(result.joins[0].count, 2);
  const inputs = result.wires.filter(w => w.kind === "dependency");
  const alternatives = result.wires.filter(w => w.kind === "path");
  assert.equal(inputs.length, 2);
  assert.equal(alternatives.length, 3);
  for (const wire of inputs) assert.equal(wire.targetX, result.joins[0].x);
  for (const wire of alternatives) assert.equal(wire.sourceX, result.joins[0].x);
});

test("collapsed and empty alternatives still connect; missing endpoints are never fabricated", () => {
  assert.equal(buildConnections([edge], ports, new Set(), new Map()).wires.length, 1);
  assert.equal(buildConnections([{ ...edge, from: ["missing"] }], ports, new Set(["a"]), new Map()).wires.length, 0);
  const empty = buildConnections([{ ...edge, from: ["a", "b"], to: "c", paths: [] }], ports, new Set(["c"]), new Map());
  assert.equal(empty.wires.length, 3);
  assert.equal(empty.wires.at(-1).targetX, ports.get("c").x);
});

test("skip-layer dependencies route around intermediate groups before alternatives", () => {
  const result = buildConnections([{ ...edge, from: ["root"], to: "c" }], ports, new Set(["c"]), new Map([["c", 260]]));
  assert.equal(result.joins.length, 0, "a single prerequisite is not an AND junction");
  assert.equal(result.wires.filter(w => w.kind === "dependency").length, 1);
  for (const wire of result.wires.filter(w => w.kind === "path")) assert.ok(wire.sourceX > ports.get("a").x + ports.get("a").width);
});

test("short labels prefer explicit human names and preserve Unicode", () => {
  assert.equal(shortPathLabel({ shortLabel: "版本投影", label: "Long description" }), "版本投影");
  assert.equal(shortPathLabel({ label: "🟢".repeat(14) }), "🟢".repeat(12) + "…");
});

test("demo projections agree at every step and obey the AND gate", () => {
  for (let step = 0; step < demoSteps.length; step++) {
    const snapshot = createDemoSnapshot(step);
    const checks = snapshot.groups.flatMap(g => g.checkpoints);
    assert.equal(snapshot.metrics.checkpointsComplete, checks.filter(cp => cp.status === "complete").length);
    assert.ok(checks.every(cp => cp.statusSource === "demo"));
    assert.equal(snapshot.runtime.required, false);
    assert.equal(snapshot.runtime.registrationId, "");
    assert.equal(snapshot.agentActivity.workingCount, checks.filter(cp => cp.worker?.working).length);
    assert.equal(snapshot.journey.layers[1].nodes[0].status === "pending", step < 4);
    if (step >= 4) assert.ok(snapshot.groups.slice(0, 2).every(g => g.checkpoints.every(cp => cp.status === "complete")));
    assert.ok(snapshot.metrics.checkpointsComplete < 9, "the example remains an ongoing task");
  }
});
