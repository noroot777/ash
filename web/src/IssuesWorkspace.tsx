import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Issue, IssueComment, Task, AgentType, AiBackend, ProjectView, Priority, AgentExecutorProfile } from "@harness/shared";
import { ArrowUp, Robot, Sparkle, Trash, PencilSimple, Check, GearSix, Plus, CaretRight } from "@phosphor-icons/react";
import { api } from "./api";
import { Menu, Pill } from "./Menu";
import { PriorityIcon, ProjectAvatar, useCollapsedGroups } from "./ui";
import { PRIORITIES } from "./constants";
import { ConfirmModal } from "./Modal";
import { toast } from "./toast";
import { usePasteAttachments, AttachmentChips, AttachButton, StoredAttachments } from "./pasteAttachments";

// hero 底部的下拉列的是「智能体执行器」面板里注册的具体执行者(claude@local /
// claude@公司中转 / codex@local…)。解析事项跟执行任务同一条路:都是派给某个执行者
// 跑一次 CLI,没有第二条直连 HTTP 的路。
const MANAGE_AGENTS = "__agents";
// 一个执行者都没注册时的兜底项:服务端会用内置的本地 claude 默认执行者。
const BUILTIN_DEFAULT = "";

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

// 正文恒为用户原文(逐行记的 1、2、3…)。markdown 会把段内单换行折叠成一行,所以把
// 段内单换行转成硬换行(行尾两空格),空行(段落分隔)保持不变 —— 不引第三方插件。
const mdBreaks = (s: string) => s.replace(/([^\n])\n(?!\n)/g, "$1  \n");

export function IssuesWorkspace({
  projects,
  projectId,
  issues,
  setIssues,
  selectedIssue,
  onSelectIssue,
  onOpenTask,
  taskBump,
  onOpenAgents,
}: {
  projects: ProjectView[];
  projectId: string | null;
  issues: Issue[];
  setIssues: React.Dispatch<React.SetStateAction<Issue[]>>;
  selectedIssue: string | null;
  onSelectIssue: (id: string | null) => void;
  onOpenTask: (taskId: string) => void;
  taskBump: number;
  onOpenAgents: () => void;
}) {
  // The list shows the current project's issues + every 未归类 (staging) issue.
  const visible = useMemo(
    () => issues.filter((i) => i.projectId === projectId || i.projectId == null),
    [issues, projectId],
  );
  // The detail pane stays within that SAME scope. `issues` holds every project's
  // issues (fetched unfiltered so 未归类 can surface anywhere), so a stale URL —
  // e.g. switching project without clearing ?issue= — could otherwise point at
  // another project's issue and leak it into the wrong project. Scoping `current`
  // to `visible` makes that show nothing here instead.
  const current = visible.find((i) => i.id === selectedIssue) ?? null;
  // Hero 草稿提到这里:未发送时切到别的 issue / 关掉 hero,再回来草稿还在(HeroComposer 卸载也不丢)。
  const [heroDraft, setHeroDraft] = useState("");
  const heroAtt = usePasteAttachments(); // 草稿里的附件也提到这层,跟着文字一起留存

  return (
    <div className="flex min-h-0 flex-1">
      {issues.length > 0 && (
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="sticky top-0 z-[2] flex items-center justify-between border-b border-line bg-panel px-3 py-2">
            <span className="text-[12px] font-medium text-muted">事项 · {visible.length}</span>
            <button
              onClick={() => onSelectIssue(null)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-medium text-accent hover:bg-raised"
              title="新建事项(回到输入框)"
            >
              <Plus size={13} weight="bold" /> 新事项
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
            onDeleted={() => {
              setIssues((prev) => prev.filter((x) => x.id !== current.id));
              onSelectIssue(null);
            }}
          />
        ) : (
          <HeroComposer
            projects={projects}
            text={heroDraft}
            setText={setHeroDraft}
            att={heroAtt}
            onOpenAgents={onOpenAgents}
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
  text,
  setText,
  att,
  onCreated,
  onAssignNeeded,
  patchIssueLocal,
  onSelectIssue,
  onOpenAgents,
}: {
  projects: ProjectView[];
  text: string;
  setText: (v: string) => void;
  att: ReturnType<typeof usePasteAttachments>;
  onCreated: (i: Issue) => void;
  onAssignNeeded: (i: Issue) => void;
  patchIssueLocal: (i: Issue) => void;
  onSelectIssue: (id: string | null) => void;
  onOpenAgents: () => void;
}) {
  const [executorId, setExecutorId] = useState(BUILTIN_DEFAULT);
  const [executors, setExecutors] = useState<AgentExecutorProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState(""); // submitted text shown as a bubble
  const [staged, setStaged] = useState<Issue | null>(null); // 未归类待选项目
  // 附件也提到 IssuesWorkspace(它不随 HeroComposer 卸载),粘贴的图随草稿一起留存。
  const { attachments, onPaste, addFiles, remove, clear, error } = att;
  const heroTitle = useRef(randomHero());
  const taRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    titleRef.current?.classList.add("is-shown");
    setTimeout(() => taRef.current?.focus(), 120);
    api.agents().then((list) => {
      setExecutors(list);
      // 默认选 claude 的默认执行者(解析事项的老行为),没有就退到列表第一个。
      const pick = list.find((a) => a.type === "claude" && a.isDefault) ?? list.find((a) => a.isDefault) ?? list[0];
      if (pick) setExecutorId((cur) => (cur === BUILTIN_DEFAULT ? pick.id : cur));
    }).catch(() => {});
  }, []);

  // hero 输入框随内容自动增高(上限 40vh,超出滚动)。
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  const selected = executors.find((a) => a.id === executorId) ?? null;
  const backend: AiBackend | undefined = executorId ? { executorId } : undefined;
  const backendLabel = selected?.name ?? "@claude";

  const submit = async () => {
    const t = text.trim();
    if ((!t && !attachments.length) || busy) return;
    setBusy(true);
    setUser(t || "(附件)");
    titleRef.current?.classList.add("is-hiding");
    try {
      const issue = await api.createIssue({ text: t || "(见附件)", backend, attachments: attachments.map((a) => a.path) });
      clear();
      setText(""); // 草稿已落成事项,清空
      if (issue.projectId == null) {
        onAssignNeeded(issue);
        setStaged(issue); // 让用户归类,不自动落定
      } else {
        onCreated(issue); // 选中它 → 主区切到详情
      }
    } catch (e) {
      toast("创建失败:" + (e instanceof Error ? e.message : String(e)));
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
      toast("归类失败:" + (e instanceof Error ? e.message : String(e)));
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
                  onPaste={onPaste}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder="随手写下要做的事…（可粘贴或选择图片/文件）"
                  className="min-h-[50px] w-full resize-none bg-transparent text-[16px] leading-relaxed text-ink outline-none placeholder:text-faint"
                />
                <AttachmentChips attachments={attachments} onRemove={remove} error={error} />
              </div>
              <div className="flex items-center gap-1.5 px-3 pb-3 pt-2">
                <AttachButton addFiles={addFiles} className="grid h-[30px] w-[30px] place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink" />
                <Menu
                  value={executorId}
                  onChange={(v) => (v === MANAGE_AGENTS ? onOpenAgents() : setExecutorId(v))}
                  menuWidth={260}
                  options={[
                    ...(executors.length
                      ? executors.map((a) => ({
                          value: a.id,
                          label: a.name,
                          detail: [a.type, a.model, a.providerId ? "中转站" : null].filter(Boolean).join(" · "),
                          icon: <Robot size={14} />,
                        }))
                      : [{ value: BUILTIN_DEFAULT, label: "@claude", detail: "内置默认 · 尚未注册执行者", icon: <Robot size={14} /> }]),
                    { value: MANAGE_AGENTS, label: "管理执行器…", detail: "注册执行者 / 配置中转站", icon: <GearSix size={14} /> },
                  ]}
                  triggerClassName="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] text-muted hover:bg-raised hover:text-ink"
                >
                  <Robot size={14} /> {backendLabel}
                  <span className="text-[10px] text-faint">▾</span>
                </Menu>
                <span className="flex-1" />
                <button
                  onClick={submit}
                  disabled={!text.trim() && !attachments.length}
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
                  <span className="t-shimmer" data-text="识别意图、匹配项目、提炼标题…">
                    识别意图、匹配项目、提炼标题…
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
  const { collapsed, toggle } = useCollapsedGroups("harness:issueList:collapsedGroups");
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
  // A folding section header — matches the task list's caret affordance so both
  // grouped lists behave the same. `tone` colors the 未归类 header amber; `hint`
  // is the lighter trailing nudge (e.g. 待选项目).
  const header = (key: string, label: string, count: number, tone: "amber" | "faint", hint?: string) => {
    const isCollapsed = collapsed.has(key);
    return (
      <button
        onClick={() => toggle(key)}
        className={`flex w-full items-center gap-1 px-3.5 pb-1.5 pt-3 text-left text-[10.5px] font-semibold uppercase tracking-wide ${
          tone === "amber" ? "text-[#9a7414]" : "text-faint"
        }`}
        title={isCollapsed ? "展开这一组" : "折叠这一组"}
      >
        <span>{label} · {count}{hint ? <span className="font-normal opacity-70"> · {hint}</span> : null}</span>
        <CaretRight size={10} weight="bold" className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
      </button>
    );
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {staged.length > 0 && (
        <>
          {header("staged", "未归类", staged.length, "amber", "待选项目")}
          {!collapsed.has("staged") && staged.map(row)}
        </>
      )}
      {groups.map((g) => {
        const items = issues.filter((i) => i.status === g.status && i.projectId != null);
        if (!items.length) return null;
        return (
          <div key={g.status}>
            {header(g.status, g.label, items.length, "faint")}
            {!collapsed.has(g.status) && items.map(row)}
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
  onDeleted,
}: {
  issue: Issue;
  projects: ProjectView[];
  setIssues: React.Dispatch<React.SetStateAction<Issue[]>>;
  onOpenTask: (taskId: string) => void;
  taskBump: number;
  onDeleted: () => void;
}) {
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [execNote, setExecNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false); // 编辑标题+描述
  const [editTitle, setEditTitle] = useState(issue.title);
  const [editBody, setEditBody] = useState(issue.body);
  const [confirmDel, setConfirmDel] = useState(false);
  const { attachments, onPaste, addFiles, remove, clear, error } = usePasteAttachments();
  const editAtt = usePasteAttachments(); // 编辑态新加的附件(与下方评论框那套独立)
  const [editAttachments, setEditAttachments] = useState<string[]>(issue.attachments); // 编辑态保留的已有附件
  const [execWorktree, setExecWorktree] = useState(false); // @执行是否隔离到 worktree(默认否,对齐任务的 opt-in)
  const project = projects.find((p) => p.id === issue.projectId) ?? null;

  useEffect(() => {
    api.issueComments(issue.id).then(setComments).catch(() => {});
  }, [issue.id]);
  useEffect(() => {
    api.issueTasks(issue.id).then(setTasks).catch(() => {});
  }, [issue.id, taskBump]);
  // discuss 回复是异步的:插入 pending 气泡 → 后台 CLI 跑完 update body+status。
  // 本地轮询就够 —— pending 存在就 3s 拉一次;全 done/failed 就停。
  const hasPending = comments.some((c) => c.status === "pending");
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => {
      api.issueComments(issue.id).then(setComments).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [hasPending, issue.id]);

  const patch = async (p: Partial<Issue>) => {
    const updated = await api.patchIssue(issue.id, p);
    setIssues((prev) => prev.map((x) => (x.id === issue.id ? updated : x)));
  };

  const startEdit = () => {
    setEditTitle(issue.title);
    setEditBody(issue.body);
    setEditAttachments(issue.attachments);
    editAtt.clear();
    setEditing(true);
  };
  const saveEdit = async () => {
    const t = editTitle.trim();
    if (!t) return;
    await patch({ title: t, body: editBody, attachments: [...editAttachments, ...editAtt.attachments.map((a) => a.path)] });
    editAtt.clear();
    setEditing(false);
  };
  const del = async () => {
    try {
      await api.deleteIssue(issue.id);
      onDeleted();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body && !attachments.length) return;
    const m = body.match(/@(claude|codex|antigravity)/i);
    const mention = m ? (m[1].toLowerCase() as AgentType) : undefined;
    const paths = attachments.map((a) => a.path);
    setDraft("");
    clear();
    try {
      const res = await api.postIssueComment(issue.id, { body, mention, attachments: paths, useWorktree: execWorktree });
      setComments((prev) => [...prev, res.comment, ...(res.agentComment ? [res.agentComment] : [])]);
      if (res.task) {
        setExecNote(`已派给 @${mention} · 任务运行中`);
        setIssues((prev) => prev.map((x) => (x.id === issue.id ? { ...x, status: "in_progress" } : x)));
        api.issueTasks(issue.id).then(setTasks).catch(() => {});
      }
    } catch (e) {
      // 422/409 etc. — e.g. 未归类不能执行
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const onCommentUpdated = (c: IssueComment) => setComments((prev) => prev.map((x) => (x.id === c.id ? c : x)));
  const onCommentDeleted = (cid: string) => setComments((prev) => prev.filter((x) => x.id !== cid));

  const priLabel = PRIORITIES.find((p) => p.key === issue.priority)?.label ?? "无";

  return (
    <div className="h-full overflow-y-auto px-9 py-7">
      <div className="max-w-[780px]">
        <div className="mb-3.5 flex items-center text-[12px] text-faint">
          <span>{project?.name ?? "未归类"} › 事项</span>
          <span className="flex-1" />
          {!editing && (
            <span className="flex items-center gap-1">
              <button
                onClick={startEdit}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
                title="编辑标题与描述"
              >
                <PencilSimple size={13} /> 编辑
              </button>
              <button
                onClick={() => setConfirmDel(true)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-red-600"
                title="删除事项"
              >
                <Trash size={13} /> 删除
              </button>
            </span>
          )}
        </div>

        {editing ? (
          <div className="mb-4">
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="mb-2 w-full rounded-[10px] border border-line2 bg-canvas px-3 py-2 text-[19px] font-semibold text-ink outline-none focus:border-accent"
              placeholder="标题"
            />
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              onPaste={editAtt.onPaste}
              rows={8}
              className="w-full resize-y rounded-[10px] border border-line2 bg-canvas px-3 py-2 text-[14px] leading-7 text-ink outline-none focus:border-accent"
              placeholder="描述(支持 Markdown,可粘贴图片)"
            />
            {(editAttachments.length > 0 || editAtt.attachments.length > 0) && (
              <div className="mt-2">
                <div className="mb-1 text-[11px] text-faint">附件(× 删除,可粘贴/选择新增)</div>
                <StoredAttachments paths={editAttachments} onRemove={(p) => setEditAttachments((xs) => xs.filter((x) => x !== p))} />
                <AttachmentChips attachments={editAtt.attachments} onRemove={editAtt.remove} error={editAtt.error} />
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <AttachButton addFiles={editAtt.addFiles} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink" />
              <span className="flex-1" />
              <button onClick={() => setEditing(false)} className="rounded-md px-3 py-1.5 text-[13px] text-muted hover:bg-raised">
                取消
              </button>
              <button
                onClick={saveEdit}
                disabled={!editTitle.trim()}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
              >
                <Check size={14} weight="bold" /> 保存
              </button>
            </div>
          </div>
        ) : (
          <div className="mb-4 flex items-start gap-3">
            <IssueDot status={issue.status} staged={issue.projectId == null} size={18} />
            <h2 className="text-[21px] font-semibold leading-snug text-ink">{issue.title}</h2>
          </div>
        )}

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

        {!editing && issue.body && (
          <div className="markdown text-[14px] leading-7 text-[#33363d]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{mdBreaks(issue.body)}</ReactMarkdown>
          </div>
        )}
        {!editing && issue.attachments.length > 0 && <StoredAttachments paths={issue.attachments} className="mt-3" />}

        <div className="my-6 h-px bg-line" />

        {/* discussion */}
        <div className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold text-muted">
          💬 讨论 <span className="font-normal text-faint">· 对齐后 @ 智能体执行</span>
        </div>
        <div className="space-y-3.5">
          {comments.map((c) => (
            <CommentItem key={c.id} issueId={issue.id} comment={c} onUpdated={onCommentUpdated} onDeleted={onCommentDeleted} />
          ))}
        </div>
        <div className="mt-2 rounded-[10px] border border-line2 px-3 py-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDraft((d) => (d.trim() ? d.trim() + " " : "") + "@claude ")}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md font-bold text-accent hover:bg-raised"
              title="@ 智能体"
            >
              @
            </button>
            <AttachButton addFiles={addFiles} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="写评论一起讨论;@claude 交给它执行(可粘贴/选择附件)"
              className="flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-faint"
            />
            <button onClick={send} className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-accent-fg">
              <ArrowUp size={14} weight="bold" />
            </button>
          </div>
          <AttachmentChips attachments={attachments} onRemove={remove} error={error} />
        </div>
        <div className="mt-1.5 text-[11.5px] text-faint">
          普通文字 = 评论讨论 · <b className="font-semibold text-accent">@claude</b> / <b className="font-semibold text-accent">@codex</b> = 交给它执行(把标题+描述+整条讨论一起打包发过去)
        </div>
        {project?.health.isRepo && (
          <label className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-faint" title="默认直接在项目仓库改;开启则隔离到 harness/<id8> 分支(你自行 merge),并能在下方看到它的提交">
            <button
              type="button"
              onClick={() => setExecWorktree((v) => !v)}
              className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors ${execWorktree ? "bg-accent" : "bg-line2"}`}
              aria-pressed={execWorktree}
            >
              <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-panel transition-all ${execWorktree ? "left-3" : "left-0.5"}`} />
            </button>
            @执行用 worktree 隔离 · {execWorktree ? "改动落在独立分支(你自行 merge)" : "默认直接改主仓库"}
          </label>
        )}

        <div className="my-6 h-px bg-line" />

        {/* derived tasks */}
        <div className="mb-2 text-[12px] font-semibold text-muted">派生的执行(任务)</div>
        {execNote && <div className="mb-2 text-[12px] text-accent">{execNote}</div>}
        {tasks.length ? (
          <div className="space-y-2">
            {tasks.map((t) => (
              <div key={t.id}>
                <button
                  onClick={() => onOpenTask(t.id)}
                  className="flex w-full items-center gap-2.5 rounded-[10px] border border-line bg-panel px-3 py-2.5 text-left hover:bg-raised"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${t.status === "done" ? "bg-emerald-500" : t.status === "failed" ? "bg-red-500" : "bg-amber-400 shadow-[0_0_0_3px_color-mix(in_srgb,theme(colors.amber.400)_22%,#fff)]"}`} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{t.title}</span>
                  <span className="shrink-0 text-[12.5px] text-accent">在任务区打开 →</span>
                </button>
                <TaskCommits taskId={t.id} bump={taskBump} />
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-[10px] border border-dashed border-line2 p-3.5 text-[13px] text-faint">
            尚无派生执行 · 在上面输入框 <b className="text-accent">@claude</b> 交给它执行,会把标题、描述和整条讨论一起打包发给智能体,生成一个任务去跑
          </div>
        )}
      </div>
      {confirmDel && (
        <ConfirmModal
          title="删除事项"
          message="删除这条事项?讨论评论会一起删除(已派生的任务保留)。"
          confirmLabel="删除"
          danger
          onConfirm={del}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </div>
  );
}

// ── one discussion comment: shows body + attachments, with edit/delete ───────
// Show the branch + commits a derived task produced on its isolated worktree —
// the concrete issue → code link. Silent when the task ran in place (no worktree).
function TaskCommits({ taskId, bump }: { taskId: string; bump: number }) {
  const [data, setData] = useState<{ branch: string | null; commits: { sha: string; subject: string; at: string }[] } | null>(null);
  useEffect(() => {
    api.taskCommits(taskId).then(setData).catch(() => {});
  }, [taskId, bump]);
  if (!data || (!data.branch && data.commits.length === 0)) return null;
  return (
    <div className="ml-3 mt-1 border-l-2 border-line pl-3">
      {data.branch && (
        <div className="text-[11.5px] text-faint">
          分支 <code className="rounded bg-overlay px-1 text-[11px] text-muted">{data.branch}</code>
          {data.commits.length > 0 && <span> · {data.commits.length} 个提交</span>}
        </div>
      )}
      {data.commits.map((c) => (
        <div key={c.sha} className="flex items-center gap-2 py-0.5 text-[12px]">
          <code className="shrink-0 text-[11px] text-accent">{c.sha.slice(0, 7)}</code>
          <span className="truncate text-muted">{c.subject}</span>
        </div>
      ))}
    </div>
  );
}

function CommentItem({
  issueId,
  comment,
  onUpdated,
  onDeleted,
}: {
  issueId: string;
  comment: IssueComment;
  onUpdated: (c: IssueComment) => void;
  onDeleted: (cid: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  const [confirmDel, setConfirmDel] = useState(false);
  const { attachments, onPaste, addFiles, remove, clear, error } = usePasteAttachments();
  const [keepAttachments, setKeepAttachments] = useState<string[]>(comment.attachments); // 编辑态保留的已有附件
  const ai = comment.author.kind === "agent";
  const name = comment.author.kind === "agent" ? `@${comment.author.agentType}` : "我";

  const startEdit = () => {
    setText(comment.body);
    setKeepAttachments(comment.attachments);
    clear();
    setEditing(true);
  };
  const save = async () => {
    const nextAttachments = [...keepAttachments, ...attachments.map((a) => a.path)];
    const updated = await api.patchIssueComment(issueId, comment.id, { body: text.trim(), attachments: nextAttachments });
    onUpdated(updated);
    setEditing(false);
  };
  const del = async () => {
    await api.deleteIssueComment(issueId, comment.id);
    onDeleted(comment.id);
  };

  return (
    <div className="group flex gap-2.5">
      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white ${ai ? "bg-accent" : "bg-muted"}`}>
        {ai ? "C" : "我"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2 text-[12px] text-muted">
          <b className={`font-semibold ${ai ? "text-accent" : "text-ink"}`}>{name}</b>
          {comment.updatedAt && <span className="text-[10.5px] text-faint">已编辑</span>}
          {!editing && !ai && (
            <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button onClick={startEdit} className="grid h-6 w-6 place-items-center rounded text-faint hover:bg-raised hover:text-ink" title="编辑">
                <PencilSimple size={12} />
              </button>
              <button onClick={() => setConfirmDel(true)} className="grid h-6 w-6 place-items-center rounded text-faint hover:bg-raised hover:text-red-600" title="删除">
                <Trash size={12} />
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={onPaste}
              rows={3}
              className="w-full resize-y rounded-[8px] border border-line2 bg-canvas px-2.5 py-1.5 text-[13.5px] leading-relaxed text-ink outline-none focus:border-accent"
            />
            {keepAttachments.length > 0 && (
              <StoredAttachments paths={keepAttachments} onRemove={(p) => setKeepAttachments((xs) => xs.filter((x) => x !== p))} className="mt-2" />
            )}
            <AttachmentChips attachments={attachments} onRemove={remove} error={error} />
            <div className="mt-1.5 flex items-center gap-2">
              <AttachButton addFiles={addFiles} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink" />
              <span className="flex-1" />
              <button onClick={() => setEditing(false)} className="rounded-md px-2.5 py-1 text-[12.5px] text-muted hover:bg-raised">
                取消
              </button>
              <button
                onClick={save}
                disabled={!text.trim() && !keepAttachments.length && !attachments.length}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12.5px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
              >
                <Check size={12} weight="bold" /> 保存
              </button>
            </div>
          </div>
        ) : (
          <>
            {ai && comment.status === "pending" ? (
              <div className="text-[13.5px] italic text-faint">…正在思考</div>
            ) : ai && comment.status === "failed" ? (
              <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-red-600/80">
                {comment.body || "讨论回复失败"}
              </div>
            ) : comment.body ? (
              <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-[#33363d]">{comment.body}</div>
            ) : null}
            {comment.attachments.length > 0 && <StoredAttachments paths={comment.attachments} className="mt-1.5" />}
          </>
        )}
      </div>
      {confirmDel && (
        <ConfirmModal
          title="删除评论"
          message="删除这条评论?"
          confirmLabel="删除"
          danger
          onConfirm={del}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </div>
  );
}
