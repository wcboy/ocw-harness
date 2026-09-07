/** Full snapshots may be coalesced; history remains in canonical events. */
export function attachSseWriter(response, { maxBytes = 1048576, stallMs = 10000 } = {}) {
  let blocked = false;
  let pending = null;
  let timer = null;
  let closed = false;
  const cleanup = () => { closed = true; pending = null; clearTimeout(timer); };
  response.on('close', cleanup);
  response.on('error', () => { cleanup(); response.destroy(); });
  const send = frame => {
    if (closed || response.destroyed || response.writableEnded) return;
    if (Buffer.byteLength(frame) > maxBytes || response.writableLength > maxBytes) { cleanup(); response.destroy(); return; }
    if (blocked) { pending = frame; return; }
    if (!response.write(frame)) {
      blocked = true;
      timer = setTimeout(() => { cleanup(); response.destroy(); }, stallMs);
      timer.unref?.();
    }
  };
  response.on('drain', () => {
    blocked = false; clearTimeout(timer);
    const latest = pending; pending = null;
    if (latest) send(latest);
  });
  return send;
}
