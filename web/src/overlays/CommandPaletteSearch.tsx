import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { SearchHit } from "@ash/shared";
import { NotePencil } from "@phosphor-icons/react";
import { formatInstant } from "../task-detail/utils.ts";

const FIELD_LABEL: Record<SearchHit["field"], string | null> = {
  // id 与 title 的证据本身就摆在行里(id 那一行、标题那一行),不用再挂个小标签。
  id: null,
  title: null,
  body: "正文",
  conversation: "会话",
};

// 「你搜的就是这个任务」的标识。命中按 id 时钉在最前面(见 CommandPalette),
// 但标识挂在行本身:同一个前缀撞上两条任务时,第二条也得看得出来它是 id 命中。
function IdMatchBadge() {
  return <span className="shrink-0 rounded bg-accent/20 px-1 text-[9px] font-medium leading-4 text-accent">就是这个任务</span>;
}

function isIdMatch(hit: SearchHit) {
  return hit.kind === "task" && hit.field === "id";
}

function SearchStatus({ hit }: { hit: Extract<SearchHit, { kind: "task" }> }) {
  return <span className={`palette-status is-${hit.status}`} />;
}

function highlightTerms(query: string): string[] {
  const terms: string[] = [];
  let value = "";
  let quoted = false;
  let excluded = false;
  let started = false;
  const flush = () => {
    const term = value.trim();
    if (term && !excluded) terms.push(term);
    value = "";
    excluded = false;
    started = false;
  };
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    if (quoted) {
      if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') {
      quoted = true;
      started = true;
    } else if (character === "|" || /\s/.test(character)) {
      flush();
    } else if (!started && character === "-" && (index === 0 || /\s/.test(query[index - 1] ?? ""))) {
      excluded = true;
      started = true;
    } else {
      value += character;
      started = true;
    }
  }
  flush();
  return [...new Set(terms)].sort((left, right) => right.length - left.length);
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
      <mark key={`${nextIndex}:${nextTerm}`} className="rounded-[2px] bg-accent/25 text-inherit">
        {text.slice(nextIndex, nextIndex + nextTerm.length)}
      </mark>,
    );
    position = nextIndex + nextTerm.length;
  }
  parts.push(text.slice(position));
  return <>{parts}</>;
}

export function SearchPreview({ hit, query }: { hit: SearchHit | undefined; query: string }) {
  if (!hit) {
    return (
      <aside className="palette-preview grid place-items-center px-8 text-center">
        <p className="m-0 max-w-[220px] p-0 text-xs leading-5 text-faint">选择一条搜索结果，在这里阅读全文</p>
      </aside>
    );
  }
  const previewLabel = hit.kind === "task" ? "任务正文" : "随手记正文";
  const preview = hit.preview ?? "";
  return (
    <aside className="palette-preview flex min-h-0 flex-col">
      <div className="flex-none border-b border-line px-[18px] py-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-1 grid size-4 shrink-0 place-items-center">
            {hit.kind === "task" ? <SearchStatus hit={hit} /> : <NotePencil size={16} className="text-muted" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold leading-5 text-ink">
              <span className="min-w-0"><Highlight text={hit.title} query={query} /></span>
              {isIdMatch(hit) && <IdMatchBadge />}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[10px] leading-4 text-faint">
              {isIdMatch(hit) && <><span className="font-mono text-muted"><Highlight text={hit.id} query={query} /></span><span aria-hidden="true">·</span></>}
              <span>{hit.projectName ?? "未知项目"}</span><span aria-hidden="true">·</span>
              <span>创建于 {formatInstant(hit.createdAt)}</span><span aria-hidden="true">·</span>
              <span>更新于 {formatInstant(hit.updatedAt)}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
        {hit.kind === "task" && hit.field === "conversation" && hit.snippet && (
          <section className="mb-4 rounded-lg border border-line bg-raised/70 p-3">
            <div className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.08em] text-faint">会话命中</div>
            <div className="break-words font-mono text-[11px] leading-5 text-muted"><Highlight text={hit.snippet} query={query} /></div>
          </section>
        )}
        <div className="mb-2 text-[9px] font-bold uppercase tracking-[0.08em] text-faint">{previewLabel}</div>
        {preview ? (
          <div className="whitespace-pre-wrap break-words text-xs leading-[1.8] text-muted"><Highlight text={preview} query={query} /></div>
        ) : <div className="text-xs text-faint">暂无正文</div>}
      </div>
    </aside>
  );
}

export function SearchHitRow({
  hit,
  index,
  active,
  query,
  onHover,
  onOpen,
}: {
  hit: SearchHit;
  index: number;
  active: number;
  query: string;
  onHover: (index: number, event: ReactMouseEvent) => void;
  onOpen: (hit: SearchHit) => void;
}) {
  const fieldChip = FIELD_LABEL[hit.field];
  return (
    <button
      type="button"
      aria-selected={index === active}
      onMouseMove={(event) => onHover(index, event)}
      onClick={() => onOpen(hit)}
      className="ui-selectable flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left outline-none"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-xs">
        <span className="grid size-[15px] shrink-0 place-items-center">
          {hit.kind === "task" ? <SearchStatus hit={hit} /> : <NotePencil size={15} className="text-muted" />}
        </span>
        <span className="min-w-0 truncate font-semibold text-ink"><Highlight text={hit.title} query={query} /></span>
        {isIdMatch(hit) && <IdMatchBadge />}
        {hit.kind === "task" && hit.archived && <span className="shrink-0 rounded bg-overlay px-1 text-[9px] text-faint">已归档</span>}
        {hit.kind === "note" && hit.taskCount > 0 && <span className="shrink-0 rounded bg-overlay px-1 text-[9px] text-faint">已转 {hit.taskCount} 个任务</span>}
        {hit.projectName && <span className="ml-auto shrink-0 text-[10px] text-faint">{hit.projectName}</span>}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 pl-[23px] text-[9px] leading-4 text-faint">
        {isIdMatch(hit) && <><span className="font-mono text-[10px] text-muted"><Highlight text={hit.id} query={query} /></span><span aria-hidden="true">·</span></>}
        <span>创建于 {formatInstant(hit.createdAt)}</span>
        <span aria-hidden="true">·</span>
        <span>更新于 {formatInstant(hit.updatedAt)}</span>
      </span>
      {hit.snippet && (
        <span className="flex w-full min-w-0 items-center gap-1.5 pl-[23px]">
          {fieldChip && <span className="shrink-0 rounded bg-overlay px-1 text-[9px] leading-4 text-faint">{fieldChip}</span>}
          <span className="min-w-0 truncate font-mono text-[10px] text-muted"><Highlight text={hit.snippet} query={query} /></span>
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
  onHover,
  onOpen,
}: {
  hits: SearchHit[];
  active: number;
  startIndex: number;
  query: string;
  onHover: (index: number, event: ReactMouseEvent) => void;
  onOpen: (hit: SearchHit) => void;
}) {
  return <>{hits.map((hit, hitIndex) => {
    const header = hitIndex === 0 || hits[hitIndex - 1]?.kind !== hit.kind ? (hit.kind === "task" ? "任务" : "随手记") : null;
    return (
      <div key={`${hit.kind}:${hit.id}`}>
        {header && <div className="palette-label">{header}</div>}
        <SearchHitRow hit={hit} index={startIndex + hitIndex} active={active} query={query} onHover={onHover} onOpen={onOpen} />
      </div>
    );
  })}</>;
}
