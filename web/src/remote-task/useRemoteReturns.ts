import { useCallback, useRef, useState } from "react";
import type { HandoffTarget, Task, TaskListItem } from "@ash/shared";
import { isCapabilityBlocked, normalizedPeerUrl } from "@ash/shared/handoff";
import { api, ApiError } from "../lib/api.ts";

type ReturnOperation = {
  taskId: string;
  transferId: string | null;
  target: HandoffTarget;
  title: string;
  startedAt: number;
  capabilityMessage: string | null;
} & (
  | { status: "pending" }
  | { status: "failed"; error: string | null }
  | { status: "succeeded"; task: Task }
);

function matches(operation: ReturnOperation, archive: TaskListItem, target: HandoffTarget) {
  return operation.transferId === (archive.handoff?.transferId ?? null)
    && normalizedPeerUrl(operation.target.url) === normalizedPeerUrl(target.url);
}

export function useRemoteReturns(notify: (message: string) => void) {
  const [operations, setOperations] = useState(() => new Map<string, ReturnOperation>());
  const operationsRef = useRef(operations);

  const publish = useCallback((operation: ReturnOperation) => {
    const next = new Map(operationsRef.current);
    next.set(operation.taskId, operation);
    operationsRef.current = next;
    setOperations(next);
  }, []);

  const start = useCallback(async (archive: TaskListItem, target: HandoffTarget, ignoreCapabilityGaps = false) => {
    const previous = operationsRef.current.get(archive.id);
    if (previous?.status === "pending") return;
    if (previous?.status === "succeeded" && matches(previous, archive, target)) return;
    const operation: ReturnOperation = {
      taskId: archive.id,
      transferId: archive.handoff?.transferId ?? null,
      target,
      title: archive.title || "未命名任务",
      startedAt: Date.now(),
      capabilityMessage: ignoreCapabilityGaps && previous && matches(previous, archive, target) ? previous.capabilityMessage : null,
      status: "pending",
    };
    publish(operation);
    try {
      const result = await api.remoteTaskReturn(archive.id, target.url, { ignoreCapabilityGaps });
      if (result.task.handoff?.direction === "out") {
        throw new Error("尚未确认任务已移回本机：本机仍保留接力存档。请刷新核对任务位置后再重试，不要在两台机器上重复启动任务。");
      }
      publish({ ...operation, status: "succeeded", task: result.task });
      notify(`「${operation.title}」任务已移回本机`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const blocked = isCapabilityBlocked(reason instanceof ApiError ? reason.body : null);
      publish({
        ...operation,
        status: "failed",
        error: blocked ? null : message,
        capabilityMessage: blocked ? message : operation.capabilityMessage,
      });
      notify(`「${operation.title}」${blocked ? "移回需要确认" : "移回未完成"}：${message}`);
    }
  }, [notify, publish]);

  const get = useCallback((archive: TaskListItem, target: HandoffTarget) => {
    const operation = operations.get(archive.id);
    return operation && (operation.status === "pending" || matches(operation, archive, target)) ? operation : null;
  }, [operations]);

  const dismiss = useCallback((archive: TaskListItem, target: HandoffTarget) => {
    const operation = operationsRef.current.get(archive.id);
    if (operation?.status !== "failed" || !matches(operation, archive, target)) return;
    const next = new Map(operationsRef.current);
    next.delete(archive.id);
    operationsRef.current = next;
    setOperations(next);
  }, []);

  return { get, start, dismiss };
}

export type RemoteReturns = ReturnType<typeof useRemoteReturns>;
