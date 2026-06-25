import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Issue, IssueComment, Task, AgentType, AiBackend, ProjectView, Priority } from "@harness/shared";
import { ArrowUp, Plus, Robot, Sparkle } from "@phosphor-icons/react";
import { api } from "./api";
import { Menu, Pill } from "./Menu";
import { PriorityIcon, ProjectAvatar } from "./ui";
import { PRIORITIES } from "./constants";

// AI backend choices for the hero composer: local CLI agents (have tools) OR a
// direct model call via the project's API key (text-only — fine for parsing).
type BackendChoice = { value: string; label: string; detail: string; backend: AiBackend };
const BACKENDS: BackendChoice[] = [
  { value: "cli:claude", label: "@claude", detail: "本地", backend: { kind: "cli", agentType: "claude" } },
  { value: "cli:codex", label: "@codex", detail: "本地", backend: { kind: "cli", agentType: "codex" } },
  { value: "cli:antigravity", label: "@antigravity", detail: "本地", backend: { kind: "cli", agentType: "antigravity" } },
  { value: "api:claude-opus-4-8", label: "Claude Opus 4.x", detail: "API", backend: { kind: "api", model: "claude-opus-4-8" } },
  { value: "api:claude-sonnet-4-6", label: "Claude Sonnet 4.x", detail: "API", backend: { kind: "api", model: "claude-sonnet-4-6" } },
  { value: "api:gpt-4o", label: "GPT-4o", detail: "API", backend: { kind: "api", model: "gpt-4o" } },
];

const ISSUE_STATUS_META: Record<Issue["status"], { label: string; cls: string }> = {
  open: { label: "待办", cls: "border-line2" },
  in_progress: { label: "进行中", cls: "border-amber-400 bg-[conic-gradient(theme(colors.amber.400)_62%,transparent_0)]" },
  done: { label: "已完成", cls: "border-emerald-500 bg-emerald-500" },
  canceled: { label: "已取消", cls: "border-line2 bg-line2" },
};

function IssueDot({ status, staged, size = 13 }: { status: Issue["status"]; staged?: boolean; size?: number }) {
  const m = ISSUE_STATUS_META[status];
  return (
    <span
      className={`inline-block shrink-0 rounded-full border-2 ${staged ? "border-dashed border-amber-400" : m.cls}`}
      style={{ width: size, height: size }}
    />
  );
}

const randomHero = () => {
  const t = ["想做点什么?", "今天有什么想做的?", "脑子里在盘算什么?", "有什么要安排的?", "记点什么都行"];
  return t[Math.floor(Math.random() * t.length)];
};

export function IssuesWorkspace({
  projects,
  projectId,
  issues,
  setIssues,
  selectedIssue,
  onSelectIssue,
  onOpenTask,
  taskBump,
}: {
  projects: ProjectView[];
  projectId: string | null;
  issues: Issue[];
  setIssues: React.Dispatch<React.SetStateAction<Issue[]>>;
  selectedIssue: string | null;
  onSelectIssue: (id: string | null) => void;
  onOpenTask: (taskId: string) => void;
  taskBump: number;
}) {
  const current = issues.find((i) => i.id === selectedIssue) ?? null;
  // The list shows the current project's issues + every 未归类 (staging) issue.
  const visible = useMemo(
    () => issues.filter((i) => i.projectId === projectId || i.projectId == null),
    [issues, projectId],
  );

  return (
    <div className="flex min-h-0 flex-1">
      {issues.length > 0 && (
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="sticky top-0 z-[2] border-b border-line bg-panel p-2.5">
            <button
              onClick={() => onSelectIssue(null)}
              className="flex w-full items-center gap-2 rounded-[10px] border border-line2 px-2.5 py-2 text-left text-[13px] text-faint hover:border-accent"
            >
              <span className="flex-1">随手记一条新事项…</span>
              <span className="grid h-6 w-6 place-items-center rounded-full bg-accent text-accent-fg">
                <ArrowUp size={13} weight="bold" />
              </span>
            </button>
          </div>
          <IssueList issues={visible} selected={selectedIssue} onSelect={onSelectIssue} />
        </aside>
      )}
      <div className="min-h-0 flex-1">
        {current ? (
          <IssueDetail
            key={current.id}
            issue={current}
            projects={projects}
            setIssues={setIssues}
            onOpenTask={onOpenTask}
            taskBump={taskBump}
          />
        ) : (
          <HeroComposer
            projects={projects}
            onCreated={(iss) => {
              setIssues((prev) => [iss, ...prev]);
              onSelectIssue(iss.id);
            }}
            onAssignNeeded={(iss) => setIssues((prev) => [iss, ...prev])}
            patchIssueLocal={(iss) => setIssues((prev) => prev.map((x) => (x.id === iss.id ? iss : x)))}
            onSelectIssue={onSelectIssue}
          />
        )}
      </div>
    </div>
  );
}

// ── hero composer with the create morph ──────────────────────────────────────
function HeroComposer({
  projects,
  onCreated,
  onAssignNeeded,
  patchIssueLocal,
  onSelectIssue,
}: {
  projects: ProjectView[];
  onCreated: (i: Issue) => void;
  onAssignNeeded: (i: Issue) => void;
  patchIssueLocal: (i: Issue) => void;
  onSelectIssue: (id: string | null) => void;
}) {
  const [text, setText] = useState("");
  const [backendVal, setBackendVal] = useState("cli:claude");
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState(""); // submitted text shown as a bubble
  const [staged, setStaged] = useState<Issue | null>(null); // 未归类待选项目
  const heroTitle = useRef(randomHero());
  const taRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    titleRef.current?.classList.add("is-shown");
    setTimeout(() => taRef.current?.focus(), 120);
  }, []);

  const backend = BACKENDS.find((b) => b.value === backendVal)?.backend;
  const backendLabel = BACKENDS.find((b) => b.value === backendVal)?.label ?? "@claude";

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setUser(t);
    titleRef.current?.classList.add("is-hiding");
    try {
      const issue = await api.createIssue({ text: t, backend });
      if (issue.projectId == null) {
        onAssignNeeded(issue);
        setStaged(issue); // 让用户归类,不自动落定
      } else {
        onCreated(issue); // 选中它 → 主区切到详情
      }
    } catch (e) {
      alert("创建失败:" + (e instanceof Error ? e.message : String(e)));
      setBusy(false);
      setUser("");
      titleRef.current?.classList.remove("is-hiding");
    }
  };

  const assignTo = async (pid: string | null) => {
    if (!staged) return;
    try {
      const updated = pid ? await api.patchIssue(staged.id, { projectId: pid }) : staged;
      patchIssueLocal(updated);
      onSelectIssue(updated.id);
    } catch (e) {
      alert("归类失败:" + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-[min(660px,92%)]">
        {!busy && (
          <div ref={titleRef} className="t-stagger mb-6 text-center">
            <strong className="t-stagger-line t-stagger-line--1 block text-[27px] font-semibold tracking-[-0.02em] text-ink">
              {heroTitle.current}
            </strong>
            <span className="t-stagger-line t-stagger-line--2 mt-1.5 block text-[13.5px] text-faint">
              随手写,AI 帮你记成一条事项,并自动归到对应项目
            </span>
          </div>
        )}

        <div
          className="t-resize flex flex-col overflow-visible rounded-[18px] border bg-panel"
          style={{
            minHeight: busy ? 200 : 128,
            borderColor: busy ? "color-mix(in srgb, var(--color-accent) 30%, var(--color-line2))" : "var(--color-line2)",
            boxShadow: busy
              ? "0 1px 2px rgba(0,0,0,.04), 0 22px 56px -16px rgba(94,106,210,.28)"
              : "0 1px 2px rgba(0,0,0,.04), 0 18px 44px -16px rgba(40,42,48,.18)",
          }}
        >
          {!busy ? (
            <>
              <div className="flex-1 px-[18px] pb-0.5 pt-[18px]">
                <textarea
                  ref={taRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder="随手写下要做的事…"
                  className="min-h-[50px] w-full resize-none bg-transparent text-[16px] leading-relaxed text-ink outline-none placeholder:text-faint"
                />
              </div>
              <div className="flex items-center gap-1.5 px-3 pb-3 pt-2">
                <button className="grid h-[30px] w-[30px] place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink" title="附件">
                  <Plus size={16} />
                </button>
                <Menu
                  value={backendVal}
                  onChange={setBackendVal}
                  menuWidth={260}
                  options={BACKENDS.map((b) => ({
                    value: b.value,
                    label: b.label,
                    detail: b.detail === "本地" ? "本地智能体 · CLI" : "直连大模型 · API(项目设置里配 Key)",
                    icon: <Robot size={14} />,
                  }))}
                  triggerClassName="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] text-muted hover:bg-raised hover:text-ink"
                >
                  <Robot size={14} /> {backendLabel} <span className="text-[10px] text-faint">▾</span>
                </Menu>
                <span className="flex-1" />
                <button
                  onClick={submit}
                  disabled={!text.trim()}
                  className="grid h-[34px] w-[34px] place-items-center rounded-full bg-accent text-accent-fg transition-colors hover:bg-accent-hover disabled:bg-line2 disabled:text-faint"
                  title="记下来 ⌘↵"
                >
                  <ArrowUp size={16} weight="bold" />
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-col px-[18px] py-[18px]">
              <div className="mb-3.5 ml-auto max-w-[84%] rounded-[13px_13px_5px_13px] border border-[color-mix(in_srgb,var(--color-accent)_22%,#fff)] bg-[color-mix(in_srgb,var(--color-accent)_9%,#fff)] px-3 py-2 text-[14px] text-ink">
                {user}
              </div>
              {!staged ? (
                <div className="flex items-center gap-2.5 py-1 text-[13.5px]">
                  <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-line2 border-t-accent spin360" />
                  <span className="t-shimmer" data-text="识别意图、匹配项目、整理成事项…">
                    识别意图、匹配项目、整理成事项…
                  </span>
                </div>
              ) : (
                <div className="rounded-[13px] border border-dashed border-line2 bg-canvas p-3.5">
                  <div className="mb-2.5 flex items-center gap-1.5 text-[13px] text-ink">
                    <Sparkle size={13} className="text-amber-500" weight="fill" /> 这条暂时没识别出项目,选一个来归类:
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => assignTo(p.id)}
                        className="flex items-center gap-1.5 rounded-[9px] border border-line2 bg-panel px-2.5 py-1.5 text-[12.5px] hover:border-accent hover:bg-raised"
                      >
                        <ProjectAvatar name={p.name} size={18} /> {p.name}
                      </button>
                    ))}
                    <button
                      onClick={() => assignTo(null)}
                      className="rounded-[9px] border border-line2 bg-panel px-2.5 py-1.5 text-[12.5px] text-muted hover:border-accent hover:bg-raised"
                    >
                      先存着,稍后归类
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── issue list (staging on top, then grouped by status) ──────────────────────
function IssueList({ issues, selected, onSelect }: { issues: Issue[]; selected: string | null; onSelect: (id: string) => void }) {
  const staged = issues.filter((i) => i.projectId == null);
  const groups: { label: string; status: Issue["status"] }[] = [
    { label: "进行中", status: "in_progress" },
    { label: "待办", status: "open" },
    { label: "已完成", status: "done" },
  ];
  const row = (i: Issue) => (
    <button
      key={i.id}
      onClick={() => onSelect(i.id)}
      className={`flex w-full items-center gap-2.5 border-b border-line px-3.5 py-2.5 text-left ${
        i.id === selected ? "bg-[color-mix(in_srgb,var(--color-accent)_7%,#fff)] shadow-[inset_2px_0_0_var(--color-accent)]" : "hover:bg-raised"
      }`}
    >
      <IssueDot status={i.status} staged={i.projectId == null} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{i.title}</span>
      {i.projectId == null && (
        <span className="shrink-0 rounded-[5px] border border-[#f0e2bd] bg-[#fbf4e2] px-1.5 py-px text-[10.5px] text-[#9a7414]">未归类</span>
      )}
      {i.priority === "high" || i.priority === "urgent" ? <PriorityIcon p={i.priority} /> : null}
    </button>
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {staged.length > 0 && (
        <>
          <div className="px-3.5 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-wide text-[#9a7414]">
            未归类 · {staged.length} · 待选项目
          </div>
          {staged.map(row)}
        </>
      )}
      {groups.map((g) => {
        const items = issues.filter((i) => i.status === g.status && i.projectId != null);
        if (!items.length) return null;
        return (
          <div key={g.status}>
            <div className="px-3.5 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
              {g.label} · {items.length}
            </div>
            {items.map(row)}
          </div>
        );
      })}
    </div>
  );
}

// ── issue detail: meta + discussion (@execute) + derived tasks ───────────────
function IssueDetail({
  issue,
  projects,
  setIssues,
  onOpenTask,
  taskBump,
}: {
  issue: Issue;
  projects: ProjectView[];
  setIssues: React.Dispatch<React.SetStateAction<Issue[]>>;
  onOpenTask: (taskId: string) => void;
  taskBump: number;
}) {
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [execNote, setExecNote] = useState<string | null>(null);
  const project = projects.find((p) => p.id === issue.projectId) ?? null;

  useEffect(() => {
    api.issueComments(issue.id).then(setComments).catch(() => {});
  }, [issue.id]);
  useEffect(() => {
    api.issueTasks(issue.id).then(setTasks).catch(() => {});
  }, [issue.id, taskBump]);

  const patch = async (p: Partial<Issue>) => {
    const updated = await api.patchIssue(issue.id, p);
    setIssues((prev) => prev.map((x) => (x.id === issue.id ? updated : x)));
  };

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    const m = body.match(/@(claude|codex|antigravity)/i);
    const mention = m ? (m[1].toLowerCase() as AgentType) : undefined;
    setDraft("");
    try {
      const res = await api.postIssueComment(issue.id, { body, mention });
      setComments((prev) => [...prev, res.comment]);
      if (res.task) {
        setExecNote(`已派给 @${mention} · 任务运行中`);
        setIssues((prev) => prev.map((x) => (x.id === issue.id ? { ...x, status: "in_progress" } : x)));
        api.issueTasks(issue.id).then(setTasks).catch(() => {});
      }
    } catch (e) {
      // 422/409 etc. — e.g. 未归类不能执行
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const priLabel = PRIORITIES.find((p) => p.key === issue.priority)?.label ?? "无";

  return (
    <div className="h-full overflow-y-auto px-9 py-7">
      <div className="max-w-[780px]">
        <div className="mb-3.5 text-[12px] text-faint">{project?.name ?? "未归类"} › 事项</div>
        <div className="mb-4 flex items-start gap-3">
          <IssueDot status={issue.status} staged={issue.projectId == null} size={18} />
          <h2 className="text-[21px] font-semibold leading-snug text-ink">{issue.title}</h2>
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-2">
          <Pill
            icon={<IssueDot status={issue.status} size={11} />}
            label={ISSUE_STATUS_META[issue.status].label}
            value={issue.status}
            onChange={(v) => patch({ status: v as Issue["status"] })}
            options={[
              { value: "open", label: "待办" },
              { value: "in_progress", label: "进行中" },
              { value: "done", label: "已完成" },
              { value: "canceled", label: "已取消" },
            ]}
          />
          <Pill
            icon={<PriorityIcon p={issue.priority} />}
            label={priLabel}
            value={issue.priority}
            onChange={(v) => patch({ priority: v as Priority })}
            options={PRIORITIES.map((p) => ({ value: p.key, label: p.label }))}
          />
          <Pill
            icon={project ? <ProjectAvatar name={project.name} size={16} /> : undefined}
            label={project ? project.name : "⚠ 选择项目归类"}
            value={issue.projectId ?? ""}
            onChange={(v) => patch({ projectId: v })}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
          />
        </div>

        {issue.body && (
          <div className="markdown text-[14px] leading-7 text-[#33363d]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.body}</ReactMarkdown>
          </div>
        )}

        <div className="my-6 h-px bg-line" />

        {/* discussion */}
        <div className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold text-muted">
          💬 讨论 <span className="font-normal text-faint">· 对齐后 @ 智能体执行</span>
        </div>
        <div className="space-y-3.5">
          {comments.map((c) => {
            const ai = c.author.kind === "agent";
            const name = c.author.kind === "agent" ? `@${c.author.agentType}` : "我";
            return (
              <div key={c.id} className="flex gap-2.5">
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white ${ai ? "bg-accent" : "bg-muted"}`}>
                  {ai ? "C" : "我"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 text-[12px] text-muted">
                    <b className={`font-semibold ${ai ? "text-accent" : "text-ink"}`}>{name}</b>
                  </div>
                  <div className="text-[13.5px] leading-relaxed text-[#33363d]">{c.body}</div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex items-center gap-2 rounded-[10px] border border-line2 py-1.5 pl-3 pr-2">
          <button
            onClick={() => setDraft((d) => (d.trim() ? d.trim() + " " : "") + "@claude ")}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md font-bold text-accent hover:bg-raised"
            title="@ 智能体"
          >
            @
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="写评论一起讨论;输入 @claude 交给它执行"
            className="flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-faint"
          />
          <button onClick={send} className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-accent-fg">
            <ArrowUp size={14} weight="bold" />
          </button>
        </div>
        <div className="mt-1.5 text-[11.5px] text-faint">
          普通文字 = 评论讨论 · <b className="font-semibold text-accent">@claude</b> / <b className="font-semibold text-accent">@codex</b> = 交给它执行(把标题+描述+整条讨论一起打包发过去)
        </div>

        <div className="my-6 h-px bg-line" />

        {/* derived tasks */}
        <div className="mb-2 text-[12px] font-semibold text-muted">派生的执行(任务)</div>
        {execNote && <div className="mb-2 text-[12px] text-accent">{execNote}</div>}
        {tasks.length ? (
          <div className="space-y-2">
            {tasks.map((t) => (
              <button
                key={t.id}
                onClick={() => onOpenTask(t.id)}
                className="flex w-full items-center gap-2.5 rounded-[10px] border border-line bg-panel px-3 py-2.5 text-left hover:bg-raised"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${t.status === "done" ? "bg-emerald-500" : t.status === "failed" ? "bg-red-500" : "bg-amber-400 shadow-[0_0_0_3px_color-mix(in_srgb,theme(colors.amber.400)_22%,#fff)]"}`} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{t.title}</span>
                <span className="shrink-0 text-[12.5px] text-accent">在任务区打开 →</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-[10px] border border-dashed border-line2 p-3.5 text-[13px] text-faint">
            尚无派生执行 · 在上面输入框 <b className="text-accent">@claude</b> 交给它执行,会把标题、描述和整条讨论一起打包发给智能体,生成一个任务去跑
          </div>
        )}
      </div>
    </div>
  );
}
