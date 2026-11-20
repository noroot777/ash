import type { OutputCheckpoint } from "./executors/output-checkpoint.js";

const consumers = new Map<string, () => OutputCheckpoint>();

export function registerRuntimeConsumer(session: string, checkpoint: () => OutputCheckpoint): () => void {
  consumers.set(session, checkpoint);
  return () => { if (consumers.get(session) === checkpoint) consumers.delete(session); };
}

export function checkpointRuntimeConsumer(session: string): OutputCheckpoint {
  const checkpoint = consumers.get(session);
  if (!checkpoint) throw new Error("会话消费循环尚未就绪或正在结算，未切换服务");
  return checkpoint();
}
