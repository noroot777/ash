import { useEffect, useMemo, useState } from "react";
import type { Task } from "@harness/shared";
import { taskDisplayStatus } from "@harness/shared";
import {
  CaretDown,
  FileCode,
  GitBranch,
  GitCommit,
  GitDiff,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { LegacyLink } from "../components/LegacyLink.tsx";
import { api, type TaskCommit, type TaskDiffResult } from "../lib/api.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { AcceptanceControls } from "../team/TeamReviewWorkspace.tsx";
import { ReviewEvidence } from "../team/ReviewEvidence.tsx";
import { formatInstant, parseAttachmentText } from "../task-detail/utils.ts";
import { sharedTeamParent } from "./reviewModel.ts";

type ReviewData = {
  branch: string | null;
  commits: TaskCommit[];
  diff: TaskDiffResult;
};

type DiffSection = {
  file: TaskDiffResult["files"][number];
  body: string;
};

type DiffLine = {
  kind: "add" | "delete" | "context" | "hunk" | "meta";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

const INITIAL_FILE_COUNT = 120;
const INITIAL_LINE_COUNT = 360;

function splitDiff(result: TaskDiffResult): DiffSection[] {
  const starts = [...result.diff.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0);
  const bodies = starts.map((start, index) =>
    result.diff.slice(start, starts[index + 1] ?? result.diff.length).trimEnd(),
  );
  if (!result.files.length && bodies.length) {
    return bodies.map((body, index) => ({
      file: { path: `diff-${index + 1}`, additions: null, deletions: null },
      body,
    }));
  }
  return result.files.map((file, index) => ({ file, body: bodies[index] ?? "" }));
}

function parseDiffLines(text: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return text.split("\n").map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { kind: "hunk", oldLine: null, newLine: null, text: line };
    }
    if (!inHunk || line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
      return { kind: "meta", oldLine: null, newLine: null, text: line };
    }
    if (line.startsWith("+")) {
      const row = { kind: "add" as const, oldLine: null, newLine, text: line };
      newLine += 1;
      return row;
    }
    if (line.startsWith("-")) {
      const row = { kind: "delete" as const, oldLine, newLine: null, text: line };
      oldLine += 1;
      return row;
    }
    if (line.startsWith("\\ No newline")) {
      return { kind: "meta", oldLine: null, newLine: null, text: line };
    }
    const row = { kind: "context" as const, oldLine, newLine, text: line };
    oldLine += 1;
    newLine += 1;
    return row;
  });
}

function diffReason(reason?: string): string {
  const labels: Record<string, string> = {
    not_git_repo: "项目不是 Git 仓库",
    target_unresolved: "无法确定目标分支",
    source_branch_missing: "任务分支不存在或已清理",
    target_branch_missing: "合入目标不存在",
    no_merge_base: "源分支与目标分支没有共同基点",
  };
  return labels[reason ?? ""] ?? reason ?? "未知原因";
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(value / 1024)} KB`;
}

function BranchFacts({ task, data }: { task: Task; data: ReviewData | null }) {
  const source = data?.diff.sourceBranch || data?.branch || "项目当前分支";
  const target = data?.diff.targetBranch || task.worktreeBase || "项目当前分支";
  return (
    <dl className="single-review-facts">
      <div><dt>源分支</dt><dd><GitBranch size={12} />{source}</dd></div>
      <div><dt>合入目标</dt><dd>{target}</dd></div>
      <div><dt>比较基点</dt><dd>{data?.diff.mergeBase?.slice(0, 12) || "由服务端解析"}</dd></div>
    </dl>
  );
}

function SharedWorkerFacts({ parent, branch }: { parent: Task; branch: string | null }) {
  const params = new URLSearchParams({ project: parent.projectId, task: parent.id });
  return (
    <>
      <dl className="single-review-facts">
        <div><dt>执行归属</dt><dd>{parent.title}</dd></div>
        <div><dt>共享分支</dt><dd><GitBranch size={12} />{branch || "由父团队统一管理"}</dd></div>
        <div><dt>验收方式</dt><dd>随父团队整体验收</dd></div>
      </dl>
      <div className="single-review-shared-note">
        <div><b>该执行者不单独合入</b><p>代码与同组执行者共同位于父团队共享分支，无法可靠按单个执行者切分 diff。请结合下方审查证据，在团队验收台核对共享改动并统一验收。</p></div>
        <a href={`/?${params.toString()}`}>打开父团队</a>
      </div>
    </>
  );
}

function CommitList({ branch, commits }: { branch: string | null; commits: TaskCommit[] }) {
  return (
    <section className="single-review-commits">
      <header><span><GitCommit size={13} />提交</span><b>{commits.length}</b></header>
      {branch && <code className="single-review-branch" title={branch}>{branch}</code>}
      {!commits.length && <p>没有可归属到该任务分支的提交。</p>}
      {commits.map((commit) => (
        <article key={commit.sha}>
          <code>{commit.sha.slice(0, 8)}</code>
          <div><b>{commit.subject}</b><time>{formatInstant(commit.at)}</time></div>
        </article>
      ))}
    </section>
  );
}

function FileRail({
  sections,
  selected,
  onSelect,
}: {
  sections: DiffSection[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const [visible, setVisible] = useState(INITIAL_FILE_COUNT);
  useEffect(() => setVisible(INITIAL_FILE_COUNT), [sections]);
  return (
    <section className="single-review-files">
      <header><span><FileCode size={13} />改动文件</span><b>{sections.length}</b></header>
      <div>
        {sections.slice(0, visible).map((section, index) => (
          <button
            type="button"
            key={`${section.file.path}-${index}`}
            className={selected === index ? "is-selected" : ""}
            onClick={() => onSelect(index)}
          >
            <code title={section.file.path}>{section.file.path}</code>
            <span><i>+{section.file.additions ?? "?"}</i><em>−{section.file.deletions ?? "?"}</em></span>
          </button>
        ))}
      </div>
      {visible < sections.length && (
        <button type="button" className="single-review-load" onClick={() => setVisible((count) => count + INITIAL_FILE_COUNT)}>
          再显示 {Math.min(INITIAL_FILE_COUNT, sections.length - visible)} 个文件
        </button>
      )}
    </section>
  );
}

function DiffViewer({ result }: { result: TaskDiffResult }) {
  const sections = useMemo(() => splitDiff(result), [result]);
  const [selected, setSelected] = useState(0);
  const [visibleLines, setVisibleLines] = useState(INITIAL_LINE_COUNT);
  useEffect(() => {
    setSelected(0);
    setVisibleLines(INITIAL_LINE_COUNT);
  }, [result]);
  const section = sections[selected];
  const lines = useMemo(() => parseDiffLines(section?.body ?? ""), [section?.body]);
  const additions = result.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = result.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  if (!result.available) {
    return <div className="single-review-empty">无法生成分支 diff：{diffReason(result.reason)}</div>;
  }
  if (!sections.length) {
    return <div className="single-review-empty">任务分支相对基线没有文件改动。</div>;
  }
  return (
    <div className="single-review-diff-layout">
      <FileRail sections={sections} selected={selected} onSelect={(index) => { setSelected(index); setVisibleLines(INITIAL_LINE_COUNT); }} />
      <section className="single-review-diff">
        <header>
          <div><GitDiff size={14} /><b>{section.file.path}</b></div>
          <span><i>+{section.file.additions ?? "?"}</i><em>−{section.file.deletions ?? "?"}</em></span>
          <small>总计 +{additions} −{deletions}</small>
        </header>
        {result.truncated && (
          <div className="single-review-warning"><WarningCircle size={13} weight="fill" />diff 超过 {formatBytes(result.limitBytes)}，这里只展示服务端返回的截断内容。</div>
        )}
        {!section.body ? (
          <p className="single-review-empty">{result.truncated ? "该文件未包含在截断响应中。" : "没有文本 diff，可能是二进制文件。"}</p>
        ) : (
          <div className="single-review-code" role="table" aria-label={`${section.file.path} diff`}>
            {lines.slice(0, visibleLines).map((line, index) => (
              <div className={`single-review-line is-${line.kind}`} role="row" key={index}>
                <span className="single-review-old" role="cell">{line.oldLine ?? ""}</span>
                <span className="single-review-new" role="cell">{line.newLine ?? ""}</span>
                <code role="cell">{line.text || " "}</code>
              </div>
            ))}
            {visibleLines < lines.length && (
              <button type="button" className="single-review-more-lines" onClick={() => setVisibleLines((count) => count + INITIAL_LINE_COUNT)}>
                展开后续 {Math.min(INITIAL_LINE_COUNT, lines.length - visibleLines)} 行
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export function TaskReviewWorkspace({
  task,
  allTasks,
  onClose,
  onTaskUpdated,
  notify,
}: {
  task: Task;
  allTasks: Task[];
  onClose: () => void;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [sharedBranch, setSharedBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const objective = parseAttachmentText(task.body);
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const sharedParent = sharedTeamParent(task, allTasks);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    setSharedBranch(null);
    const request = sharedParent
      ? api.taskCommits(sharedParent.id).then((commits) => { if (alive) setSharedBranch(commits.branch); })
      : Promise.all([api.taskCommits(task.id), api.taskDiff(task.id)]).then(
      ([commits, diff]) => {
        if (alive) setData({ branch: commits.branch, commits: commits.commits, diff });
      });
    request.then(
      () => undefined,
      (reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sharedParent?.id, task.id, task.updatedAt]);

  return (
    <section className="single-review-workspace">
      <header className="single-review-subbar">
        <div><b>{sharedParent ? "共享执行者审查" : "改动与提交"}</b><small>{sharedParent ? "该执行者随父团队共享分支统一验收" : "核对真实审查证据与任务分支相对基线的 diff"}</small></div>
        <LegacyLink projectId={task.projectId} taskId={task.id} view="review" />
        <button type="button" onClick={onClose}><X size={13} />返回对话</button>
      </header>
      <div className="single-review-scroll">
        <article className="single-review-card">
          <header className="single-review-card-head">
            <CaretDown size={13} weight="bold" />
            <i className="single-review-stage-dot" />
            <div>
              <span><b>{task.title}</b><em>{sharedParent ? "共享执行者" : "单任务"}</em><small>{display.label}</small></span>
              <p>{objective.body.trim() || "未填写任务目标"}</p>
            </div>
            {sharedParent ? <span className="single-review-shared-badge">随团队验收</span> : <AcceptanceControls task={task} onTaskUpdated={onTaskUpdated} notify={notify} />}
          </header>
          <div className="single-review-card-body">
            <MessageAttachments paths={objective.paths} />
            {sharedParent ? <SharedWorkerFacts parent={sharedParent} branch={sharedBranch} /> : <BranchFacts task={task} data={data} />}
            <ReviewEvidence taskId={task.id} />
            {loading && <p className="single-review-loading"><SpinnerGap size={14} className="is-spinning" />{sharedParent ? "正在读取共享分支归属…" : "正在汇总提交与 diff…"}</p>}
            {!loading && error && <p className="single-review-error">{sharedParent ? "共享分支归属读取失败" : "提交与 diff 加载失败"}：{error}</p>}
            {!sharedParent && !loading && data && (
              <div className="single-review-content">
                <CommitList branch={data.branch} commits={data.commits} />
                <DiffViewer result={data.diff} />
              </div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
