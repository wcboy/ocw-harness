import type { HarnessRegistrySnapshot } from './types';
import { useReadOnlyStream } from './useReadOnlyStream';
const identity = (snapshot: HarnessRegistrySnapshot) => ({ ...snapshot.runtime, revision: snapshot.revision });
const fingerprint = (snapshot: HarnessRegistrySnapshot) => JSON.stringify([snapshot.revision, snapshot.runtime]);
export function useHarnessRegistry() {
  const launch = new URLSearchParams(window.location.search).get('launch');
  const query = launch ? `&launch=${encodeURIComponent(launch)}` : '';
  const result = useReadOnlyStream<HarnessRegistrySnapshot>('registry', {
    url: `/api/registry${launch ? `?launch=${encodeURIComponent(launch)}` : ''}`,
    stream: `/api/stream?channel=registry${query}`, event: 'registry', identity, fingerprint,
  });
  return { ...result, registry: result.data };
}
