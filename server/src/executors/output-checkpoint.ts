import type { ChildProcess } from "node:child_process";

export type OutputCheckpoint = { ready: Promise<void>; resume(): void };
export type CheckpointChild = ChildProcess & {
  naviSuspend?: () => () => void;
  naviCheckpointQueue?: () => OutputCheckpoint;
};

export function supportsOutputCheckpoint(child: ChildProcess): boolean {
  const source = child as CheckpointChild;
  return typeof source.naviSuspend === "function" && typeof source.naviCheckpointQueue === "function";
}

export function checkpointOutput(child: ChildProcess): OutputCheckpoint {
  const source = child as CheckpointChild;
  if (!source.naviSuspend || !source.naviCheckpointQueue) throw new Error("执行器没有可验证的输出消费屏障");
  const resumeInput = source.naviSuspend();
  let queue: OutputCheckpoint | undefined;
  let resumed = false;
  return {
    ready: new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      if (resumed) throw new Error("输出冻结已撤销");
      queue = source.naviCheckpointQueue!();
      await queue.ready;
      if (resumed) throw new Error("输出冻结已撤销");
    }),
    resume() {
      resumed = true;
      queue?.resume();
      resumeInput();
    },
  };
}
