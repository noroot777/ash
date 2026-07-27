import { useEffect, useMemo, useRef, useState } from "react";
import type { Issue, AiBackend, ProjectView, AgentExecutorProfile } from "@harness/shared";
import { ArrowUp, Robot, Sparkle, GearSix, Plus, CaretRight } from "@phosphor-icons/react";
import { api } from "./api";
import { Menu } from "./Menu";
import { PriorityIcon, ProjectAvatar, useCollapsedGroups } from "./ui";
import { toast } from "./toast";
import { usePasteAttachments, AttachmentChips, AttachButton } from "./pasteAttachments";
import { IssueDetail } from "./IssueDetail";
import { IssueDot } from "./issueBits";
import { executorDetail } from "./ExecutorPicker";

// hero 底部的下拉列的是「智能体执行器」面板里注册的具体执行器(claude@local /
// claude@公司自建 / codex@local…)。解析事项跟执行任务同一条路:都是派给某个执行器
// 跑一次 CLI,没有第二条直连 HTTP 的路。
const MANAGE_AGENTS = "__agents";
// 一个执行器都没注册时的兜底项:服务端会用内置的本地 claude 默认执行器。
const BUILTIN_DEFAULT = "";

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
      // 默认选 claude 的默认执行器(解析事项的老行为),没有就退到列表第一个。
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
                          detail: executorDetail(a),
                          icon: <Robot size={14} />,
                        }))
                      : [{ value: BUILTIN_DEFAULT, label: "@claude", detail: "内置默认 · 尚未注册执行器", icon: <Robot size={14} /> }]),
                    { value: MANAGE_AGENTS, label: "管理执行器…", detail: "注册执行器 / 配置供应商", icon: <GearSix size={14} /> },
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
