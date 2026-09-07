import type { WorkflowSnapshot } from './types';
import { useReadOnlyStream } from './useReadOnlyStream';
const identity = (snapshot: WorkflowSnapshot) => ({ ...snapshot.runtime, taskId: snapshot.task.id, revision: snapshot.task.revision });
const fingerprint = (snapshot: WorkflowSnapshot) => {
  const { observationSeq: _sequence, ...runtime } = snapshot.runtime;
  return JSON.stringify([
  snapshot.contentFingerprint, snapshot.task.revision, runtime, snapshot.sourceStatus, snapshot.sourceError,
]); };
export function useWorkflowStream(registrationId: string | null) {
  const query = encodeURIComponent(registrationId || '');
  const result = useReadOnlyStream<WorkflowSnapshot>(registrationId, {
    url: `/api/snapshot?harness=${query}`, stream: `/api/stream?harness=${query}`, event: 'snapshot', identity, fingerprint,
  });
  return { ...result, snapshot: result.data };
}
