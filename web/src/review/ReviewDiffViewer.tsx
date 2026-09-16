import { useEffect, useMemo, useState } from "react";
import { FileCode, GitDiff, WarningCircle } from "@phosphor-icons/react";
import type { TaskDiffResult } from "../lib/api.ts";
import { useZoomLayer, ZoomToggle } from "../lib/zoomLayer.tsx";
import { branchDiffReason as diffReason } from "../lib/branch-diff-reason.ts";
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
