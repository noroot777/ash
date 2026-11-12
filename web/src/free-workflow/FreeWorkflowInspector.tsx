import { useMemo, useRef, useState } from "react";
import type {
  FreeReviewRound,
  FreeReviewRun,
  FreeWorkflowExecution,
  Task,
} from "@ash/shared";
import { CaretRight } from "@phosphor-icons/react";
import { useInspectorNav } from "../inspector/nav.tsx";
import { InspNone } from "../inspector/parts.tsx";
import type { FreeWorkflowApiState } from "../lib/api.ts";
import { FreeReviewRoundDrawer } from "./FreeReviewRoundBody.tsx";
import { recurrenceText, reviewKey, reviewRoundLabel, reviewRoundTone, timeText } from "./freeReviewRounds.ts";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

// 「工作流」格（自由工作流）：真正发生过的事，按先后一行一条。打开/关闭预览不算——那是随手
// 开一眼看效果的看片器，开十次也不改变任务走到了哪儿，摆进这条线只会把真正的进展冲淡。
//
// 相邻的几段「任务执行」（中间没有审查隔开：续跑、被叫醒、你又说了一句）合成一条，右边是
// 合计用时，点开才是一段一段的。审查那几行只说第几轮、结论如何，点了去「审查」格展开那一轮。

type Item =
  | { type: "runs"; key: string; at: string; runs: FreeWorkflowExecution[] }
  | { type: "review"; key: string; at: string; run: FreeReviewRun; round: FreeReviewRound };

function timeline(state: FreeWorkflowApiState | null): Item[] {
  if (!state) return [];
  const flat = [
    ...(state.executions ?? []).map((execution) => ({ type: "execution" as const, at: execution.startedAt, key: `execution-${execution.id}`, execution })),
    ...state.reviews.flatMap((run) => run.rounds.map((round) => ({
      type: "review" as const, at: round.startedAt, key: `review-${run.id}-${round.round}`, run, round,
    }))),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  const items: Item[] = [];
  for (const entry of flat) {
    if (entry.type === "review") {
      items.push(entry);
      continue;
    }
    const last = items.at(-1);
    if (last?.type === "runs") last.runs.push(entry.execution);
    else items.push({ type: "runs", key: entry.key, at: entry.at, runs: [entry.execution] });
  }
  return items;
}

const STATUS_TEXT: Record<FreeWorkflowExecution["status"], string> = {
  running: "在跑",
  completed: "已完成",
  paused: "已暂停",
  canceled: "已取消",
  failed: "执行失败",
};

function spanMs(execution: FreeWorkflowExecution): number {
  if (!execution.endedAt) return 0;
  const ms = Date.parse(execution.endedAt) - Date.parse(execution.startedAt);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function msText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** 一段执行右边那一段：在跑的是主色「在跑」，没正常结束的带上怎么结束的。 */
function runMeta(execution: FreeWorkflowExecution) {
  if (execution.status === "running") return <span className="insp-live">在跑</span>;
  const took = msText(spanMs(execution));
  if (execution.status === "completed") return took;
  return <span className={execution.status === "failed" ? "insp-bad" : undefined}>{STATUS_TEXT[execution.status]} · {took}</span>;
}

function tone(item: Item): "ok" | "bad" | "live" | "plain" {
  if (item.type === "review") {
    const value = reviewRoundTone(item.round);
    return value === "live" ? "live" : value === "bad" ? "bad" : "ok";
  }
  const last = item.runs.at(-1)!;
  if (last.status === "running") return "live";
  return last.status === "failed" ? "bad" : "plain";
}

function RunsRow({ runs }: { runs: FreeWorkflowExecution[] }) {
  const [open, setOpen] = useState(false);
  const last = runs.at(-1)!;
  if (runs.length === 1) {
    return (
      <div className="insp-row">
        <span>任务执行</span>
        <span className="insp-faint">{timeText(last.startedAt)}</span>
        <span className="insp-meta">{runMeta(last)}</span>
      </div>
    );
  }
  const total = runs.reduce((sum, execution) => sum + spanMs(execution), 0);
  return (
    <>
      <button
        type="button"
        className="insp-row insp-go"
        aria-expanded={open}
        aria-label={`任务执行 ${runs.length} 段，合计 ${msText(total)}${last.status === "running" ? "，最后一段在跑" : ""}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span>任务执行 <span className="insp-faint">×{runs.length}</span></span>
        <span className="insp-faint">{timeText(runs[0].startedAt)}</span>
        <span className="insp-meta">{last.status === "running" ? <span className="insp-live">在跑</span> : msText(total)}</span>
        <CaretRight size={12} aria-hidden="true" className="insp-go__chev" />
      </button>
      {open && (
        <ol className="insp-sub">
          {runs.map((execution) => (
            <li key={execution.id}>
              <span>{timeText(execution.startedAt)}</span>
              <span>{runMeta(execution)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** 「工作流」格（自由工作流）。 */
export function FreeWorkflowInspector({ task }: { task: Task }) {
  const free = useFreeWorkflowState(task.id);
  const nav = useInspectorNav();
  // 面板外单独渲染（没有「审查」格可去）时，点一轮审查退回弹抽屉看。
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const items = useMemo(() => timeline(free.state), [free.state]);
  const opened = drawerKey
    ? items.find((item): item is Extract<Item, { type: "review" }> => item.type === "review" && reviewKey(item.run.id, item.round.round) === drawerKey) ?? null
    : null;

  if (free.loading && !free.state) return <div className="insp-pane"><InspNone>正在读取…</InspNone></div>;
  if (free.error && !free.state) return <div className="insp-pane"><InspNone>{free.error}</InspNone></div>;

  return (
    <div className="insp-pane free-workflow-inspector" ref={rootRef} aria-label="工作流">
      {items.length === 0
        ? <InspNone>还没有发生过什么。</InspNone>
        : (
          <ol className="insp-tl free-workflow-generated" ref={listRef}>
            {items.map((item) => (
              <li key={item.key} className={`is-${tone(item)}`}>
                {item.type === "runs" ? <RunsRow runs={item.runs} /> : (
                  <button
                    type="button"
                    className="insp-row insp-go"
                    aria-expanded={nav ? undefined : drawerKey === reviewKey(item.run.id, item.round.round)}
                    onClick={() => {
                      if (nav) nav.openTab("review", { runId: item.run.id, round: item.round.round });
                      else setDrawerKey((current) => {
                        const key = reviewKey(item.run.id, item.round.round);
                        return current === key ? null : key;
                      });
                    }}
                  >
                    <span className="insp-cut">
                      {item.run.target?.kind === "accepted_merge" ? "合并结果审查" : `审查 · 第 ${item.round.round} 轮`}
                    </span>
                    <span className="insp-faint">{timeText(item.round.startedAt)}</span>
                    <span className={`insp-meta${reviewRoundTone(item.round) === "bad" ? " is-bad" : ""}`}>
                      {item.round.status === "reviewing"
                        ? <span className="insp-live">审查中</span>
                        : reviewRoundLabel(item.round)}
                      {recurrenceText(item.round) ? " · 已熔断" : ""}
                    </span>
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      {opened && (
        <FreeReviewRoundDrawer
          taskId={task.id}
          run={opened.run}
          round={opened.round}
          anchorRef={rootRef}
          keepOpenRef={listRef}
          onClose={() => setDrawerKey(null)}
        />
      )}
    </div>
  );
}
