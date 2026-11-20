// 讨论收尾后「把结论交出去落实」：建一条普通任务（议题、共同方案和完整转写路径写进它的正文）。
// 新任务只有一种（只叫一个执行器来跑），所以这里不再挑调度者和执行者；以前接力出来的团队照旧列在这儿。
import { useEffect, useMemo, useRef, useState } from "react";
import { TEAM_DEFAULTS, taskDisplayStatus, type AgentExecutorProfile, type AgentType, type TaskListItem } from "@navi/shared";
import { taskInteractionAvailability } from "@navi/shared/task-interaction";
import { ArrowRight, ArrowSquareOut, UsersThree, Warning } from "@phosphor-icons/react";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";
import {
  executorValue,
  isExecutorPickable,
  nothingRunnable,
  parseExecutorValue,
  preferredExecutor,
  registeredAgentTypes,
} from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { useFileMention } from "../lib/useFileMention.ts";
import type { HandoffChoice } from "./duetHandoff.ts";
import { FileMentionMenu } from "../components/MentionMenu.tsx";
import { AutoTextarea } from "../components/AutoTextarea.tsx";

type Choice = { profile: string; model: string; effort: string };

// 落实的活默认还是交给常做执行的那一位。
const DEFAULT_TYPE: AgentType = TEAM_DEFAULTS.worker;

export function DuetHandoffModal({
  taskId,
  busy,
  onClose,
  onConfirm,
}: {
  /** 这场讨论自己的任务 id —— 附言里 `@` 引用的文件按它的工作目录搜。 */
  taskId: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (choice: HandoffChoice) => Promise<boolean>;
}) {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const [executor, setExecutor] = useState<Choice>(() => ({
    profile: executorValue({ agentType: DEFAULT_TYPE, executorId: null }),
    model: "",
    effort: "",
  }));
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const mention = useFileMention({
    value: note,
    setValue: setNote,
    scope: { kind: "task", taskId },
    onPicked: () => noteRef.current?.focus(),
  });
  const types = useMemo(() => registeredAgentTypes(profiles), [profiles]);
  useEffect(() => {
    let alive = true;
    api.agents().then((nextProfiles) => { if (alive) setProfiles(nextProfiles); })
      .catch(() => { if (alive) setProfiles([]); })
      .finally(() => { if (alive) setProfilesReady(true); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!profilesReady) return;
    const current = parseExecutorValue(executor.profile, profiles, { agentType: DEFAULT_TYPE, executorId: null });
    if (executor.profile === executorValue(current) && isExecutorPickable(current, types, profiles)) return;
    const fallback = preferredExecutor(types, profiles, DEFAULT_TYPE);
    // 换掉执行器就把模型/强度清成「跟随」：旧档位在新 CLI 上多半根本不存在。
    if (fallback) setExecutor({ profile: executorValue(fallback), model: "", effort: "" });
  }, [executor.profile, profiles, profilesReady, types]);
  const choice = useMemo<HandoffChoice>(() => ({
    note,
    executor: {
      ...parseExecutorValue(executor.profile, profiles, { agentType: DEFAULT_TYPE, executorId: null }),
      model: executor.model || null,
      effort: executor.effort || null,
    },
  }), [executor, note, profiles]);
  const noExecutor = profilesReady && nothingRunnable(profiles);
  const unavailable = profilesReady && !noExecutor && !isExecutorPickable(choice.executor, types, profiles);
  const availabilityMessage = noExecutor
    ? "还没有已注册执行器，暂不能创建任务。"
    : unavailable ? "这个执行器当前未注册，请更换。" : null;
  const canConfirm = !busy && profilesReady && !noExecutor && !unavailable;
  const submitHandoff = async () => { if (canConfirm && await onConfirm(choice)) onClose(); };
  return (
    <div className="duet-handoff-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="duet-handoff-modal" role="dialog" aria-modal="true" aria-labelledby="duet-handoff-title">
        <header><span><ArrowSquareOut size={17} weight="bold" /></span><div><h2 id="duet-handoff-title">交给任务落实</h2><p>议题、共同方案和完整转写路径会一并写进新任务。</p></div></header>
        <div className="duet-handoff-grid">
          <ExecutorPickerField label="执行器" value={executor.profile} types={types} profiles={profiles} knownProfiles={profiles} fallbackType={DEFAULT_TYPE} override={executor} onChange={(profile, override) => setExecutor({ profile, ...override })} onEffortChange={(effort) => setExecutor((current) => ({ ...current, effort }))} />
        </div>
        {availabilityMessage && <p className="duet-handoff-warning"><Warning size={13} />{availabilityMessage}</p>}
        <label className="duet-handoff-note"><span>可选附言</span><AutoTextarea ref={noteRef} rows={4} value={note} placeholder="补充执行重点、边界或验收要求…（@ 可引用工作区文件）"
          onChange={(event) => { setNote(event.target.value); mention.onValueChange(); }}
          onKeyDown={(event) => { mention.onKeyDown(event); }} />
          {mention.open && <FileMentionMenu mention={mention} label="引用工作区文件" />}
        </label>
        <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="is-primary" disabled={!canConfirm} onClick={() => void submitHandoff()}>{busy ? "创建中…" : "创建并开干"}</button></footer>
      </section>
    </div>
  );
}

export function DuetHandoffBar({
  task,
  linkedTasks,
  busy,
  onOpenHandoff,
  onOpenTask,
}: {
  task: Pick<TaskListItem, "archived">;
  /** 从这场讨论交出去落实的任务：现在建的是普通任务，以前接力出来的团队也在里面。 */
  linkedTasks: TaskListItem[];
  busy: boolean;
  onOpenHandoff: () => void;
  onOpenTask: (task: TaskListItem) => void;
}) {
  const readOnly = taskInteractionAvailability(task) === "archived";
  if (linkedTasks.length > 0) {
    return (
      <div className="duet-handoff-stack">
        <div className="duet-linked-team-list" aria-label="落实任务">
          {linkedTasks.map((team) => {
            const status = taskDisplayStatus(team.status, team.stage, !!team.question).label;
            return (
              <div className="duet-linked-team" key={team.id}>
                <button type="button" className="duet-linked-team-main" onClick={() => onOpenTask(team)}>
                  <span>{team.mode === "team" ? <UsersThree size={15} weight="fill" /> : <ArrowSquareOut size={15} weight="bold" />}</span>
                  <div><small>{team.mode === "team" ? "已接力成团" : "已交给任务落实"}</small><b>{team.title}</b></div>
                  <em>{team.archived ? "已归档" : status}</em><ArrowRight size={13} />
                </button>
              </div>
            );
          })}
        </div>
        {!readOnly && <button type="button" className="duet-new-team" disabled={busy} onClick={onOpenHandoff}>
          <ArrowSquareOut size={13} weight="bold" />{busy ? "创建中…" : "再交一条"}
        </button>}
      </div>
    );
  }
  if (readOnly) return null;
  return (
    <div className="duet-handoff-bar">
      <div><b>把结论交给任务落实</b><small>新建一条任务，由你选的执行器接着做。</small></div>
      <button type="button" disabled={busy} onClick={onOpenHandoff}><ArrowSquareOut size={13} weight="bold" />{busy ? "创建中…" : "交给任务"}</button>
    </div>
  );
}
