import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CornersIn, CornersOut, FileCode, GitDiff, WarningCircle } from "@phosphor-icons/react";
import type { TaskDiffResult } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";

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
const ZOOM_BASE_Z = 92;

// 放大时要让开的，是贴着窗口右缘的那条 inspector——审查记录、验证证据都在里面，盖住它
// 等于把这一屏唯一的旁证也收走了。按「最靠右」找而不是顺着自己的 DOM 往上找：diff 有时
// 长在团队的执行者抽屉里，那里面还嵌着一条自己的 inspector，让开它会在窗口中间掏个洞。
// 留 24px 的容差是必须的：`.workspace-shell` 右边有 8px 内边距，要求严丝合缝贴住窗口右缘
// 就一条都找不到，放大又会盖回 inspector 上去（第一版就是这么漏的）。
const RIGHT_EDGE_SLACK = 24;

function rightEdgeInspector(): HTMLElement | null {
  const hosts = [...document.querySelectorAll<HTMLElement>(".inspector-host")]
    .map((host) => ({ host, rect: host.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && window.innerWidth - rect.right <= RIGHT_EDGE_SLACK)
    .sort((a, b) => b.rect.right - a.rect.right);
  return hosts[0]?.host ?? null;
}

// 自己所在那一层有多高。执行者抽屉是 z-index 95，放大层固定 92 就会被它盖住，按钮看着
// 像坏了。只抬一档：抬过头会越过之后才打开的浮层，破坏「后开的在最上面」。
function enclosingLayerZ(from: Element): number {
  let top = 0;
  for (let node = from.parentElement; node; node = node.parentElement) {
    const z = Number.parseInt(window.getComputedStyle(node).zIndex, 10);
    if (Number.isFinite(z)) top = Math.max(top, z);
  }
  return top;
}

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
  const [zoomed, setZoomed] = useState(false);
  const [gutter, setGutter] = useState(0);
  const [zoomZ, setZoomZ] = useState(ZOOM_BASE_Z);
  const zoomBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSelected(0);
    setVisibleLines(INITIAL_LINE_COUNT);
  }, [result]);
  // 放大层必须 portal 到 body：主工作区自己开了一个堆叠上下文（`sidebar-spread.css`），
  // 留在原地的 z-index 只在它家里排座次，再大也盖不住左边的任务栏。层高从 92 起：压过所有
  // 页面内容（≤90），但低于抽屉(95/96)、大图预览(220)、确认框(230)这些后开的浮层——放大
  // 着的时候再弹什么，那个仍在最上面，不会被 diff 盖住。
  //
  // 右边的 inspector 是例外，它不靠 z-index 而靠让地方：放大是「把 diff 铺开来看」，审查
  // 记录、验证证据得留在旁边继续点。层宽只到它的左缘，拖宽 inspector 时跟着变。
  useLayoutEffect(() => {
    const host = zoomed ? rightEdgeInspector() : null;
    if (!host) {
      setGutter(0);
      return;
    }
    // 量左缘而不是宽度：右边留白、边框怎么算都不用管，让开的正好是它占的那块。
    const sync = () => setGutter(Math.max(0, window.innerWidth - host.getBoundingClientRect().left));
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [zoomed]);
  // 关闭交给 useDismissable：它按打开顺序记一摞，Esc 一次只退最上面那一层，所以放大态下
  // 开的确认框先吃 Esc，再按一次才退出放大。不吃「点外面」——放大态下点得到的外面只有
  // inspector，那是留着给人用的，点一下就把放大收了才是意外。
  useDismissable({ enabled: zoomed, containerRef: zoomBox, onClose: () => setZoomed(false), closeOnOutside: false });
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
  const layout = (
    <div className="single-review-diff-layout">
      <FileRail sections={sections} selected={selectedIndex} onSelect={(index) => { setSelected(index); setVisibleLines(INITIAL_LINE_COUNT); }} />
      <section className="single-review-diff">
        <header>
          <div><GitDiff size={14} /><b>{section.file.path}</b></div>
          <span><i>+{section.file.additions ?? "?"}</i><em>−{section.file.deletions ?? "?"}</em></span>
          <small>总计 +{additions} −{deletions}</small>
          <button
            type="button"
            className="single-review-zoom"
            aria-pressed={zoomed}
            onClick={(event) => {
              if (zoomed) {
                setZoomed(false);
                return;
              }
              // 趁自己还在原地量一次所在层高：放大之后这棵子树被 portal 到 body，就再也
              // 问不到自己原本长在哪一层里了。
              setZoomZ(Math.max(ZOOM_BASE_Z, enclosingLayerZ(event.currentTarget) + 1));
              setZoomed(true);
            }}
          >
            {zoomed ? <><CornersIn size={13} />退出放大 · Esc</> : <><CornersOut size={13} />放大</>}
          </button>
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
  if (!zoomed) return layout;
  return createPortal(
    // 不是 aria-modal：右边的 inspector 仍然可读可点，声明成模态会让读屏把它当成不存在。
    <div
      className="review-zoom-layer"
      ref={zoomBox}
      style={{ right: gutter, zIndex: zoomZ }}
      role="dialog"
      aria-label={`放大查看改动：${section.file.path}`}
    >
      {layout}
    </div>,
    document.body,
  );
}
