// 单任务的验证记录：一轮一行（第几轮、在哪验、右边是结论），点开就在这一行底下铺报告；
// 嫌窄就点正文第一行末尾那颗图标，同一份正文装进贴着面板左边缘的抽屉里看。
//
// 粒度按各自的主语走：团队一屏里有多个被审对象，列的是对象；单任务只有它自己，列的是轮次。
import { useMemo, useRef, useState } from "react";
import type { TaskReviewRound } from "@ash/shared";
import { InspButton, InspNone, InspRecord, InspSec } from "../inspector/parts.tsx";
import { useInspectorRequest } from "../inspector/nav.tsx";
import { RequestMissNote } from "../inspector/RequestMissNote.tsx";
import { api } from "../lib/api.ts";
import {
  ReviewRoundBody,
  roundState,
  roundWhere,
  type TaskReviewState,
} from "../team/ReviewEvidence.tsx";
import { ReviewInlineReport } from "./ReviewInlineReport.tsx";
import { reviewTargetOf } from "./reviewTarget.ts";
import { ReviewScreenshotStrip } from "./ReviewScreenshotStrip.tsx";

// 同一个轮次号可以既有独立审查又有就地验证两条记录，光靠 round 认不出是哪一条。
function roundKey(round: { round: number; where: string }) {
  return `${round.round}-${round.where}`;
}

function roundTone(round: TaskReviewRound): "plain" | "bad" | "live" {
  // 只有「未通过 / 无结论」标红。进行中那轮还没有结论，先标成红的等于提前判它死刑。
  const status = roundState(round).className;
  if (status === "is-verifying") return "live";
  return status === "is-verify-failed" || status === "is-inconclusive" ? "bad" : "plain";
}

export function TaskReviewRounds({
  taskId,
  state,
  emptyMessage,
  onOpenTask,
}: {
  taskId: string;
  state: TaskReviewState;
  emptyMessage: string;
  onOpenTask?: (taskId: string) => void;
}) {
  const rounds = useMemo(() => state.info?.rounds ?? [], [state.info]);
  // 默认都收着：一进来就铺满报告反而更难挑。
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const rootRef = useRef<HTMLElement>(null);
  const toggle = (key: string) => setOpenKeys((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  // 会话里那一句「第 N 轮验证…」点过来：展开那一轮（同号的独立审查与就地验证并存时认最近那条）。
  // 记录还在读就先不收下这份请求，读到了再办；读到的那一份里没有，重读一次再认，还没有就
  // 说出来（见 useInspectorRequest）。
  const requestMiss = useInspectorRequest("review", (params) => {
    const { round } = reviewTargetOf(params);
    const hit = round == null ? null : rounds.findLast((entry) => entry.round === round);
    if (!hit) return state.loading ? "wait" : "missing";
    const key = roundKey(hit);
    setOpenKeys((current) => new Set(current).add(key));
    requestAnimationFrame(() => rootRef.current?.querySelector(`[data-record="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" }));
  }, { version: rounds, refresh: () => state.reload(true) });

  return (
    <section ref={rootRef} aria-label="验证记录">
      <InspSec count={rounds.length || undefined}>验证记录</InspSec>
      <RequestMissNote miss={requestMiss} what="那一轮验证" />
      {state.loading && <InspNone>正在读取验证记录…</InspNone>}
      {!state.loading && state.error && (
        <InspNone action={<InspButton size="sm" onClick={() => void state.reload()}>重试</InspButton>}>
          验证记录加载失败：{state.error}
        </InspNone>
      )}
      {!state.loading && !state.error && !rounds.length && <InspNone>{emptyMessage}</InspNone>}
      {rounds.length > 0 && (
        <div className="insp-recs">
          {rounds.map((round) => {
            const key = roundKey(round);
            const status = roundState(round);
            const screenshots = round.screenshots.length ? (
              <ReviewScreenshotStrip items={round.screenshots.map((name) => ({
                key: name,
                name,
                src: api.taskReviewFileUrl(taskId, round.round, name),
                label: `第 ${round.round} 轮 · ${name}`,
              }))} />
            ) : null;
            return (
              <InspRecord
                key={key}
                data-record={key}
                title={`第 ${round.round} 轮`}
                sub={roundWhere(round)}
                status={status.label}
                tone={roundTone(round)}
                open={openKeys.has(key)}
                onToggle={() => toggle(key)}
              >
                <ReviewInlineReport
                  title={`第 ${round.round} 轮验证`}
                  subtitle={`${status.label} · ${roundWhere(round)}`}
                  anchorRef={rootRef}
                  screenshots={screenshots}
                >
                  <ReviewRoundBody taskId={taskId} round={round} onOpenTask={onOpenTask} includeScreenshots={false} />
                </ReviewInlineReport>
              </InspRecord>
            );
          })}
        </div>
      )}
    </section>
  );
}
