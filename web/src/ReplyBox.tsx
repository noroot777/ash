// 「答复并续跑」输入框。默认答任务自己的 agent；打 `@` 挑一个执行器就把这条
// 回复交给它，等于把它请进同一个任务(同一个工作目录)。可以粘图。时钟按钮把回复
// 排到未来某个时刻发(scheduled_messages)，待发的列在输入框上方、发之前能撤。
//
// 从 TaskDetail.tsx 拆出来的：/team 的插话框也是这一套(见 web/src/team/TeamView.tsx)。
import { useEffect, useState, type ReactNode } from "react";
import type { AgentType, ScheduledMessage } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { Robot, X, Clock } from "@phosphor-icons/react";
import { api } from "./api";
import { formatInstant } from "./time";
import { usePasteAttachments, AttachmentChips } from "./pasteAttachments";
import { Kbd, submitShortcutLabel, submitShortcutTitle, TopResizableTextarea } from "./ui";

// Date → "YYYY-MM-DDTHH:mm"(本地时间)，给 <input type="datetime-local"> 当默认值
// (跟 ScheduleControl 同一套约定)。
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Reply-and-continue box. Answers the task's own agent by default; typing `@` and
// picking an agent assigns the reply to another agent, which is invited into the
// same task (same working directory). Images can be pasted in too. The clock
// button schedules the reply for a future time (scheduled_messages); pending ones
// are listed above the input and can be canceled before they fire.
export function ReplyBox({
  taskId,
  onReply,
  disabled,
  mention = true,
  toolbar,
  inlinePanel,
  command,
  placeholder = `回复并继续（${submitShortcutLabel()} 发送，可粘贴图片或文件，@ 召唤其它智能体）…`,
  disabledPlaceholder = "进行中…",
}: {
  taskId: string;
  onReply: (text: string, opts?: { attachments?: string[]; agent?: AgentType }) => void;
  disabled: boolean;
  /** 关掉 @ 召唤(/team 的插话永远是给调度者的,换执行器没有意义)。 */
  mention?: boolean;
  /** 输入框上方的任务级运行设置；运行中也保持可操作。 */
  toolbar?: ReactNode;
  /** 由输入命令展开的任务级内联配置卡。 */
  inlinePanel?: ReactNode;
  /** 命令可以在普通回复被禁用时继续输入；命中后只展开卡片，不发给 agent。 */
  command?: {
    matches: (text: string) => boolean;
    onSubmit: (text: string) => void;
  };
  placeholder?: string;
  disabledPlaceholder?: string;
}) {
  const [v, setV] = useState("");
  const [target, setTarget] = useState<AgentType | null>(null);
  const [mIdx, setMIdx] = useState(0);
  const { attachments, onPaste, remove, clear, error } = usePasteAttachments();
  const [schedOpen, setSchedOpen] = useState(false);
  const [at, setAt] = useState("");
  const [pending, setPending] = useState<ScheduledMessage[]>([]);

  // Load this task's pending scheduled messages (re-fetch when switching tasks).
  useEffect(() => {
    let alive = true;
    api.scheduledMessages(taskId).then((ms) => alive && setPending(ms)).catch(() => {});
    return () => { alive = false; };
  }, [taskId]);

  // @-mention: when an "@word" token sits at the end of the text, offer the agent
  // list. Choosing one assigns the reply to that agent and strips the token.
  const mMatch = mention ? /(?:^|\s)@(\w*)$/.exec(v) : null;
  const cands = mMatch ? AGENT_TYPES.filter((a) => a.startsWith((mMatch[1] ?? "").toLowerCase())) : [];
  const mentionOpen = !disabled && !!mMatch && cands.length > 0;
  const commandMatch = !!command && command.matches(v);
  const inputDisabled = disabled && !command;

  const pick = (a: AgentType) => {
    setTarget(a);
    setV((s) => s.replace(/@\w*$/, "")); // drop the @token being typed
    setMIdx(0);
  };

  const send = () => {
    if (v.trim() && command?.matches(v)) {
      command.onSubmit(v.trim());
      setV("");
      setTarget(null);
      return;
    }
    if ((v.trim() || attachments.length) && !disabled) {
      onReply(v.trim(), { attachments: attachments.map((a) => a.path), agent: target ?? undefined });
      setV("");
      clear();
      setTarget(null);
    }
  };

  // Queue the reply for `at` (local) instead of sending now. The backend persists
  // it and the scheduler delivers it when due + the task is idle.
  const sendScheduled = async () => {
    const when = new Date(at);
    if (commandMatch) {
      setSchedOpen(false);
      send();
      return;
    }
    if (!(v.trim() || attachments.length) || disabled) return;
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) return;
    try {
      const r = (await api.replyTask(taskId, v.trim(), {
        attachments: attachments.map((a) => a.path),
        agent: target ?? undefined,
        sendAt: when.toISOString(),
      })) as { message?: ScheduledMessage };
      if (r?.message) setPending((ps) => [...ps, r.message!].sort((a, b) => a.sendAt.localeCompare(b.sendAt)));
      setV("");
      clear();
      setTarget(null);
      setSchedOpen(false);
      setAt("");
    } catch (e) {
      console.warn("schedule rejected:", e);
    }
  };

  const cancelScheduled = async (mid: string) => {
    try {
      await api.cancelScheduledMessage(mid);
      setPending((ps) => ps.filter((m) => m.id !== mid));
    } catch (e) {
      console.warn("cancel rejected:", e);
    }
  };

  return (
    <div className="relative flex flex-col gap-2 border-t border-line px-6 py-3">
      {mentionOpen && (
        <div className="absolute bottom-full left-6 z-10 mb-1 w-56 overflow-hidden rounded-lg border border-line2 bg-panel p-1 shadow-xl">
          <div className="px-2 py-1 text-[10px] text-faint">召唤智能体加入 · ↑↓ 选，回车确定</div>
          {cands.map((a, i) => (
            <button
              key={a}
              onMouseEnter={() => setMIdx(i)}
              onClick={() => pick(a)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink ${i === mIdx ? "bg-raised" : ""}`}
            >
              <Robot size={14} className="text-muted" /> @{a}
            </button>
          ))}
        </div>
      )}
      {schedOpen && (
        <div className="absolute bottom-full right-6 z-10 mb-1 w-72 rounded-lg border border-line2 bg-panel p-3 shadow-xl">
          <div className="mb-2 text-[12px] font-medium text-ink">定时发送</div>
          <input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            className="w-full rounded-md border border-line bg-canvas px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button onClick={() => setSchedOpen(false)} className="rounded-md px-2 py-1 text-[12px] text-muted hover:text-ink">
              取消
            </button>
            <button
              onClick={sendScheduled}
              disabled={!at || new Date(at) <= new Date() || (!v.trim() && !attachments.length)}
              className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
            >
              定时发送
            </button>
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <div className="flex flex-col gap-1">
          {pending.map((m) => (
            <div key={m.id} className="flex items-center gap-2 rounded-md bg-overlay px-2 py-1 text-[12px]">
              <Clock size={12} className="shrink-0 text-faint" />
              <span className="shrink-0 text-muted">{formatInstant(m.sendAt)}</span>
              {m.agent && <span className="shrink-0 text-faint">@{m.agent}</span>}
              <span className="min-w-0 flex-1 truncate text-ink">{m.text || "[附件]"}</span>
              <button onClick={() => cancelScheduled(m.id)} className="shrink-0 text-faint hover:text-ink" title="取消定时">
                <X size={11} weight="bold" />
              </button>
            </div>
          ))}
        </div>
      )}
      {toolbar}
      {inlinePanel}
      <AttachmentChips attachments={attachments} onRemove={remove} error={error} />
      {target && (
        <div className="flex items-center text-[12px]">
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-ink">
            <Robot size={12} /> 指派给 @{target}
            <button onClick={() => setTarget(null)} className="text-faint hover:text-ink" title="取消指派">
              <X size={11} weight="bold" />
            </button>
          </span>
        </div>
      )}
      <div className="relative">
        <TopResizableTextarea
          value={v}
          onChange={(e) => setV(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === "ArrowDown") { e.preventDefault(); setMIdx((i) => Math.min(cands.length - 1, i + 1)); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setMIdx((i) => Math.max(0, i - 1)); return; }
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pick(cands[mIdx] ?? cands[0]); return; }
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          disabled={inputDisabled}
          placeholder={disabled ? disabledPlaceholder : placeholder}
          initialHeight={72}
          minHeight={60}
          maxHeight={360}
          className="rounded-lg border border-line bg-panel py-2 pl-2.5 pr-[140px] text-[13px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent disabled:opacity-50"
        />
        <div className="absolute bottom-2 right-2 flex h-8 items-stretch overflow-hidden rounded-md border border-line bg-canvas/95 shadow-sm">
          <button
            onClick={() => { if (!at) setAt(toLocalInput(new Date(Date.now() + 3600_000))); setSchedOpen((o) => !o); }}
            disabled={disabled || commandMatch}
            title="定时发送"
            className="grid w-9 place-items-center border-r border-line text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            <Clock size={15} />
          </button>
          <button
            onClick={send}
            disabled={(!v.trim() && !attachments.length) || (disabled && !commandMatch)}
            title={submitShortcutTitle(commandMatch ? "展开配置" : "发送")}
            className="inline-flex items-center gap-1.5 bg-accent px-3 text-[12px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            {commandMatch ? "配置" : "发送"} <Kbd />
          </button>
        </div>
      </div>
    </div>
  );
}

// Date → "YYYY-MM-DDTHH:mm" in local time, for a <input type="datetime-local">
