import { useEffect, useMemo, useState } from "react";
import { FileCode, GitDiff, WarningCircle } from "@phosphor-icons/react";
import type { TaskDiffResult } from "../lib/api.ts";
import { useZoomLayer, ZoomToggle } from "../lib/zoomLayer.tsx";
import { branchDiffReason as diffReason } from "../lib/branch-diff-reason.ts";
import { FileLayoutToggle, FolderCaret } from "../components/FileLayoutToggle.tsx";
import { indentStyle, useFileListLayout, useFileTreeRows } from "../lib/fileLayout.ts";
import { parseDiffLines, splitDiff, type DiffSection } from "./diffModel.ts";
import { DiffBody, DiffLayoutToggle } from "./DiffBody.tsx";
import { useDiffLayout } from "./diffLayout.ts";

const INITIAL_FILE_COUNT = 120;
const INITIAL_LINE_COUNT = 360;

function formatBytes(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(value / 1024)} KB`;
}

/** 文件轨里的一条，带它在 `sections` 里的下标——选中态是按下标记的，摆成树也不能丢。 */
type RailEntry = { section: DiffSection; index: number };

const entryPath = (entry: RailEntry) => entry.section.file.path;

/**
 * 一条或一个目录的加减行数。
 *
 * 数不出来（二进制文件、被截断的 diff）时后端给的是 null，那就照实写「?」——写成 0 是在
 * 说「这个文件没改动」。目录行上只要底下还有一个文件数得出来，就报已知那部分的合计。
 */
function railTotal(entries: readonly RailEntry[], side: "additions" | "deletions"): number | "?" {
  const values = entries.map((entry) => entry.section.file[side]);
  if (values.every((value) => value == null)) return "?";
  return values.reduce((sum: number, value) => sum + (value ?? 0), 0);
}

function RailCounts({ entries }: { entries: readonly RailEntry[] }) {
  return <span><i>+{railTotal(entries, "additions")}</i><em>−{railTotal(entries, "deletions")}</em></span>;
}

function RailFile({
  entry,
  selected,
  depth,
  showDir,
  onSelect,
}: {
  entry: RailEntry;
  selected: boolean;
  depth: number;
  /** 平铺时写整条路径；树里由目录行说明，行内只留文件名。 */
  showDir: boolean;
  onSelect: () => void;
}) {
  const path = entry.section.file.path;
  const slash = path.lastIndexOf("/");
  return (
    <button
      type="button"
      className={selected ? "is-selected" : ""}
      style={indentStyle(depth, 10)}
      onClick={onSelect}
    >
      <code title={path}>{showDir ? path : path.slice(slash + 1)}</code>
      <RailCounts entries={[entry]} />
    </button>
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
  const [layout] = useFileListLayout();
  // 树只建在**已经摊开的那批**上：分页语义不变，「再显示 N 个」加载进来的会跟着长到树上。
  const entries = useMemo<RailEntry[]>(
    () => sections.slice(0, visible).map((section, index) => ({ section, index })),
    [sections, visible],
  );
  const tree = useFileTreeRows(entries, entryPath, layout === "tree");
  return (
    <section className="single-review-files">
      <header>
        <span><FileCode size={13} />改动文件</span>
        <span>
          <b>{sections.length}</b>
          <FileLayoutToggle className="single-review-layout" size={12} />
        </span>
      </header>
      <div>
        {layout === "tree"
          ? tree.rows.map((row) => (
            row.kind === "dir" ? (
              <button
                type="button"
                key={row.key}
                className="single-review-dir"
                style={indentStyle(row.depth, 10)}
                aria-expanded={!row.collapsed}
                aria-label={`${row.label}（${row.items.length} 个文件）`}
                onClick={() => tree.toggle(row.path)}
              >
                <FolderCaret collapsed={row.collapsed} size={9} />
                <code>{row.label}</code>
                <RailCounts entries={row.items} />
              </button>
            ) : (
              <RailFile
                key={row.key}
                entry={row.item}
                selected={selected === row.item.index}
                depth={row.depth}
                showDir={false}
                onSelect={() => onSelect(row.item.index)}
              />
            )
          ))
          : entries.map((entry) => (
            <RailFile
              key={`${entryPath(entry)}-${entry.index}`}
              entry={entry}
              selected={selected === entry.index}
              depth={0}
              showDir
              onSelect={() => onSelect(entry.index)}
            />
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
  const [diffLayout, setDiffLayout] = useDiffLayout();
  useEffect(() => {
    setSelected(0);
    setVisibleLines(INITIAL_LINE_COUNT);
  }, [result]);
  const selectedIndex = Math.min(selected, Math.max(sections.length - 1, 0));
  const section = sections[selectedIndex];
  const lines = useMemo(() => parseDiffLines(section?.body ?? ""), [section?.body]);
  const additions = result.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = result.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const zoom = useZoomLayer({
    zoomed,
    onExit: () => setZoomed(false),
    label: `放大查看改动：${section?.file.path ?? ""}`,
    className: "zoom-layer--review",
  });

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
          <DiffLayoutToggle layout={diffLayout} onChange={setDiffLayout} />
          <ZoomToggle zoomed={zoomed} onToggle={() => setZoomed(!zoomed)} className="single-review-zoom" />
        </header>
        {result.truncated && (
          <div className="single-review-warning"><WarningCircle size={13} weight="fill" />diff 超过 {formatBytes(result.limitBytes)}，这里只展示服务端返回的截断内容。</div>
        )}
        {!section.body ? (
          <p className="single-review-empty">{result.truncated ? "该文件未包含在截断响应中。" : "没有文本 diff，可能是二进制文件。"}</p>
        ) : (
          <DiffBody
            lines={lines}
            layout={diffLayout}
            visible={visibleLines}
            step={INITIAL_LINE_COUNT}
            onMore={() => setVisibleLines((count) => count + INITIAL_LINE_COUNT)}
            label={`${section.file.path} diff`}
          />
        )}
      </section>
    </div>
  );
  return zoom.render(layout);
}
