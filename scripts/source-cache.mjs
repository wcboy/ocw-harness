/** Shared, bounded work. Timed-out callers do not start another underlying job. */
export class SourceCache {
  constructor({ concurrency = 4, timeoutMs = 2000, store = null } = {}) {
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.active = 0;
    this.queue = [];
    this.entries = new Map();
    this.builds = 0;
    this.store = store;
  }
  schedule(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.drain();
    });
  }
  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { this.active--; this.drain(); });
    }
  }
  async read(key, fingerprint, build) {
    let entry = this.entries.get(key);
    if (!entry) { entry = {}; this.entries.set(key, entry); }
    if (entry.fingerprint === fingerprint && entry.value) return { value: entry.value, verifiedAt: entry.verifiedAt, persistenceError: entry.persistenceError };
    if (entry.failedFingerprint === fingerprint && Date.now() < (entry.retryAt || 0)) {
      if (entry.value) return { value: entry.value, verifiedAt: entry.verifiedAt, error: entry.error };
      throw new Error(entry.error);
    }
    if (!entry.pending) {
      entry.pending = this.schedule(async () => {
        if (!entry.loaded) {
          const saved = await this.store?.load(key);
          if (saved) { entry.value = saved.value; entry.verifiedAt = saved.verifiedAt; }
          entry.loaded = true;
        }
        this.builds++;
        const value = await build();
        if (entry.value && ((value.runtime?.dataEpoch || 0) < (entry.value.runtime?.dataEpoch || 0) ||
          ((value.runtime?.dataEpoch || 0) === (entry.value.runtime?.dataEpoch || 0) && value.task?.revision < entry.value.task?.revision))) {
          throw new Error('数据版本回退；恢复必须产生新的 dataEpoch');
        }
        entry.error = null; entry.retryAt = 0;
        entry.value = value;
        entry.fingerprint = fingerprint;
        entry.verifiedAt = new Date().toISOString();
        // Cache failure must not hide a valid source; expose it separately.
        entry.persistenceError = null;
        try { await this.store?.save(key, value, entry.verifiedAt); } catch (error) { entry.persistenceError = error.message; }
        return value;
      }).catch(error => {
        entry.error = error.message; entry.failedFingerprint = fingerprint; entry.retryAt = Date.now() + 1000; throw error;
      }).finally(() => { entry.pending = null; });
    }
    let timeout;
    try {
      await Promise.race([entry.pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('数据源读取超时')), this.timeoutMs); })]);
      // A previous generation may have been in flight; never label it current.
      if (entry.fingerprint !== fingerprint) return { value: entry.value, verifiedAt: entry.verifiedAt, error: '新一代数据等待验证' };
      return { value: entry.value, verifiedAt: entry.verifiedAt, persistenceError: entry.persistenceError };
    } catch (error) {
      if (!entry.value) throw error;
      return { value: entry.value, verifiedAt: entry.verifiedAt, error: error.message };
    } finally { clearTimeout(timeout); }
  }
  invalidate(key) { const entry = this.entries.get(key); if (entry) entry.fingerprint = null; }
}
