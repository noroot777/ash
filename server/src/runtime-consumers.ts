import type { OutputCheckpoint } from "./executors/output-checkpoint.js";

const consumers = new Map<string, { checkpoint: () => OutputCheckpoint; available: () => boolean }>();

export function registerRuntimeConsumer(session: string, checkpoint: () => OutputCheckpoint, available: () => boolean): () => void {
  const consumer = { checkpoint, available };
  consumers.set(session, consumer);
  return () => { if (consumers.get(session) === consumer) consumers.delete(session); };
}

export function runtimeConsumerAvailable(session: string): boolean {
  return consumers.get(session)?.available() === true;
}

export function checkpointRuntimeConsumer(session: string): OutputCheckpoint {
  const checkpoint = consumers.get(session);
  if (!checkpoint) throw new Error("会话消费循环尚未就绪或正在结算，未切换服务");
  if (!checkpoint.available()) throw new Error("会话没有可验证的输出消费屏障或仍有未持久化状态");
  return checkpoint.checkpoint();
}
