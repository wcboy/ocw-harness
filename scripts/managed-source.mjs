import { readFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, sep } from 'node:path';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Restore mappings are registration metadata, never edits to historical evidence. */
export function restoredArtifact(ref, mappings = {}) {
  if (typeof ref !== 'string') return ref;
  for (const [before, after] of Object.entries(mappings).sort((a, b) => b[0].length - a[0].length)) {
    if (typeof after === 'string' && (ref === before || ref.startsWith(before + sep))) return after + ref.slice(before.length);
  }
  return ref;
}

/** Pin exactly one immutable generation before reading any canonical document. */
export async function managedSource(source, read = path => readFile(path, 'utf8')) {
  const headPath = join(source, 'ocw-head.json');
  try { await lstat(headPath); } catch (error) {
    if (error.code === 'ENOENT') return { root: source, dataEpoch: 0, execution: null };
    throw error;
  }
  const head = JSON.parse(await read(headPath));
  if (head.schema !== 'ocw-head-1' || !Number.isSafeInteger(head.dataEpoch) || head.dataEpoch < 1 || !/^generations\/[A-Za-z0-9-]+$/.test(head.generation)) throw new Error('invalid executor head');
  const root = await realpath(resolve(source, head.generation));
  const boundary = await realpath(source);
  if (!root.startsWith(boundary + sep)) throw new Error('generation escapes source');
  const raw = await read(join(root, 'manifest.json'));
  if (sha(raw) !== head.sha256) throw new Error('generation manifest digest mismatch');
  const manifest = JSON.parse(raw);
  if (manifest.schema !== 'ocw-generation-1' || manifest.taskId !== head.taskId || manifest.revision !== head.revision || manifest.dataEpoch !== head.dataEpoch) throw new Error('generation identity mismatch');
  for (const required of ['state.json', 'events.jsonl', 'checkpoint-graph.json', 'decision.json', 'execution.json']) {
    if (!manifest.files?.[required]) throw new Error('generation is missing ' + required);
  }
  // Every declared file is immutable and checked, including evidence references.
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = await realpath(resolve(root, name));
    if (!path.startsWith(root + sep)) throw new Error('manifest file escapes generation');
    if (sha(await read(path)) !== expected) throw new Error('generation file digest mismatch: ' + name);
  }
  const state = JSON.parse(await read(join(root, 'state.json')));
  if (state.task_id !== head.taskId || state.revision !== head.revision) throw new Error('generation state mismatch');
  return { root, dataEpoch: head.dataEpoch, execution: JSON.parse(await read(join(root, 'execution.json'))) };
}
