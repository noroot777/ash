import { useState, type RefObject } from "react";
import type { TaskListItem } from "@ash/shared";
import { api } from "../lib/api.ts";
import { AutoTextarea } from "../components/AutoTextarea.tsx";
import { useExecutorGate } from "../task-detail/ExecutorGate.tsx";
import { AcceptLayer } from "./AcceptLayer.tsx";

export type ReturnOutcome = { scheduled: boolean };

/** 打回的意见原样作为真人回复送进原会话（讨论则送回讨论，让双方沿原记录再来一轮）。 */
export async function sendReturn(task: TaskListItem, text: string): Promise<ReturnOutcome> {
  if (task.mode === "duet") {
    await api.gate(task.id, { kind: "inject", text: `【验收打回】请根据以下意见继续讨论，并重新形成可验收结论。\n\n${text}` });
    return { scheduled: false };
  }
  const result = await api.replyTask(task.id, `【验收打回】请继续修改并完成后重新提交验收。\n\n${text}`);
  return { scheduled: "scheduled" in result };
}

/**
 * 「打回」下面那一层：一个输入框，⌘↵ 发出。发出去就是对话里右边那一句，所以成功之后不另给回执
 * （宿主把人送回对话）；只有任务还在跑、意见被排进队列时才说一句。
 */
export function AcceptReject({ task, anchorRef, onClose, onSent, notify }: {
  task: TaskListItem;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSent: (outcome: ReturnOutcome) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmExecutorSwap = useExecutorGate();
  const duet = task.mode === "duet";
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    if (!(await confirmExecutorSwap(task.id))) return;
    setBusy(true);
    let outcome: ReturnOutcome;
    try {
      outcome = await sendReturn(task, body);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
      return;
    }
    // 已经投递出去了：先收掉这一层和意见，再去刷新 —— 刷新失败也不能让人以为没打回、照着再发一遍。
    setText("");
    setBusy(false);
    onClose();
    await onSent(outcome);
  };
  return (
    <AcceptLayer open anchorRef={anchorRef} onClose={() => { if (!busy) onClose(); }} label={duet ? "打回再讨论" : "打回"} align="end" className="acc-layer-reject">
      <AutoTextarea className="acc-reject-input" value={text} autoFocus rows={4} aria-label="打回意见"
        placeholder={duet ? "还要讨论什么" : "哪里要改"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }} />
      <footer>
        <span className="acc-layer-note">⌘↵ 发送</span>
        <button type="button" className="acc-btn is-primary" disabled={busy || !text.trim()} aria-busy={busy || undefined} onClick={() => void send()}>
          {busy && <i className="acc-spin" aria-hidden="true" />}{duet ? "发回讨论" : "发给任务"}
        </button>
      </footer>
    </AcceptLayer>
  );
}
