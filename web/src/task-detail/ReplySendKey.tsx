import type { ReactNode } from "react";
import type { TaskListItem } from "@ash/shared";
import { LaterSendKey, type LaterSend } from "../components/LaterSend.tsx";
import { ReplyDockSend } from "./ReplyDock.tsx";
import { CALL_COPY, type ReplyCall } from "./replyCall.ts";

/**
 * 回复框那颗发送键这一按叫什么。只有一颗，三种脸：
 * - 框被裁定借着、选了一档：那一档自己的键（「让它接着改」…）；
 * - 叫了人、派出去 / 讨论：实心带字「派出去」「开始讨论」——立即办，没有「稍后」可选，任务在跑也不变成
 *   停止键（敲着命令时除外：那一按是补全 / 打开配置，按平常那颗写）；
 * - 其余是平常那颗（立即 / 稍后 + 停止）；叫了人问一句时键上写「问 codex」。
 */
export function ReplySendKey({
  overrideSend, call, callHeld, later, text, attachments, uploading, queueing, sending, blocked,
  override, onSend, onStop, stopTip, stopBlocked, stopping, configDisabled, tasks, projectId, taskId,
}: {
  /** 裁定那一行选了一档时顶替发送键的那颗。 */
  overrideSend: ReactNode | null;
  call: ReplyCall | null;
  /** 派出去 / 讨论还差的那一样（从哪开工还在读、任务正在跑…）；null = 齐了。 */
  callHeld: string | null;
  later: LaterSend;
  text: string;
  attachments: number;
  /** 正在传附件时键上的字；null = 没在传。 */
  uploading: string | null;
  queueing: boolean;
  sending: boolean;
  /** 整个框发不出去的原因（归档、还没跑过…）。 */
  blocked: string | null;
  /** 敲着命令时这颗键干的是别的事（补全、叫人、打开派生配置）。 */
  override: { text: string; action: string } | null;
  onSend: () => void;
  onStop?: () => void;
  stopTip: string;
  stopBlocked: string | null;
  stopping: boolean;
  configDisabled: boolean;
  tasks: TaskListItem[];
  projectId: string;
  taskId: string;
}) {
  if (overrideSend) return <>{overrideSend}</>;
  // 敲着命令时这一按是补全 / 打开配置，不是派出去：交给下面那颗，它会照实写。
  if ((call?.verb === "dispatch" || call?.verb === "discuss") && !override) {
    const dispatching = call.verb === "dispatch";
    const reason = blocked ?? (uploading ? (dispatching ? "附件传完才能派" : "附件传完才能开始")
      : !text.trim() ? (dispatching ? "先写清楚要它做什么" : "先写下要讨论什么") : callHeld);
    return (
      <ReplyDockSend label={CALL_COPY[call.verb].send(call.target.agent)} busy={sending}
        disabled={!!reason} reason={reason} onSend={onSend} />
    );
  }
  return (
    <LaterSendKey
      later={later}
      action="发送回复"
      label={call ? CALL_COPY.ask.send(call.target.agent) : null}
      empty={!text.trim() && !attachments && !uploading}
      queueing={queueing}
      uploading={uploading}
      override={override}
      blocked={blocked}
      busy={sending}
      onSend={onSend}
      onStop={onStop}
      stopTip={stopTip}
      stopBlocked={stopBlocked}
      stopBusy={stopping}
      configDisabled={configDisabled}
      tasks={tasks}
      projectId={projectId}
      taskId={taskId}
    />
  );
}
