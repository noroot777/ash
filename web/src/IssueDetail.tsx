import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Issue, IssueComment, Task, AgentType, Priority, ProjectView } from "@harness/shared";
import { ArrowUp, Robot, Trash, PencilSimple, Check, UsersThree } from "@phosphor-icons/react";
import { api } from "./api";
import { Menu, Pill } from "./Menu";
import { PriorityIcon, ProjectAvatar } from "./ui";
import { PRIORITIES } from "./constants";
import { ConfirmModal } from "./Modal";
import { toast } from "./toast";
import { usePasteAttachments, AttachmentChips, AttachButton } from "./pasteAttachments";
import { IssueDot, ISSUE_STATUS_META, mdBreaks } from "./issueBits";
import { AttachmentDisplay, parseAttachmentText } from "./messageAttachments";
import { PreviewableMarkdownImage } from "./ImagePreview";

// ── issue detail: meta + discussion (@execute) + derived tasks ───────────────
export function IssueDetail({
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
  // 「带一队」= 被 @ 的那个类型当调度者派一队执行者(mode:"team")。它是**用户显式选**的
  // (@ 菜单里的第二行),不从文字里猜 —— 手打 `@claude` 永远是自己干。
  const [mentionTeam, setMentionTeam] = useState(false);
  // 打开 @ 菜单才探测本机装了哪些 CLI:哪些能自己干、哪些能带队(带队要支持常驻会话),
  // 这份名单只有执行器层知道,前端别自己抄。
  const [detected, setDetected] = useState<{ type: AgentType; available: boolean; resident: boolean }[] | null>(null);
  const project = projects.find((p) => p.id === issue.projectId) ?? null;
  const issueContent = parseAttachmentText(issue.body);
  const issueAttachments = [...issueContent.paths, ...issue.attachments];

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
    const asTeam = !!mention && mentionTeam;
    const paths = attachments.map((a) => a.path);
    setDraft("");
    setMentionTeam(false);
    clear();
    try {
      const res = await api.postIssueComment(issue.id, {
        body,
        mention,
        // 带一队时不给调度台开 worktree(执行者跑在项目目录,只挪走调度者会让两边看到
        // 不同的文件);要隔离由调度者派活时逐个开。
        ...(asTeam ? { mentionTeam: true } : {}),
        attachments: paths,
        useWorktree: asTeam ? false : execWorktree,
      });
      setComments((prev) => [...prev, res.comment, ...(res.agentComment ? [res.agentComment] : [])]);
      if (res.task) {
        setExecNote(`已派给 @${mention}${asTeam ? " · 带一队(调度台已上线)" : ""} · 任务运行中`);
        setIssues((prev) => prev.map((x) => (x.id === issue.id ? { ...x, status: "in_progress" } : x)));
        api.issueTasks(issue.id).then(setTasks).catch(() => {});
      }
    } catch (e) {
      // 422/409 etc. — e.g. 未归类不能执行
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  // @ 菜单:每个装了的 CLI 一行「自己干」,支持常驻会话的再多一行「带一队」(能当调度者)。
  // 名单来自 /api/agents/detect —— 「谁能带队」只有执行器层知道,前端不抄。
  const mentionOptions = useMemo(() => {
    const ok = (detected ?? []).filter((d) => d.available);
    // 探测还没回来(或失败)时先按内置默认的本地 claude 画,detected 到了自己纠正。
    const list = ok.length ? ok : [{ type: "claude" as AgentType, available: true, resident: true }];
    return [
      ...list.map((d) => ({
        value: d.type,
        label: `@${d.type} · 自己干`,
        detail: "一个 agent 把这件事做完",
        icon: <Robot size={14} />,
      })),
      ...list
        .filter((d) => d.resident)
        .map((d) => ({
          value: `${d.type}:team`,
          label: `@${d.type} · 带一队`,
          detail: "常驻调度台,自己拆活派执行者,你随时插话",
          icon: <UsersThree size={14} className="text-accent" />,
        })),
    ];
  }, [detected]);

  const pickMention = (v: string) => {
    const [type, kind] = v.split(":");
    setMentionTeam(kind === "team");
    // 换 @ 对象时把已有的 @xxx 摘掉再追加,避免一句话里挂两个 mention(send 取第一个)
    setDraft((d) => {
      const rest = d.replace(/@(claude|codex|antigravity)\b/gi, "").trim();
      return (rest ? rest + " " : "") + `@${type} `;
    });
  };
  const draftMention = draft.match(/@(claude|codex|antigravity)\b/i);
  const mentionValue = draftMention ? `${draftMention[1].toLowerCase()}${mentionTeam ? ":team" : ""}` : "";

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
                <AttachmentDisplay paths={editAttachments} onRemove={(p) => setEditAttachments((xs) => xs.filter((x) => x !== p))} />
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

        {!editing && issueContent.body && (
          <div className="markdown text-[14px] leading-7 text-[#33363d]">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: PreviewableMarkdownImage }}>
              {mdBreaks(issueContent.body)}
            </ReactMarkdown>
          </div>
        )}
        {!editing && <AttachmentDisplay paths={issueAttachments} className={issueContent.body ? "mt-3" : ""} />}

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
            {/* 点开才探测本机 CLI —— 几个 which + --version,不值得每次打开事项都跑 */}
            <span
              className="contents"
              onClick={() => {
                if (!detected) api.detectAgents().then(setDetected, () => setDetected([]));
              }}
            >
              <Menu
                value={mentionValue}
                onChange={pickMention}
                options={mentionOptions}
                menuWidth={252}
                triggerClassName="grid h-7 w-7 shrink-0 place-items-center rounded-md font-bold text-accent hover:bg-raised"
              >
                @
              </Menu>
            </span>
            <AttachButton addFiles={addFiles} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="写评论一起讨论;@claude 交给它执行(可粘贴/选择附件)"
              className="flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-faint"
            />
            {mentionTeam && (
              <button
                onClick={() => setMentionTeam(false)}
                title="改回「自己干」(一个 agent 做完)"
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20"
              >
                <UsersThree size={12} /> 带一队 ✕
              </button>
            )}
            <button onClick={send} className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-accent-fg">
              <ArrowUp size={14} weight="bold" />
            </button>
          </div>
          <AttachmentChips attachments={attachments} onRemove={remove} error={error} />
        </div>
        <div className="mt-1.5 text-[11.5px] text-faint">
          普通文字 = 评论讨论 · <b className="font-semibold text-accent">@claude</b> / <b className="font-semibold text-accent">@codex</b> = 交给它执行(把标题+描述+整条讨论一起打包发过去) · 点 <b className="font-semibold text-accent">@</b> 可以选「带一队」(调度台带执行者)
        </div>
        {project?.health.isRepo && !mentionTeam && (
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
  const content = parseAttachmentText(comment.body);
  const displayAttachments = [...content.paths, ...comment.attachments];

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
              <AttachmentDisplay paths={keepAttachments} onRemove={(p) => setKeepAttachments((xs) => xs.filter((x) => x !== p))} className="mt-2" />
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
                {content.body || "讨论回复失败"}
              </div>
            ) : content.body ? (
              <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-[#33363d]">{content.body}</div>
            ) : null}
            <AttachmentDisplay paths={displayAttachments} className="mt-1.5" />
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
