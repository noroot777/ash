import type { MouseEvent as ReactMouseEvent } from "react";
import type { SearchHit } from "@harness/shared";
import { NotePencil } from "@phosphor-icons/react";
import { StatusIcon } from "./StatusIcon";
import { formatInstant } from "./time";

const FIELD_LABEL: Record<SearchHit["field"], string | null> = {
  title: null,
  body: "正文",
  conversation: "会话",
};

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
  for (let i = 0; i < query.length; i += 1) {
    const char = query[i];
    if (quoted) {
      if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') {
      quoted = true;
      started = true;
    } else if (char === "|" || /\s/.test(char)) {
      flush();
    } else if (!started && char === "-" && (i === 0 || /\s/.test(query[i - 1]))) {
      excluded = true;
      started = true;
    } else {
      value += char;
      started = true;
    }
  }
  flush();
  return [...new Set(terms)].sort((a, b) => b.length - a.length);
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const terms = highlightTerms(query);
  if (!terms.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const loweredTerms = terms.map((term) => term.toLowerCase());
  const parts: React.ReactNode[] = [];
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
      <aside className="grid min-h-0 place-items-center bg-panel/50 px-8 text-center">
        <p className="max-w-[220px] text-xs leading-5 text-faint">选择一条搜索结果，在这里阅读全文</p>
      </aside>
    );
  }
  const previewLabel = hit.kind === "task" ? "任务正文" : "随手记正文";
  const preview = hit.preview ?? "";
  return (
    <aside className="flex min-h-0 flex-col bg-panel/50">
      <div className="shrink-0 border-b border-line px-5 py-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 shrink-0">
            {hit.kind === "task" ? <StatusIcon status={hit.status} /> : <NotePencil size={16} className="text-muted" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium leading-5 text-ink"><Highlight text={hit.title} query={query} /></h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-faint">
              <span>{hit.projectName ?? "未知项目"}</span><span aria-hidden="true">·</span>
              <span>更新于 {formatInstant(hit.updatedAt)}</span>
            </p>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {hit.kind === "task" && hit.field === "conversation" && hit.snippet && (
          <section className="mb-4 rounded-lg border border-line bg-raised/70 p-3">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-faint">会话命中</div>
            <p className="break-words font-mono text-[11px] leading-5 text-muted"><Highlight text={hit.snippet} query={query} /></p>
          </section>
        )}
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-faint">{previewLabel}</div>
        {preview ? (
          <div className="whitespace-pre-wrap break-words text-[13px] leading-6 text-muted"><Highlight text={preview} query={query} /></div>
        ) : <p className="text-xs text-faint">暂无正文</p>}
      </div>
    </aside>
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
    const index = startIndex + hitIndex;
    const header = hitIndex === 0 || hits[hitIndex - 1]?.kind !== hit.kind ? (hit.kind === "task" ? "任务" : "随手记") : null;
    const fieldChip = FIELD_LABEL[hit.field];
    return (
      <div key={`${hit.kind}:${hit.id}`}>
        {header && <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">{header}</div>}
        <button
          onMouseMove={(event) => onHover(index, event)}
          onClick={() => onOpen(hit)}
          className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left outline-none ${index === active ? "bg-overlay" : ""}`}
        >
          <span className="flex w-full min-w-0 items-center gap-2 text-sm">
            <span className="shrink-0">{hit.kind === "task" ? <StatusIcon status={hit.status} /> : <NotePencil size={15} className="text-muted" />}</span>
            <span className="min-w-0 truncate text-ink"><Highlight text={hit.title} query={query} /></span>
            {hit.kind === "task" && hit.archived && <span className="shrink-0 rounded bg-overlay px-1 text-[10px] text-faint">已归档</span>}
            {hit.kind === "note" && hit.taskId && <span className="shrink-0 rounded bg-overlay px-1 text-[10px] text-faint">已转任务</span>}
            {hit.projectName && <span className="ml-auto shrink-0 text-xs text-faint">{hit.projectName}</span>}
          </span>
          {hit.snippet && (
            <span className="flex w-full min-w-0 items-center gap-1.5 pl-[22px]">
              {fieldChip && <span className="shrink-0 rounded bg-overlay px-1 text-[10px] leading-4 text-faint">{fieldChip}</span>}
              <span className="min-w-0 truncate font-mono text-[11px] text-muted"><Highlight text={hit.snippet} query={query} /></span>
            </span>
          )}
        </button>
      </div>
    );
  })}</>;
}
