import { useState, type ReactNode } from "react";
import type { FreeReviewDebateTurn, FreeReviewRound, FreeReviewRun } from "@ash/shared";
import { MAX_FREE_REVIEW_DEBATE_EXCHANGES } from "@ash/shared/free-workflow";
import {
  ArrowSquareOut, ArrowsOutSimple, ChatsCircle, FileText, HandPalm, SpinnerGap, Wrench,
} from "@phosphor-icons/react";
import { FoldedProse } from "../components/FoldedProse.tsx";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { DEBATE_SIDE_LABEL } from "./debateModel.ts";
import {
  DISPUTE_PROSE_LABELS, RESOLUTIONS, disputeHeadline, disputeStatusLine, resolutionConfirmText,
  type DisputeResolutionKind,
} from "./disputeCopy.ts";
import { FreeReviewDebateReader } from "./FreeReviewDebateReader.tsx";
import { FreeReviewDebateTranscript } from "./FreeReviewDebateTranscript.tsx";

type Pending = "debate" | DisputeResolutionKind;

/**
 * 「执行者不认这一轮意见」的那张卡：它一句话说了什么 + 完整依据（折着）+ 几个只有用户
 * 能按的出口。
 *
 * ── 这一屏为什么长这样（用户 2026-10-20：「一大篇文字都看不懂」）──
 * 上一版把 `dispute.reason` / `deferReason` 原样铺在卡上。那两段是执行者写给**审查者**
 * 看的辩护书：真实样本 1000~3500 字、一段到底、满篇 `kb/feeds/x_post.py:211`、「672 条
 * 回归通过」、commit 短 hash。开了辩论再加七段、合计上万字。用户要在这堆东西上面按一颗
 * 按钮，而四颗按钮各只有五个字、彼此的差别写在确认框里（得点进去才看见）。
 *
 * 所以这一屏现在按**读的顺序**排，一屏之内答完三个问题：
 * ① 争的是什么 —— 标题（系统按两段理由在不在推出来的，不依赖 agent 措辞）
 *                 + 执行者的一句人话（`dispute.summary`，结构化字段，上限 200 字）
 * ② 想深究就展开 —— 两段技术依据各自折着，标题上报字数
 * ③ 我能怎么选 —— 出口竖排成一列，每行「按钮 + 我什么时候该点它」，不必点进确认框才懂
 *
 * 老数据（加 `summary` 之前落的那 32 条驳回）没有那一句：此时正文**默认摊开**，因为那是
 * 用户唯一能读到的东西；折起来就成了「什么都没有」。
 *
 * ── 四个出口互不等价，这几条规矩别动 ──
 * - 让双方辩论：先听几段再决定，**不改变任何结论**，辩完还是回到这张卡上拍板。
 * - 这一轮不用改了（记为采纳执行者）：这条未通过意见作废；审查记录与证据原样留着，
 *   那条 run 也**不会**被改写成「已通过」——替审查者签字比留一条「用户裁定作废」的
 *   记录危险得多。
 * - 转为独立任务：意见**成立**，只是偏离了本任务要做的那件事（判据与三种形态见
 *   `@ash/shared/free-workflow` 的 `DEFER_BOUNDARY_CRITERION`）。建一个待办派生任务把它
 *   带走，本轮不再在这里修。**只在执行者逐条写明越界依据时才出现**——凭空给这颗按钮，
 *   它就成了谁都能按的免修开关（后端同样拒绝，这里不是唯一防线）。
 * - 让它接着改（记为维持审查意见）：驳回不被采纳，接着发起修复。
 *
 * 三档共用一栏**裁定要点**：辩论常常辩出「第 2 条我认，但按后来达成的方案做」这种结论，
 * 三档一个都表达不了它。没有这一栏时用户只能事后再手打一条续聊，而那段话不在任何结构化
 * 状态里，也比修复指令到得晚。辩论回放的每一段还挂着「用这段作要点」，省掉跨面板的手动
 * 复制——最常见的一次裁定就是「照审查者收尾说的办」。
 */
export function FreeReviewDisputeCard({
  taskId,
  run,
  round,
  disabled = false,
  onChanged,
  notify,
  onOpenReport,
}: {
  taskId: string;
  run: FreeReviewRun;
  round: FreeReviewRound;
  disabled?: boolean;
  onChanged: (state: FreeWorkflowApiState) => void;
  notify: (message: string) => void;
  /**
   * 「看审查者的原话」——把这一轮的报告选到左边去。
   *
   * 卡上只有执行者的说法，审查者的那一半在报告里。不给入口的话，用户要在右边的「审查
   * 记录」列表里自己找回第几轮（两处都在同一个面板里，但得先知道该点哪一行）。
   */
  onOpenReport?: () => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [exchanges, setExchanges] = useState(1);
  /** 裁定要点，三档共用一份草稿：用户在几个确认框之间来回看的时候不该丢掉已经写的话。 */
  const [note, setNote] = useState("");
  /** 正在全宽阅读的那场辩论（debate.id）；同一条驳回可能辩过多次，按 id 认。 */
  const [reading, setReading] = useState<string | null>(null);
  const dispute = round.dispute;
  const debates = dispute?.debates ?? [];
  const latestDebate = debates.at(-1) ?? null;
  const debateRunning = latestDebate?.status === "running";
  // 辩完的那条挡住再辩（后端同判据）：同一份报告挂两条辩完的记录只会让「以哪条为准」
  // 变成新问题。中断的可以重开——那是系统没让人说完，不该连带把用户的出路关掉。
  const canDebate = !latestDebate || latestDebate.status === "failed";
  const readingDebate = debates.find((item) => item.id === reading) ?? null;
  if (!dispute) return null;
  const blocked = disabled || debateRunning;
  const deferReason = dispute.deferReason;

  const startDebate = async () => {
    setBusy(true);
    try {
      const result = await api.startFreeReviewDebate(taskId, exchanges);
      onChanged(result.state);
      setPending(null);
      notify(`已开始辩论：审查者先答辩，共 ${exchanges * 2 + 1} 段发言；说完还是由你裁定`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "发起辩论失败");
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (resolution: DisputeResolutionKind) => {
    setBusy(true);
    try {
      const written = note.trim();
      const result = await api.resolveFreeReviewDispute(taskId, resolution, written || null);
      onChanged(result.state);
      setPending(null);
      setNote("");
      notify(resolution === "withdrawn"
        ? `这一轮不用改了：第 ${round.round} 轮那条意见作废（记为采纳执行者说法），审查记录原样保留`
        : resolution === "deferred"
          ? result.deferredTask
            ? `已转为独立任务：${result.deferredTask.title}（待办，未起跑）`
            : "已转为独立任务"
          : result.repairError
            ? `已让它接着改，但发起修复失败：${result.repairError}`
            : `已让它接着改：按${written ? "你写的要点和" : ""}第 ${round.round} 轮报告发起修复`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "裁定失败");
    } finally {
      setBusy(false);
    }
  };

  /**
   * 「用这段作要点」：把某一段发言灌进要点栏，并直接打开「让它接着改」的确认框。
   *
   * 已经写了字就往后追加而不是覆盖——用户可能先自己写了半句再想起来引用，覆盖掉等于
   * 把他刚打的字吃了。落点是 upheld 那一档：引用一段发言的意思就是「照这个改」。
   */
  const quote = (turn: FreeReviewDebateTurn) => {
    const quoted = `〔${DEBATE_SIDE_LABEL[turn.side]}第 ${turn.seq} 段〕\n${turn.statement}`;
    setNote((current) => (current.trim() ? `${current.trimEnd()}\n\n${quoted}` : quoted));
    setPending("upheld");
  };

  /** 三个裁定确认框共用的要点输入框（措辞按档位换，见 RESOLUTIONS）。 */
  const noteField = (kind: DisputeResolutionKind) => (
    <label className="free-review-dispute-note">
      <span>{RESOLUTIONS[kind].note.label}</span>
      <textarea
        autoFocus
        rows={4}
        value={note}
        maxLength={4000}
        disabled={busy}
        placeholder="例：第 2 条我认，但按刚才辩论里达成的方案做，别按报告里那版改法。"
        onChange={(event) => setNote(event.target.value)}
      />
      <small>{RESOLUTIONS[kind].note.hint}</small>
    </label>
  );

  /** 一个出口 = 一行：按钮 + 「我什么时候该点它」。竖排是为了让三档的差别一眼可比。 */
  const exit = (kind: DisputeResolutionKind, icon: ReactNode, primary = false) => (
    <li>
      <button
        type="button"
        className={primary ? "is-primary" : ""}
        disabled={blocked || busy}
        onClick={() => setPending(kind)}
      >{icon}{RESOLUTIONS[kind].button}</button>
      <small>{RESOLUTIONS[kind].blurb}</small>
    </li>
  );

  /** 确认框里的正文一律走 ConfirmDialog 自己的 `message`（口径见 disputeCopy.ts）。 */
  const confirmMessage = (kind: DisputeResolutionKind, extra = "") =>
    `${resolutionConfirmText(kind, round.round)}${extra ? `\n${extra}` : ""}`;

  /** 要点栏 + 留档那行小字（「时间线上记作…」，口径③）。 */
  const confirmBody = (kind: DisputeResolutionKind) => (
    <>
      {noteField(kind)}
      <small className="free-review-dispute-recorded">{RESOLUTIONS[kind].recorded}</small>
    </>
  );

  return (
    <section className="free-review-dispute-card" aria-label="执行者驳回审查意见">
      <header>
        <span><HandPalm size={13} weight="fill" /></span>
        <div>
          <b>{disputeHeadline(round, dispute)}</b>
          <small>{run.reviewerName} · {debateRunning ? "辩论进行中" : "等你拍板"}</small>
        </div>
      </header>

      {/* 执行者的一句人话（`PLAIN_SUMMARY_GUIDE`，必填字段）。它是这一屏的主角：用户
          先读它，再决定要不要展开下面那几百到几千字的依据。老驳回没有这一句，此时不
          编一句糊上去，直接把正文摊开。 */}
      {dispute.summary && <p className="free-review-dispute-card__gist">{dispute.summary}</p>}

      {dispute.reason && (
        <FoldedProse
          label={DISPUTE_PROSE_LABELS.reason}
          text={dispute.reason}
          open={!dispute.summary}
        />
      )}
      {deferReason && (
        <FoldedProse
          label={DISPUTE_PROSE_LABELS.defer}
          text={deferReason}
          open={!dispute.summary}
          tone="defer"
        />
      )}
      {onOpenReport && (
        <button type="button" className="free-review-dispute-card__report" onClick={onOpenReport}>
          <FileText size={11} aria-hidden="true" />看审查者在第 {round.round} 轮报告里怎么说
        </button>
      )}

      {debates.map((item, index) => {
        const ordinal = debates.length > 1 ? index + 1 : null;
        return (
          <FreeReviewDebateTranscript
            key={item.id}
            debate={item}
            ordinal={ordinal}
            // 面板这一栏只有 ~540px，七段发言在里面是一根一万像素高的细条（用户 2026-09-24
            // 实测）。正文归属没错，错的是读不下去，所以给一个够宽的读法而不是搬家。
            // 辩完最常见的用法就是「照某一段说的办」，所以每段都挂了「用这段作要点」；
            // 辩论没结束时不给（此刻裁定后端也会拒）。
            onQuote={blocked || busy ? undefined : quote}
            action={(
              <button
                type="button"
                className="free-review-debate__expand"
                onClick={() => setReading(item.id)}
              >
                <ArrowsOutSimple size={11} aria-hidden="true" />全宽阅读
              </button>
            )}
          />
        );
      })}

      <p>{disputeStatusLine(latestDebate)}</p>

      <ul className="free-review-dispute-card__exits">
        {/* 主出口排第一颗：辩论之后绝大多数情况下要的就是「带着刚谈定的方案接着改」。 */}
        {exit("upheld", <Wrench size={12} />, true)}
        {exit("withdrawn", <HandPalm size={12} />)}
        {deferReason && exit("deferred", <ArrowSquareOut size={12} />)}
        {(canDebate || debateRunning) && (
          <li>
            <button type="button" disabled={blocked || busy} onClick={() => setPending("debate")}>
              {debateRunning ? <SpinnerGap size={12} className="is-spinning" /> : <ChatsCircle size={12} />}
              {latestDebate ? "重开辩论" : "让双方辩论"}
            </button>
            <small>还拿不准 —— 让两边各说几段再定</small>
          </li>
        )}
      </ul>

      {readingDebate && (
        <FreeReviewDebateReader
          debate={readingDebate}
          title={`第 ${round.round} 轮审查意见 · ${run.reviewerName}`}
          ordinal={debates.length > 1 ? debates.indexOf(readingDebate) + 1 : null}
          onClose={() => setReading(null)}
        />
      )}
      {pending === "debate" && (
        <ConfirmDialog
          title="让审查者和执行者辩论"
          eyebrow="CONFIRM ACTION"
          icon={<ChatsCircle size={19} weight="duotone" />}
          message="双方轮流发言，都不改代码；说完还是回到这张卡上由你拍板。"
          confirmLabel="开始辩论"
          busy={busy}
          onConfirm={() => void startDebate()}
          onClose={() => { if (!busy) setPending(null); }}
        >
          <div className="free-review-debate-exchanges">
            <b>辩几个来回</b>
            <div>
              {Array.from({ length: MAX_FREE_REVIEW_DEBATE_EXCHANGES }, (_, index) => index + 1).map((count) => (
                <button
                  key={count}
                  type="button"
                  className={count === exchanges ? "is-selected" : ""}
                  aria-pressed={count === exchanges}
                  onClick={() => setExchanges(count)}
                >{count}</button>
              ))}
            </div>
            <small>一个来回 = 审查者答辩 + 执行者回应；末尾审查者再收个尾，共 {exchanges * 2 + 1} 段发言。</small>
          </div>
        </ConfirmDialog>
      )}
      {pending === "deferred" && (
        <ConfirmDialog
          title={RESOLUTIONS.deferred.title}
          eyebrow="CONFIRM ACTION"
          icon={<ArrowSquareOut size={19} weight="duotone" />}
          message={confirmMessage("deferred")}
          confirmLabel={RESOLUTIONS.deferred.confirmLabel}
          busy={busy}
          onConfirm={() => void resolve("deferred")}
          onClose={() => { if (!busy) setPending(null); }}
        >{confirmBody("deferred")}</ConfirmDialog>
      )}
      {pending === "withdrawn" && (
        <ConfirmDialog
          title={RESOLUTIONS.withdrawn.title}
          message={confirmMessage("withdrawn")}
          confirmLabel={RESOLUTIONS.withdrawn.confirmLabel}
          busy={busy}
          onConfirm={() => void resolve("withdrawn")}
          onClose={() => { if (!busy) setPending(null); }}
        >{confirmBody("withdrawn")}</ConfirmDialog>
      )}
      {pending === "upheld" && (
        <ConfirmDialog
          title={RESOLUTIONS.upheld.title}
          message={confirmMessage(
            "upheld",
            // 辩论收尾那一段执行者结构上没见过（修复指令里会整段抄给它），这里说出来，
            // 免得用户以为「它刚才都听见了」而把要点栏留空。
            latestDebate?.status === "finished"
              ? "辩论里审查者最后那段会一并发给它 —— 它自己的会话里没有那一段。"
              : "",
          )}
          confirmLabel={RESOLUTIONS.upheld.confirmLabel}
          busy={busy}
          onConfirm={() => void resolve("upheld")}
          onClose={() => { if (!busy) setPending(null); }}
        >{confirmBody("upheld")}</ConfirmDialog>
      )}
    </section>
  );
}
