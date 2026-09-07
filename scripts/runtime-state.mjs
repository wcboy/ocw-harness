import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const processCache = new Map();

export function terminalOutcome(phase) {
  const value = String(phase || '').toLowerCase();
  if (['complete', 'completed', 'passed'].includes(value)) return 'complete';
  if (['failed', 'error', 'terminated'].includes(value)) return 'failed';
  if (['cancelled', 'canceled', 'interrupted'].includes(value)) return 'cancelled';
  return null;
}

export async function registrationLiveness(record) {
  if (record.lifecycle === 'closed') return 'closed';
  const pid = record.processId;
  if (pid) {
    try { process.kill(pid, 0); } catch (error) { if (error.code !== 'EPERM') return 'lost'; }
    if (record.processStartedAt) {
      let cached = processCache.get(pid);
      if (!cached || Date.now() - cached.at > 2000) {
        cached = { at: Date.now(), pending: run('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 1000 }).then(r => r.stdout.trim()).catch(() => null) };
        processCache.set(pid, cached);
        if (processCache.size > 512) processCache.delete(processCache.keys().next().value);
      }
      cached.value = await cached.pending;
      if (!cached.value) return 'unknown';
      if (cached.value !== record.processStartedAt) return 'lost';
    }
  }
  if (record.heartbeatSeq > 0) {
    const age = Date.now() - Date.parse(record.heartbeatAt);
    if (!Number.isFinite(age) || age < -5000) return 'unknown';
    return age <= 30000 ? 'live' : age <= 90000 ? 'suspect' : 'lost';
  }
  return pid && record.processStartedAt ? 'live' : 'unknown';
}

export function workerKey(worker, taskSource) {
  // A name is only comparable within one canonical task source.
  return `${taskSource}\0${worker.workerInstanceId || worker.agentRef || `unknown:${worker.assignmentId}`}`;
}

export function projectActivity(snapshot, liveness) {
  const terminal = terminalOutcome(snapshot.task.phase);
  const assignments = snapshot.agentActivity.assignments.map(worker => {
    const declaredWorking = worker.declaredWorking ?? worker.working;
    const leaseLive = !worker.leaseExpiresAt || Date.parse(worker.leaseExpiresAt) > Date.now();
    const working = !terminal && declaredWorking && liveness === 'live' && leaseLive;
    return { ...worker, declaredWorking, working, liveness: leaseLive ? liveness : 'lost',
      workState: terminal === 'complete' ? 'complete' : terminal ? 'attention' : declaredWorking && !working ? 'unknown' : worker.workState,
      ownership: worker.sessionId ? 'session' : 'task_shared',
    };
  });
  const byId = new Map(assignments.map(worker => [worker.assignmentId, worker]));
  function replace(value) {
    if (!value || typeof value !== 'object') return value;
    if (value.assignmentId && byId.has(value.assignmentId)) return { ...value, ...byId.get(value.assignmentId) };
    if (Array.isArray(value)) return value.map(replace);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
  }
  const next = replace(snapshot);
  const working = assignments.filter(worker => worker.working);
  next.agentActivity = {
    assignments, workingCount: new Set(working.map(worker => workerKey(worker, snapshot.sourceRoot))).size,
    activeAssignmentCount: working.length,
    unverifiedAssignmentCount: assignments.filter(worker => worker.declaredWorking && !worker.working && !terminal).length,
  };
  return next;
}
