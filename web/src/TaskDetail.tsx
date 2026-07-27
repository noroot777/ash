import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Task, Group, TaskStatus, Priority, AgentType } from "@harness/shared";
import { AGENT_TYPES, isUserSettableStatus, canArchive } from "@harness/shared";
import { CaretDown, Play, Stop, Trash, ArrowsClockwise, DownloadSimple, ListNumbers } from "@phosphor-icons/react";
import { api } from "./api";
import { STATUSES, PRIORITIES } from "./constants";
import { CollapsibleText, CopyButton } from "./ui";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon, LabelAdder } from "./ui";
import { ScheduleControl } from "./ScheduleControl";
import { Menu } from "./Menu";
import { QueueModal } from "./QueueModal";
import { runAction, canStopTask } from "./taskActions";
import { toast } from "./toast";
import { groupLabel } from "./util";
import { TaskTimeChip } from "./time";
// 会话渲染与插话框已拆成独立模块(/team 也复用它们)。
import { Conversation, conversationToText, downloadConversation, type LogLine } from "./Conversation";
import { useConversation } from "./useConversation";
import { ReplyBox } from "./ReplyBox";
import { ExecutorPicker, type ExecutorSelection, useExecutorProfiles } from "./ExecutorPicker";
import { executorLabel } from "./executorLabel";
export type { LogLine } from "./Conversation";

export function TaskDetail({
  task,
  groups,
  allTasks: _allTasks, // legacy:旧 dep picker 用过,现在 queue 模型不需要;callers 仍在传,留 prop 兼容,phase C 后续可一并清掉
  logs,
  sessionsBump,
  onRun,
  onStop,
  onRetry,
  onReply,
  onPatch,
  onCreateGroup,
  onDelete,
  onArchive,
  onUnarchive,
  onRequeue,
}: {
  task: Task;
  groups: Group[];
  allTasks: Task[];
  logs: LogLine[];
  sessionsBump: number;
  onRun: () => void;
  onStop: () => void;
  onRetry: () => void;
  onReply: (text: string, opts?: { attachments?: string[]; agent?: AgentType }) => void;
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  onCreateGroup: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  // 重新排队(失败/取消 → 回队列等待)。位置由服务端定:被越过就到队尾。
  onRequeue: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { profiles, providers } = useExecutorProfiles();

  // 拉会话 + 快照历史输出 + 拼条目流,都在 useConversation 里(/team 指挥台共用同
  // 一份装配,免得两个界面的「刷新后 vs 实时」各自漂移)。
  const { items, sessions, snapshot } = useConversation({
    task,
    logs,
    sessionsBump,
    primaryAgent: task.agentType ?? "claude",
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [logs.length, snapshot.length]);

  // 任务在哪条 queue 第几位?——allTasks 过滤了 archived,但归档任务仍占队列位置,
  // 所以直接调 API 拿队列总长度,免得 N/M 里的 M 偏少。
  const [queueSize, setQueueSize] = useState<number | null>(null);
  const [queueModalOpen, setQueueModalOpen] = useState(false);
  const currentExecutor: ExecutorSelection = {
    agentType: task.agentType ?? "claude",
    executorId: task.executorId ?? null,
  };
  useEffect(() => {
    if (!task.queueId) { setQueueSize(null); return; }
    let alive = true;
    api.queue(task.queueId).then(
      (q) => { if (alive) setQueueSize(q.items.length); },
      () => { if (alive) setQueueSize(null); },
    );
    return () => { alive = false; };
  }, [task.queueId, queueModalOpen]);

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 pb-3 pt-5">
        <div className="flex items-start gap-3">
          <EditableTitle title={task.title} onSave={(t) => onPatch({ title: t, autoTitle: false })} />
          <div className="flex shrink-0 items-center gap-2">
            <TaskTimeChip task={task} />
            {task.archived ? (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-md bg-overlay px-3 py-1.5 text-[13px] font-medium text-muted" title="任务已归档（只读）">
                  已归档
                </span>
                <button
                  onClick={onUnarchive}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
                >
                  <ArrowsClockwise size={13} />
                  取消归档
                </button>
              </>
            ) : canStopTask(task.status) ? (
              <button
                onClick={onStop}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-500/10"
              >
                <Stop size={13} weight="fill" />
                停止
              </button>
            ) : (
              (() => {
                const a = runAction(task.status, task.archived);
                return (
                  <button
                    // 重试(failed)走 /retry:续跑原会话,不受「队列前面还有未完成」
                    // 限制(顺序由任务自身检查点 + 队列唤醒保证);运行/继续走 /run。
                    // 与列表、r 键、Cmd-K、DebateView 的分发保持一致。
                    onClick={a.kind === "retry" ? onRetry : onRun}
                    disabled={!a.canClick}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent"
                  >
                    <Play size={13} weight="fill" />
                    {a.label}
                  </button>
                );
              })()
            )}
            {/* 重新排队:队列里的 failed/canceled 任务回到 backlog,轮到它时被
                队列自动拉起(有会话则从中断处续跑)。canceled 在队列推进里是
                「透明跳过」,所以手动停过的任务想继续排队必须走这里。done 不给
                ——严格完成协议下 done 都是 agent 亲口确认过的,真要重跑走状态
                下拉改回 backlog。一次调用做完「改状态 + 定位置 + 推进队列」:
                前端曾经拆成 PATCH + runGroup 两步,中间那一瞬间会让本任务抢在
                正在跑的下一个前面(串行队列并跑)。 */}
            {!task.archived && task.queueId && ["failed", "canceled"].includes(task.status) && (
              <button
                onClick={onRequeue}
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
                title="回到队列等待：前面的任务完成后自动启动。队列若已经跑过它，就排到队尾"
              >
                <ListNumbers size={13} />
                重新排队
              </button>
            )}
            {!task.archived && canArchive(task.status) && (
              <button
                onClick={onArchive}
                className="inline-flex items-center rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
                title="归档任务（从列表收起，可恢复）"
              >
                归档
              </button>
            )}
            {items.length > 0 && (
              <>
                <CopyButton
                  text={conversationToText(items, task)}
                  title="复制全部对话"
                  size={15}
                  className="h-[30px] w-[30px] hover:bg-raised"
                />
                <button
                  onClick={() => downloadConversation(items, task)}
                  className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink"
                  title="导出对话为 .md 文件"
                >
                  <DownloadSimple size={15} />
                </button>
              </>
            )}
            <button
              onClick={onDelete}
              className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-red-600"
              title="删除任务"
            >
              <Trash size={15} />
            </button>
          </div>
        </div>

        {/* Task objective — shown right under the title (collapsed to 2 lines;
            click 展开 for the full text). */}
        {task.body && <CollapsibleText text={task.body} />}

        {/* agent 提问:调 ask_question 后停在这等答案(队列陪等,不会自动续跑)。
            团队模式下指挥者通常会自动来答;用户也可以直接在这里答复唤醒。 */}
        {task.question && <QuestionCard task={task} />}

        {/* 检查点续跑：paused 时露出 resumePrompt（agent 留下的「下次喂我什么」），
            让用户知道一旦依赖满足、scheduler 唤醒它会发什么 user 消息。可编辑
            （改写不好的指令）或清空（清空 = 续跑时不携指令，用标准"继续"nudge）。 */}
        {task.status === "paused" && !task.question && (
          <ResumePromptEditor
            value={task.resumePrompt ?? ""}
            onSave={(rp) => onPatch({ resumePrompt: rp || null })}
          />
        )}

        {/* All controls on one wrapping row: attributes | labels | deps·schedule | session */}
        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[12px]">
          <div className={`flex flex-wrap items-center gap-1.5 ${task.archived ? "pointer-events-none opacity-60" : ""}`}>
            <Prop
              value={task.status}
              onChange={(v) => onPatch({ status: v as TaskStatus })}
              options={STATUSES.filter((s) => isUserSettableStatus(s.key) || s.key === task.status).map((s) => ({ value: s.key, label: s.label }))}
              leading={(v) => <StatusIcon status={v as TaskStatus} size={13} />}
            />
            <Prop
              value={task.priority}
              onChange={(v) => onPatch({ priority: v as Priority })}
              options={PRIORITIES.map((p) => ({ value: p.key, label: p.label }))}
              leading={(v) => <PriorityIcon p={v as Priority} />}
            />
            <Prop
              value={task.groupId ?? ""}
              onChange={(v) => (v === "__new" ? onCreateGroup() : onPatch({ groupId: v || null }))}
              options={[
                { value: "", label: "无分组" },
                ...groups.map((g) => ({ value: g.id, label: groupLabel(g) })),
                { value: "__new", label: "+ 新建分组" },
              ]}
            />
          </div>

          <span className="h-4 w-px bg-line" />
          <div className="flex flex-wrap items-center gap-1.5">
            {task.labels.map((l) => (
              <button
                key={l}
                onClick={() => onPatch({ labels: task.labels.filter((x) => x !== l) })}
                className="rounded-full bg-overlay px-2 py-0.5 text-[11px] text-ink transition hover:bg-line2"
                title="点击移除"
              >
                {l}
              </button>
            ))}
            <LabelAdder onAdd={(l) => !task.labels.includes(l) && onPatch({ labels: [...task.labels, l] })} />
          </div>

          <span className="h-4 w-px bg-line" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {/* 队列归属(DESIGN-scheduling.md §1):任务在某条 queue 里第几位。
                点开看完整队列、改顺序、把任务移出队列。废弃的 depOptions /
                resumeDepOptions 在新模型下永远空,挪开免得占视觉位。 */}
            <div className="flex items-center gap-1.5">
              <ListNumbers size={13} className="text-faint" />
              <span className="text-muted">队列</span>
              {task.queueId ? (
                <button
                  onClick={() => setQueueModalOpen(true)}
                  className="rounded bg-overlay px-1.5 py-0.5 text-ink transition hover:bg-line2"
                  title="点开看完整队列"
                >
                  第 {(task.queuePosition ?? 0) + 1}{queueSize != null ? ` / ${queueSize}` : ""} 位
                </button>
              ) : (
                <span className="text-faint">不在任何队列(独立任务)</span>
              )}
            </div>
            <ScheduleControl taskId={task.id} />
          </div>

          {/* Who will run this — shown only until the first run exists. The live
              run credentials (resume / id / time) now live per-bubble in the
              conversation below, not crammed into this header row. */}
          {sessions.length === 0 && (
            <>
              <span className="h-4 w-px bg-line" />
              <span className="inline-flex items-center gap-1.5 text-faint">
                将由
                <ExecutorPicker
                  selection={currentExecutor}
                  onSelect={(sel) => onPatch({ agentType: sel.agentType, executorId: sel.executorId })}
                  profiles={profiles}
                  providers={providers}
                  types={[...AGENT_TYPES]}
                  label={task.executorId ? executorLabel({ task }) : `默认 ${executorLabel({ task })}`}
                  menuWidth={320}
                  triggerClassName="inline-flex max-w-[260px] items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-0.5 text-[12px] text-muted transition-colors hover:bg-raised hover:text-ink"
                />
                <span>执行</span>
              </span>
            </>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto break-words px-6 py-4 text-[13px] leading-relaxed"
      >
        {/* The run as a conversation: prior output (snapshotted per session on
            load) and the live stream merge into one bubble per run, so a running
            task you reload doesn't split into a stale + live pair. */}
        <Conversation items={items} />
        {items.length === 0 && (
          <p className="font-sans text-faint">点击「运行」开始，输出会实时流式显示在这里。</p>
        )}
      </div>

      {task.mode === "single" && (sessions.length > 0 || snapshot.length > 0 || logs.length > 0) && (
        <ReplyBox taskId={task.id} onReply={onReply} disabled={task.status === "running" || task.status === "queued" || !!task.archived} />
      )}
      {queueModalOpen && task.queueId && (
        <QueueModal
          queueId={task.queueId}
          currentTaskId={task.id}
          onClose={() => setQueueModalOpen(false)}
        />
      )}
    </main>
  );
}



// Linear-style property control built on the custom Menu (no native select).
function Prop({
  value,
  onChange,
  options,
  leading,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  leading?: (v: string) => ReactNode;
}) {
  const cur = options.find((o) => o.value === value);
  return (
    <Menu
      value={value}
      onChange={onChange}
      options={options.map((o) => ({ value: o.value, label: o.label, icon: leading?.(o.value) }))}
      triggerClassName="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink transition-colors hover:bg-raised"
    >
      {leading?.(value)}
      <span className="whitespace-nowrap">{cur?.label ?? ""}</span>
      <CaretDown size={11} weight="bold" className="text-faint" />
    </Menu>
  );
}

// Inline-editable task title (click in, type, Enter/blur saves; Esc reverts).
// 导出给 /team 的 header 复用 —— 团队任务的标题也当场改。
export function EditableTitle({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const [v, setV] = useState(title);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setV(title);
  }, [title, editing]);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={() => {
        setEditing(false);
        const t = v.trim();
        if (t && t !== title) onSave(t);
        else setV(title);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setV(title);
          e.currentTarget.blur();
        }
      }}
      className="-mx-1 min-w-0 flex-1 rounded px-1 text-[15px] font-semibold leading-snug text-ink outline-none hover:bg-raised/40 focus:bg-raised/60"
      title="点击编辑标题"
    />
  );
}

// 提问卡片:agent 调 ask_question 后任务停在 paused 等答案(队列陪等,
// pickNextLaunchable 不会空手唤醒它)。团队模式下指挥者收到通知后通常会自动答;
// 这里给用户一个手动答复入口 —— 没有指挥者的普通任务全靠它。**指挥者自己也会用
// 这张卡**(它调 ask_question 问用户时),所以导出给 /team 复用。
// 一次性任务在回合还没结算完(running/queued)时 server 会 409(答复会被单飞锁丢),
// 按钮先禁用;常驻指挥台没这个问题 —— 它忙着也接得住(跟插话同一条路,先 interrupt
// 再写 stdin),所以 team 不禁用、文案也换成指挥台那套。
// agent 给了候选答案(ask_question 的 options)就在问题下方渲染成按钮:点一下 = 把该
// 选项**原文**当答复送出,走的还是同一个 answerTask —— 候选只是省掉打字,不是单选
// 题,输入框始终在,用户随时可以答别的。
export function QuestionCard({ task }: { task: Task }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<string | null>(null); // 正在发的那条文本(null=空闲)
  const isLead = task.mode === "team";
  const settling = !isLead && (task.status === "running" || task.status === "queued");
  const options = task.questionOptions ?? [];
  const busy = sending !== null;
  const send = async (text?: string) => {
    const a = (text ?? draft).trim();
    if (!a || busy) return;
    setSending(a);
    try {
      await api.answerTask(task.id, a);
      toast(isLead ? "已答复，指挥者收到了" : "已答复，任务正在带着答案续跑");
      setDraft("");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(null);
    }
  };
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-cyan-500/40 bg-cyan-500/[0.06]">
      <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-cyan-700">
        <StatusIcon status="paused" size={11} awaitingAnswer />
        <span>{isLead ? "指挥者在问你话，等待答复" : "任务提问，等待答复（队列陪等，不会自动续跑）"}</span>
      </div>
      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words px-2.5 pb-1 text-[12px] leading-snug text-ink">{task.question}</pre>
      {options.length > 0 && (
        <div className="flex flex-col gap-1 px-2.5 pb-1.5 pt-0.5">
          {options.map((opt, i) => (
            <button
              key={`${i}-${opt}`}
              onClick={() => void send(opt)}
              disabled={settling || busy}
              title="点一下就以这句话作为答复发出"
              className="flex w-full items-start gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/[0.07] px-2 py-1 text-left text-[12px] leading-snug text-ink transition-colors hover:border-cyan-500/60 hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="mt-px shrink-0 font-mono text-[10px] text-cyan-700">{i + 1}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{opt}</span>
              {sending === opt && <span className="shrink-0 text-[10px] text-cyan-700">发送中…</span>}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-start gap-1.5 border-t border-cyan-500/20 px-2 py-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void send(); }
          }}
          rows={2}
          placeholder={
            settling
              ? "提问回合还没结束，稍候片刻再答…"
              : options.length > 0
                ? "都不合适？自己写一个答复（⌘↵ 发送）"
                : isLead
                  ? "写下答复，发送后直接进同一个常驻会话（⌘↵ 发送）"
                  : "写下答复，发送后会直接唤醒 agent 带着答案继续（⌘↵ 发送）"
          }
          disabled={settling || busy}
          className="block min-w-0 flex-1 resize-y rounded-md bg-transparent px-1.5 py-1 text-[12px] leading-snug text-ink outline-none placeholder:text-faint disabled:opacity-50"
        />
        <button
          onClick={() => void send()}
          disabled={settling || busy || !draft.trim()}
          className="shrink-0 rounded-md bg-cyan-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-cyan-500 disabled:opacity-40"
        >
          {sending !== null && sending === draft.trim() ? "发送中…" : "答复并唤醒"}
        </button>
      </div>
    </div>
  );
}

// paused 任务的「续跑指令」编辑面板。默认折叠展示 agent 写下的 resumePrompt；
// 用户可以「编辑」改写、或「清空」让它续跑时落到标准的「继续」nudge（保留 paused
// 状态、不影响依赖逻辑）。空值时给一个「添加」入口 —— 让用户主动写一段也行。
function ResumePromptEditor({ value, onSave }: { value: string; onSave: (rp: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    const t = draft.trim();
    onSave(t);
    setEditing(false);
  };
  if (editing) {
    return (
      <div className="mt-2 overflow-hidden rounded-md border border-slate-500/40 bg-slate-500/[0.06]">
        <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-600">
          <StatusIcon status="paused" size={11} />
          <span>编辑续跑指令</span>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { e.preventDefault(); setEditing(false); setDraft(value); }
          }}
          rows={4}
          autoFocus
          placeholder="续跑时发送给 agent 的 user 消息，比如：「继续做 tts 这一段」"
          className="block w-full resize-y bg-transparent px-2.5 py-1.5 text-[12px] leading-snug text-ink outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-end gap-1.5 border-t border-slate-500/20 px-2 py-1.5">
          <button
            onClick={() => { setEditing(false); setDraft(value); }}
            className="rounded-md px-2 py-1 text-[11px] text-muted hover:text-ink"
          >
            取消
          </button>
          <button
            onClick={commit}
            className="rounded-md bg-slate-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-slate-500"
          >
            保存（⌘↵）
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="group/rp mt-2 overflow-hidden rounded-md border border-slate-500/40 bg-slate-500/[0.06]">
      <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-600">
        <StatusIcon status="paused" size={11} />
        <span>{value ? "已到检查点 · 续跑时将发送：" : "已到检查点 · 无续跑指令（续跑用标准「继续」nudge）"}</span>
        <button
          onClick={() => setEditing(true)}
          className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate-600 opacity-0 hover:bg-slate-500/15 group-hover/rp:opacity-100"
          title={value ? "编辑续跑指令" : "添加续跑指令"}
        >
          {value ? "编辑" : "+ 添加"}
        </button>
        {value && (
          <button
            onClick={() => onSave("")}
            className="rounded px-1.5 py-0.5 text-[10px] text-slate-600/80 opacity-0 hover:bg-slate-500/15 hover:text-slate-600 group-hover/rp:opacity-100"
            title="清空：续跑时改用标准「继续」nudge"
          >
            清空
          </button>
        )}
      </div>
      {value && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-2.5 pb-2 text-[12px] leading-snug text-ink">{value}</pre>
      )}
    </div>
  );
}
