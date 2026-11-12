// 单任务的验证记录：一轮一行（第几轮、在哪验、右边是结论），点开就在这一行底下铺报告；
// 嫌窄就点正文第一行末尾那颗图标，同一份正文装进贴着面板左边缘的抽屉里看。
//
// 粒度按各自的主语走：团队一屏里有多个被审对象，列的是对象；单任务只有它自己，列的是轮次。
import { useMemo, useRef, useState } from "react";
import type { TaskReviewRound } from "@ash/shared";
import { InspButton, InspNone, InspRecord, InspSec } from "../inspector/parts.tsx";
import { api } from "../lib/api.ts";
import {
  ReviewRoundBody,
  roundState,
  roundWhere,
  type TaskReviewState,
} from "../team/ReviewEvidence.tsx";
import { ReviewInlineReport } from "./ReviewInlineReport.tsx";
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

  return (
    <section ref={rootRef} aria-label="验证记录">
      <InspSec count={rounds.length || undefined}>验证记录</InspSec>
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
