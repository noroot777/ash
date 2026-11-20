// 计划定稿后的那张「实施此计划？」：跟答题卡同一种占位——展开时它就是回复框（QuestionSlot.tsx 那套
// covering），收起时缩成一行、平常的回复框回到它下面。两条路都在卡里：第一行直接实施；最后一行写
// 要怎么改，发出去仍是计划模式下的一句普通回复，由出这份计划的同一个执行器接着改。
import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, CaretDown, PencilSimple } from "@phosphor-icons/react";
import type { AgentType, Task } from "@navi/shared";
import { taskInteractionAvailability } from "@navi/shared/task-interaction";
import type { ConversationItem } from "./conversationModel.ts";
import type { ProposedPlanData } from "../components/ProposedPlan.tsx";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";
import { isSendKeyEvent } from "../lib/sendKey.ts";
import { AttachmentPicker, UploadAttachmentList, uploadingLabel, useAttachments } from "./Attachments.tsx";
import "../components/proposed-plan.css";

export type ReadyPlan = {
  plan: ProposedPlanData;
  agentType: AgentType;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
};

export function readyPlanFor(task: Task, items: ConversationItem[]): ReadyPlan | null {
  if (!task.planMode || task.mode !== "single" || taskInteractionAvailability(task) === "archived" || task.question || ["running", "queued"].includes(task.status)) return null;
  const last = [...items].reverse().find((item) => item.kind === "agent");
  if (!last || last.kind !== "agent" || last.sessionRole !== "single" || !last.endedAt || last.interrupted || last.reviewer) return null;
  if (last.turnOutcome === "failed" || last.turnOutcome === "stopped" || last.session?.stoppedAs || (!last.turnOutcome && (last.session?.exitStatus ?? 0) !== 0)) return null;
  const executorId = last.session?.executorId ?? null;
  const scope = task.planScopes?.find((entry) => entry.agentType === last.agentType && entry.executorId === executorId);
  if (!scope) return null;
  const plan = last.segments.flatMap((segment) => segment.events).filter((event) => event.plan).at(-1)?.plan;
  if (!plan || plan.status !== "complete" || !plan.text.trim()) return null;
  return { plan, agentType: scope.agentType, executorId, model: last.run?.model ?? null, reasoningEffort: last.run?.reasoningEffort ?? null };
}

export type PlanTakeover = {
  ready: ReadyPlan | null;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  covering: boolean;
};

const COLLAPSED_STORAGE = "navi:plan-ready-collapsed";
const readCollapsed = () => { try { return sessionStorage.getItem(COLLAPSED_STORAGE); } catch { return null; } };

/**
 * 收起记在这一份计划上：改出新的一版就重新展开。跟答题卡不同，它记进 sessionStorage——这张卡会在那儿
 * 摆到你决定为止（可能隔几天），收起来接着聊、刷新一下又整张弹回来挡住回复框，是打扰。
 */
export function usePlanTakeover(taskId: string, ready: ReadyPlan | null): PlanTakeover {
  const [collapsedKey, setCollapsedKey] = useState<string | null>(readCollapsed);
  const key = ready ? `${taskId}:${ready.plan.id}` : null;
  const collapsed = !!key && collapsedKey === key;
  const setCollapsed = (next: boolean) => {
    const value = next ? key : null;
    setCollapsedKey(value);
    try {
      if (value) sessionStorage.setItem(COLLAPSED_STORAGE, value);
      else sessionStorage.removeItem(COLLAPSED_STORAGE);
    } catch {
      // 存不下就只记在这一页里。
    }
  };
  return { ready, collapsed, setCollapsed, covering: !!ready && !collapsed };
}

export function PlanReadyCard({ takeover, onImplement, onRevise }: {
  takeover: PlanTakeover;
  onImplement: (ready: ReadyPlan) => Promise<void>;
  onRevise: (ready: ReadyPlan, text: string, attachments: string[]) => Promise<void>;
}) {
  const { ready, collapsed, setCollapsed } = takeover;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"implement" | "revise" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const goRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const uploads = useAttachments();
  useAutoGrowTextarea(noteRef, { value: note, maxLines: 6 });
  if (!ready) return null;

  const run = async (kind: "implement" | "revise", action: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  };
  const implement = () => void run("implement", () => onImplement(ready));
  const revise = () => {
    const text = note.trim();
    if (!text || uploads.uploading) return;
    void run("revise", async () => {
      await onRevise(ready, text, uploads.attachments.map((attachment) => attachment.path));
      setNote("");
      uploads.clear();
    });
  };
  // 数字键只挪焦点不替你按：误触一下就开工的代价太大，回车再确认。
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof HTMLTextAreaElement || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "1") { event.preventDefault(); goRef.current?.focus(); }
    if (event.key === "2") { event.preventDefault(); noteRef.current?.focus(); }
  };

  if (collapsed) {
    return (
      <section className="question-card is-collapsed" aria-label="计划已就绪">
        <button type="button" className="question-card-peek" aria-expanded="false" onClick={() => setCollapsed(false)}>
          <span>实施此计划？</span>
          <CaretDown size={13} weight="bold" aria-hidden="true" />
        </button>
      </section>
    );
  }

  return (
    <section className="question-card plan-ready-card" aria-label="计划已就绪" aria-busy={!!busy} onKeyDown={onKeyDown}>
      <header className="question-card-head">
        <strong className="plan-ready-title">实施此计划？</strong>
        <div className="question-card-tools">
          <button type="button" className="question-card-collapse" aria-expanded="true" aria-label="收起，先看计划"
            onClick={() => setCollapsed(true)}>
            <CaretDown size={13} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="question-card-options">
        <button type="button" ref={goRef} className="plan-ready-go" disabled={!!busy} onClick={implement}>
          <span className="question-card-key" aria-hidden="true">1</span>
          <span>{busy === "implement" ? "正在开始…" : "实施此计划"}</span>
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
      <UploadAttachmentList attachments={uploads.attachments} pending={uploads.pending} error={null}
        onRemove={uploads.remove} onCancel={uploads.cancel} />
      <div className="question-card-note">
        <span className="question-card-key plan-ready-pen" aria-hidden="true"><PencilSimple size={12} /></span>
        <textarea ref={noteRef} value={note} rows={1} disabled={!!busy} aria-label="要怎么改这份计划"
          placeholder="否，说说要怎么改…"
          onChange={(event) => setNote(event.target.value)}
          onPaste={busy ? undefined : uploads.onPaste}
          onKeyDown={(event) => {
            if (!isSendKeyEvent(event)) return;
            event.preventDefault();
            revise();
          }} />
        <AttachmentPicker addFiles={uploads.addFiles} disabled={!!busy} />
        <button type="button" className="question-card-send" disabled={!!busy || !note.trim() || uploads.uploading} onClick={revise}>
          {busy === "revise" ? "发送中…" : uploads.uploading ? uploadingLabel(uploads.pending) : "发送修改"}
        </button>
      </div>
      {uploads.error && <p className="question-card-error" role="alert">{uploads.error}</p>}
      {error && <p className="question-card-error" role="alert">{error}</p>}
    </section>
  );
}
