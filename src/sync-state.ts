export interface FrameIdentity {
  bindingId: string;
  startedAt: string;
  registrationId?: string;
  taskId?: string;
  revision: number;
  dataEpoch?: number;
  sourceObservationSeq?: number;
  observationSeq?: number;
}

/** A new connection is not permission to roll canonical progress backwards. */
export class FrameGate {
  private latest: FrameIdentity | null = null;
  accept(next: FrameIdentity) {
    if (!next.bindingId || !Number.isFinite(next.revision) || !Number.isFinite(Date.parse(next.startedAt))) return false;
    const epoch = next.dataEpoch ?? 0;
    if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
    if ([next.sourceObservationSeq, next.observationSeq].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return false;
    const previous = this.latest;
    if (previous) {
      if (previous.registrationId !== next.registrationId || previous.taskId !== next.taskId) return false;
      if (next.bindingId !== previous.bindingId && Date.parse(next.startedAt) <= Date.parse(previous.startedAt)) return false;
      if (epoch < (previous.dataEpoch ?? 0)) return false;
      if (epoch === (previous.dataEpoch ?? 0) && next.revision === previous.revision && (next.sourceObservationSeq ?? 0) < (previous.sourceObservationSeq ?? 0)) return false;
      if (next.bindingId === previous.bindingId && (next.observationSeq ?? 0) < (previous.observationSeq ?? 0)) return false;
      if (epoch === (previous.dataEpoch ?? 0) && (next.registrationId || next.bindingId === previous.bindingId) && next.revision < previous.revision) return false;
    }
    this.latest = next;
    return true;
  }
}
