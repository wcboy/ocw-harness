import type { JourneyEdge, PathAttempt } from "./types";

export type PathTone = "adopted" | "refuted" | "pending" | "feasible";
export type GraphPort = { x: number; y: number; width: number; column: number };
export type GraphWire = { id: string; edge: string; d: string; kind: "dependency" | "path" | "summary"; tone?: PathTone; attempt?: PathAttempt; labelX?: number; labelY?: number; working: boolean; sourceX: number; sourceY: number; targetX: number; targetY: number };
export type GraphJoin = { id: string; x: number; y: number; count: number };

export function pathTone(path: Pick<PathAttempt, "status" | "selected">): PathTone {
  if (["failed", "refuted", "invalidated"].includes(path.status)) return "refuted";
  if (path.selected) return "adopted";
  if (["succeeded", "feasible_unselected"].includes(path.status)) return "feasible";
  return "pending";
}
export const pathToneLabel: Record<PathTone, string> = { adopted: "已采纳", refuted: "已证伪", pending: "待定", feasible: "可行未选" };
export function shortPathLabel(path: PathAttempt): string {
  const label = path.shortLabel || path.label || path.id;
  return Array.from(label).length > 12 ? Array.from(label).slice(0, 12).join("") + "…" : label;
}

/** Shared endpoints with a separate, labelled lane for each alternative. */
export function parallelPath(x: number, y: number, end: number, endY: number, laneY: number) {
  const lead = Math.min(42, (end - x) / 4);
  return `M${x},${y} C${x + lead},${y} ${x + lead},${laneY} ${x + lead * 1.5},${laneY} L${end - lead * 1.5},${laneY} C${end - lead},${laneY} ${end - lead},${endY} ${end},${endY}`;
}

export function buildConnections(edges: JourneyEdge[], ports: Map<string, GraphPort>, expanded: Set<string>, gaps: Map<string, number>) {
  const wires: GraphWire[] = [], joins: GraphJoin[] = [];
  edges.forEach((edge, edgeIndex) => {
    const to = ports.get(edge.to);
    if (!to) return;
    const sources = edge.from.map(id => ({ id, port: ports.get(id) }));
    // Missing endpoints stay missing, rather than being fabricated as root links.
    if (sources.some(source => !source.port)) return;
    const from = sources[0]?.port;
    if (!from) return;
    const open = expanded.has(edge.to);
    const gap = gaps.get(edge.to) || 100;
    // For a long dependency, approach the target gap above intervening groups
    // before fanning out. Otherwise alternatives would cross unrelated nodes.
    const junction = sources.length > 1 || to.column - from.column > 1 ? { x: to.x - gap + 28, y: to.y } : null;
    if (junction && sources.length > 1) joins.push({ id: edge.id, ...junction, count: sources.length });
    for (const source of sources) {
      const p = source.port!;
      if (junction || !open || !edge.paths.length) {
        const x = p.x + p.width, end = junction?.x ?? to.x, endY = junction?.y ?? to.y;
        const skip = to.column - p.column > 1;
        const lane = 22 + edgeIndex * 10;
        const mid = (x + end) / 2;
        const d = skip ? `M${x},${p.y} C${x + 22},${p.y} ${x + 22},${lane} ${x + 42},${lane} L${end - 30},${lane} C${end - 18},${lane} ${end - 18},${endY} ${end},${endY}` : `M${x},${p.y} C${mid},${p.y} ${mid},${endY} ${end},${endY}`;
        wires.push({ id: `${edge.id}:input:${source.id}`, edge: edge.id, d, kind: "dependency", working: false, sourceX: x, sourceY: p.y, targetX: end, targetY: endY });
      }
    }
    const x = junction?.x ?? from.x + from.width, y = junction?.y ?? from.y;
    if (open && edge.paths.length) {
      edge.paths.forEach((attempt, index) => {
        const laneY = (y + to.y) / 2 + (index - (edge.paths.length - 1) / 2) * 42;
        wires.push({ id: `${edge.id}:path:${attempt.id}`, edge: edge.id, kind: "path", d: parallelPath(x, y, to.x, to.y, laneY), tone: pathTone(attempt), attempt,
          labelX: (x + to.x) / 2, labelY: laneY, working: Boolean(attempt.worker?.working), sourceX: x, sourceY: y, targetX: to.x, targetY: to.y });
      });
    } else if (junction) {
      wires.push({ id: `${edge.id}:output`, edge: edge.id, kind: "dependency", d: `M${x},${y} L${to.x},${to.y}`, working: false, sourceX: x, sourceY: y, targetX: to.x, targetY: to.y });
    }
  });
  return { wires, joins };
}
