import { useEffect, useRef, type ReactNode } from "react";
import type { SearchHit } from "@ash/shared";
import type { SearchSort } from "@ash/shared/search";
import { NotePencil } from "@phosphor-icons/react";
import { formatInstant } from "../task-detail/utils.ts";
import { highlightTerms } from "../search/searchTerms.ts";

const FIELD_LABEL: Record<SearchHit["field"], string | null> = {
  // id 与 title 的证据本身就摆在行里(任务行的时间那一行开头总带着 id),不用再挂个小标签。
  id: null,
  title: null,
  body: "正文",
  conversation: "会话",
};

// 「你搜的就是这个任务」的标识。命中按 id 时钉在最前面(见 CommandPalette),
// 但标识挂在行本身:同一个前缀撞上两条任务时,第二条也得看得出来它是 id 命中。
function IdMatchBadge() {
  return <span className="shrink-0 rounded bg-ink/10 px-1 text-[length:var(--t-xs)] font-medium leading-4 text-ink">就是这个任务</span>;
}

function isIdMatch(hit: SearchHit) {
  return hit.kind === "task" && hit.field === "id";
}

function SearchStatus({ hit }: { hit: Extract<SearchHit, { kind: "task" }> }) {
  return <span className={`palette-status is-${hit.status}`} />;
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const terms = highlightTerms(query);
  if (!terms.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const loweredTerms = terms.map((term) => term.toLowerCase());
  const parts: ReactNode[] = [];
  let position = 0;
  while (position < text.length) {
    let nextIndex = -1;
    let nextTerm = "";
    for (const term of loweredTerms) {
      const index = lower.indexOf(term, position);
      if (index >= 0 && (nextIndex < 0 || index < nextIndex || (index === nextIndex && term.length > nextTerm.length))) {
        nextIndex = index;
        nextTerm = term;
      }
    }
    if (nextIndex < 0) break;
    if (nextIndex > position) parts.push(text.slice(position, nextIndex));
    parts.push(
      <mark key={`${nextIndex}:${nextTerm}`} className="rounded-[2px] bg-ink/15 text-inherit">
        {text.slice(nextIndex, nextIndex + nextTerm.length)}
      </mark>,
    );
    position = nextIndex + nextTerm.length;
  }
  parts.push(text.slice(position));
  return <>{parts}</>;
}

export function SearchPreview({ hit, query, onOpen }: { hit: SearchHit | undefined; query: string; onOpen?: (hit: SearchHit) => void }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [hit?.id, hit?.kind]);
  if (!hit) {
    return (
      <aside className="palette-preview grid place-items-center px-8 text-center">
        <p className="m-0 max-w-[220px] p-0 text-xs leading-5 text-faint">选择一条结果查看命中内容</p>
      </aside>
    );
  }
  const previewLabel = hit.kind === "task" ? "任务正文" : "随手记正文";
  const preview = hit.preview ?? "";
  const excerpts = hit.excerpts?.length ? hit.excerpts : hit.snippet ? [hit.snippet] : [];
  return (
    <aside className="palette-preview flex min-h-0 flex-col">
      <div className="flex-none border-b border-line px-[18px] py-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-1 grid size-4 shrink-0 place-items-center">
            {hit.kind === "task" ? <SearchStatus hit={hit} /> : <NotePencil size={16} className="text-muted" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-medium leading-5 text-ink">
              <span className="min-w-0"><Highlight text={hit.title} query={query} /></span>
              {isIdMatch(hit) && <IdMatchBadge />}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[length:var(--t-xs)] leading-4 text-faint">
              {hit.kind === "task" && <><span className="font-mono text-muted"><Highlight text={hit.id} query={query} /></span><span aria-hidden="true">·</span></>}
              <span>{hit.projectName ?? "未知项目"}</span><span aria-hidden="true">·</span>
              <span>更新于 {formatInstant(hit.updatedAt)}</span>
            </div>
          </div>
          {onOpen && <button type="button" className="palette-open-hit" onClick={() => onOpen(hit)}>打开{hit.kind === "task" ? "任务" : "随手记"}</button>}
        </div>
      </div>
      <div ref={body} className="palette-preview-content min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
        {excerpts.length ? excerpts.map((excerpt, index) => (
          <p key={`${hit.id}:${index}`} className="palette-excerpt"><Highlight text={excerpt} query={query} /></p>
        )) : preview ? (
          <div className="whitespace-pre-wrap break-words text-xs leading-[1.8] text-muted"><Highlight text={preview} query={query} /></div>
        ) : <div className="text-xs text-faint">暂无{previewLabel}</div>}
      </div>
    </aside>
  );
}

export function SearchHitRow({
  hit,
  index,
  active,
  query,
  onSelect,
  onOpen,
}: {
  hit: SearchHit;
  index: number;
  active: number;
  query: string;
  onSelect: (index: number) => void;
  onOpen: (hit: SearchHit) => void;
}) {
  const fieldChip = FIELD_LABEL[hit.field];
  return (
    <button
      type="button"
      aria-selected={index === active}
      data-palette-index={index}
      data-search-key={`${hit.kind}:${hit.id}`}
      // 单击只是选中（右边预览跟着换），双击才打开。鼠标划过不选中：指针经过一行不代表
      // 用户在挑它，而选中态一路跟着鼠标跑，键盘选到哪儿就全乱了。
      onMouseDown={(event) => event.preventDefault()} // 焦点留在输入框，点完还能继续按上下键
      onClick={() => onSelect(index)}
      onDoubleClick={() => onOpen(hit)}
      className="ui-selectable flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left outline-none"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-xs">
        <span className="grid size-[15px] shrink-0 place-items-center">
          {hit.kind === "task" ? <SearchStatus hit={hit} /> : <NotePencil size={15} className="text-muted" />}
        </span>
        <span className="palette-hit-title min-w-0 truncate font-medium text-ink"><Highlight text={hit.title} query={query} /></span>
        {isIdMatch(hit) && <IdMatchBadge />}
        {hit.kind === "task" && hit.archived && <span className="shrink-0 rounded bg-overlay px-1 text-[length:var(--t-xs)] text-faint">已归档</span>}
        {hit.kind === "note" && hit.taskCount > 0 && <span className="shrink-0 rounded bg-overlay px-1 text-[length:var(--t-xs)] text-faint">已转 {hit.taskCount} 个任务</span>}
      </span>
      <span className="palette-hit-meta flex w-full min-w-0 items-center gap-1.5 pl-[23px] text-[length:var(--t-xs)] leading-4 text-faint">
        {hit.projectName && <><span className="truncate">{hit.projectName}</span><span aria-hidden="true">·</span></>}
        {hit.kind === "task" && <><span className="font-mono text-[length:var(--t-xs)] text-muted"><Highlight text={hit.id} query={query} /></span><span aria-hidden="true">·</span></>}
        <span>更新于 {formatInstant(hit.updatedAt)}</span>
      </span>
      {hit.snippet && (
        <span className="flex w-full min-w-0 items-center gap-1.5 pl-[23px]">
          {fieldChip && <span className="shrink-0 rounded bg-overlay px-1 text-[length:var(--t-xs)] leading-4 text-faint">{fieldChip}</span>}
          <span className="palette-hit-snippet min-w-0 text-[length:var(--t-xs)] leading-4 text-muted"><Highlight text={hit.snippet} query={query} /></span>
        </span>
      )}
    </button>
  );
}

export function SearchHitList({
  hits,
  active,
  startIndex,
  query,
  sort,
  onSelect,
  onOpen,
}: {
  hits: SearchHit[];
  active: number;
  startIndex: number;
  query: string;
  sort: SearchSort;
  onSelect: (index: number) => void;
  onOpen: (hit: SearchHit) => void;
}) {
  return <>{hits.map((hit, hitIndex) => {
    // 相关度档里任务整体排在随手记之前，于是「任务 / 随手记」是两个真的分区，各挂一个
    // 标题。最近更新档里两者按时间混排，再按 kind 挂标题就会一路「任务/随手记/任务…」
    // 地闪 —— 那一档只在顶上说一句现在按什么排，是哪一类看行内的图标。
    const header = sort === "recent"
      ? (hitIndex === 0 ? "按更新时间" : null)
      : (hitIndex === 0 || hits[hitIndex - 1]?.kind !== hit.kind ? (hit.kind === "task" ? "任务" : "随手记") : null);
    return (
      <div key={`${hit.kind}:${hit.id}`}>
        {header && <div className="palette-label">{header}</div>}
        <SearchHitRow hit={hit} index={startIndex + hitIndex} active={active} query={query} onSelect={onSelect} onOpen={onOpen} />
      </div>
    );
  })}</>;
}
