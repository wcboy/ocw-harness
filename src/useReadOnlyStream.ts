import { useEffect, useRef, useState, useCallback } from 'react';
import type { ConnectionStatus } from './types';
import { FrameGate, type FrameIdentity } from './sync-state';

interface StreamConfig<T> {
  url: string;
  stream: string;
  event: string;
  identity: (data: T) => FrameIdentity;
  fingerprint: (data: T) => string;
}

export function useReadOnlyStream<T>(key: string | null, config: StreamConfig<T>) {
  const [data, setData] = useState<T | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [lastReceivedAt, setLastReceivedAt] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const { url, stream: streamUrl, event, identity, fingerprint } = config;
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let streamOpen = false;
    let lastFingerprint = '';
    let controller: AbortController | null = null;
    const gate = new FrameGate();
    setData(null); setError(null); setLastReceivedAt(null); setConnection(key ? 'connecting' : 'offline');
    if (!key) { refreshRef.current = () => {}; return; }
    const apply = (next: T) => {
      if (!active) return;
      const frame = identity(next);
      if (frame.registrationId && frame.registrationId !== key) return;
      if (!gate.accept(frame)) { setError('收到旧版本或来源身份不匹配的数据，已保留当前状态'); return; }
      setLastReceivedAt(new Date().toISOString()); setError(null);
      setConnection(streamOpen ? 'live' : 'polling');
      const signature = fingerprint(next);
      if (signature !== lastFingerprint) { lastFingerprint = signature; setData(next); }
    };
    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 4000);
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`数据读取失败 (${response.status})`);
        apply(await response.json() as T);
      } catch (reason) {
        if (active) { setError(reason instanceof Error ? reason.message : '数据读取失败'); setConnection(streamOpen ? 'reconnecting' : 'offline'); }
      } finally { window.clearTimeout(timeout); inFlight = false; }
    };
    refreshRef.current = () => void poll();
    void poll();
    const source = new EventSource(streamUrl);
    source.onopen = () => { if (active) { streamOpen = true; setConnection('live'); } };
    source.addEventListener(event, message => {
      try { apply(JSON.parse((message as MessageEvent<string>).data) as T); }
      catch { if (active) { setError('实时数据无法解析'); setConnection('reconnecting'); } }
    });
    source.addEventListener('source-error', message => {
      if (!active) return;
      let text = '数据源暂时不可用，保留上次已验证状态';
      try { text = JSON.parse((message as MessageEvent<string>).data).message || text; } catch { /* use readable fallback */ }
      setError(text); setConnection('reconnecting');
    });
    source.onerror = () => { if (active) { streamOpen = false; setConnection('reconnecting'); } };
    const interval = window.setInterval(() => void poll(), 1000);
    return () => { active = false; controller?.abort(); source.close(); window.clearInterval(interval); refreshRef.current = () => {}; };
  }, [key, url, streamUrl, event, identity, fingerprint]);
  return { data, connection, error, lastReceivedAt, refresh };
}
