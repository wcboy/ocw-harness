import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
const hash = value => createHash('sha256').update(value).digest('hex');

/** Recoverable observer data only. Never load it as executor authority. */
export class SnapshotStore {
  constructor(directory) { this.directory = directory; }
  path(key) { return join(this.directory, hash(key) + '.json'); }
  async load(key) {
    try {
      const record = JSON.parse(await readFile(this.path(key), 'utf8'));
      if (record.schema !== 'ocw-observer-cache-1' || record.key !== key || hash(record.payload) !== record.sha256) return null;
      const saved = JSON.parse(record.payload);
      if (!saved.value?.task?.id || !Number.isFinite(Date.parse(saved.verifiedAt))) return null;
      return saved;
    } catch { return null; }
  }
  async save(key, value, verifiedAt) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(key);
    const temporary = target + '.' + randomUUID() + '.tmp';
    const payload = JSON.stringify({ value, verifiedAt });
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ schema: 'ocw-observer-cache-1', key, payload, sha256: hash(payload) }));
      await file.sync(); await file.close(); file = null;
      await rename(temporary, target);
      const dir = await open(this.directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
  }
}
