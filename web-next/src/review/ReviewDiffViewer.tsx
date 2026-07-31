import { useEffect, useMemo, useState } from "react";
import { FileCode, GitDiff, WarningCircle } from "@phosphor-icons/react";
import type { TaskDiffResult } from "../lib/api.ts";

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

export function ReviewDiffViewer({ result }: { result: TaskDiffResult }) {
  const sections = useMemo(() => splitDiff(result), [result]);
  const [selected, setSelected] = useState(0);
  const [visibleLines, setVisibleLines] = useState(INITIAL_LINE_COUNT);
  useEffect(() => {
    setSelected(0);
    setVisibleLines(INITIAL_LINE_COUNT);
  }, [result]);
  const selectedIndex = Math.min(selected, Math.max(sections.length - 1, 0));
  const section = sections[selectedIndex];
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
      <FileRail sections={sections} selected={selectedIndex} onSelect={(index) => { setSelected(index); setVisibleLines(INITIAL_LINE_COUNT); }} />
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
