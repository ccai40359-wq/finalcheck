// A query response and live packets share one per-invocation sequence. Never replay a
// delta already contained in a snapshot or accept an old invocation's late packet.
export function acceptRunPacket(run, packet) {
  if (!run) return false;
  if (!packet?.runId) return !run.reattached; // compatibility with old IPC/test clients
  if (run.runId && run.runId !== packet.runId) return false;
  if (Number.isFinite(packet.seq) && Number.isFinite(run.seq) && packet.seq <= run.seq) return false;
  run.runId = packet.runId;
  if (Number.isFinite(packet.seq)) run.seq = packet.seq;
  return true;
}

export function reattachedRun(snapshot) {
  if (!snapshot || typeof snapshot.runId !== 'string' || !Number.isFinite(snapshot.seq)) return null;
  return { ...snapshot, reattached: true };
}
