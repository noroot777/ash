// 单任务的验证记录：列表留在 inspector 里，正文改由抽屉装。
//
// 原来是把每一轮整篇铺在侧栏里（`ReviewEvidence`）。侧栏只有 340px 宽，一份验证报告加
// 两张证据截图就能撑到近 2000px 高——可视区不到一半，看完一轮要往下拖一千多像素，而且
// 拖着拖着就不知道自己在第几轮。团队那边早就改成「点一条、左边弹一屉」了，这里是同一个
// 毛病的另一半，用的也是同一个抽屉组件。
//
// 粒度按各自的主语走：团队一屏里有多个被审对象，列的是对象；单任务只有它自己，列的是轮次。
import { useMemo, useRef, useState } from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import {
  ReviewRoundBody,
  roundState,
  roundWhere,
  type TaskReviewState,
} from "../team/ReviewEvidence.tsx";
import { ReviewEvidenceDrawer } from "./ReviewEvidenceDrawer.tsx";

// 同一个轮次号可以既有独立审查又有就地验证两条记录，光靠 round 认不出是哪一条。
function roundKey(round: { round: number; where: string }) {
  return `${round.round}-${round.where}`;
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
  // 默认不弹：一进来就盖住列表反而更难挑，跟团队那边同一个规矩。
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const opened = openKey ? rounds.find((round) => roundKey(round) === openKey) ?? null : null;

  return (
    // 这层不带样式，只是抽屉量位置用的锚点：留白由里面的 section 自己管，套两层会变成双份内边距。
    <div ref={rootRef}>
      <section className="review-inspector__targets" aria-label="验证轮次">
        <header>
          <b>验证记录</b>
          <small>{rounds.length ? `已记录 ${rounds.length} 轮真实运行验证，点开在左侧看报告与截图` : "结论、报告与截图集中保存在这里"}</small>
        </header>
        <div ref={listRef}>
          {state.loading && (
            <p className="review-inspector__empty"><SpinnerGap size={13} className="is-spinning" />正在读取验证记录…</p>
          )}
          {!state.loading && state.error && (
            <p className="review-inspector__empty is-error">
              验证记录加载失败：{state.error}
              <button type="button" onClick={() => void state.reload()}>重试</button>
            </p>
          )}
          {!state.loading && !state.error && !rounds.length && (
            <p className="review-inspector__empty">{emptyMessage}</p>
          )}
          {rounds.map((round) => {
            const key = roundKey(round);
            const status = roundState(round);
            // 只有「未通过 / 无结论」标红。进行中那轮还没有结论，先标成红的等于提前判它死刑。
            const failed = status.className === "is-verify-failed" || status.className === "is-inconclusive";
            return (
              <button
                type="button"
                key={key}
                className={key === openKey ? "is-selected" : failed ? "is-failed" : ""}
                aria-expanded={key === openKey}
                onClick={() => setOpenKey((current) => current === key ? null : key)}
              >
                <span><b>第 {round.round} 轮</b><small>{roundWhere(round)}</small></span>
                <em>{status.icon}{status.label}</em>
              </button>
            );
          })}
        </div>
      </section>

      {opened && (
        <ReviewEvidenceDrawer
          anchorRef={rootRef}
          keepOpenRef={listRef}
          title={`第 ${opened.round} 轮验证`}
          subtitle={`${roundState(opened).label} · ${roundWhere(opened)}`}
          onClose={() => setOpenKey(null)}
        >
          {/* 图片分组要隔离：抽屉里翻大图时左右键只该在这一轮的截图之间走。 */}
          <ImagePreviewGroup isolated>
            <div className="review-round-body">
              <ReviewRoundBody taskId={taskId} round={opened} onOpenTask={onOpenTask} />
            </div>
          </ImagePreviewGroup>
        </ReviewEvidenceDrawer>
      )}
    </div>
  );
}
