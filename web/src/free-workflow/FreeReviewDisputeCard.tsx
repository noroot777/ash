import { useState } from "react";
import type { FreeReviewRound, FreeReviewRun } from "@ash/shared";
import { MAX_FREE_REVIEW_DEBATE_EXCHANGES } from "@ash/shared/free-workflow";
import { ArrowSquareOut, ArrowsOutSimple, ChatsCircle, HandPalm, SpinnerGap, Wrench } from "@phosphor-icons/react";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { FreeReviewDebateReader } from "./FreeReviewDebateReader.tsx";
import { FreeReviewDebateTranscript } from "./FreeReviewDebateTranscript.tsx";

type Pending = "debate" | "withdrawn" | "upheld" | "deferred";

/** 裁定要点在三档裁定里各自流向哪儿——文案必须说死，否则用户不知道这段话有没有人看。 */
const NOTE_FIELDS: Record<"withdrawn" | "upheld" | "deferred", { label: string; hint: string }> = {
  upheld: {
    label: "写给执行者的要点（选填）",
    hint: "会随修复指令一起发过去，并注明与报告冲突时以你这段为准。",
  },
  withdrawn: {
    label: "记下你的理由（选填）",
    hint: "这一档不会给执行者发任何消息，这段话只留在审查记录和时间线里备查。",
  },
  deferred: {
    label: "写给新任务的要点（选填）",
    hint: "会写进新建那个待办任务的描述里，接手的人一开始就看得到。",
  },
};

/**
 * 「执行者不认这一轮意见」的那张卡：驳回理由 + 辩论回放 + 几个只有用户能按的出口。
 *
 * 出口互不等价，文案必须把差别说死：
 * - 让双方辩论：先听几段再决定，**不改变任何结论**，辩完还是回到这张卡上裁定。
 * - 采纳执行者：这条未通过意见作废；审查记录与证据原样留着，那条 run 也**不会**被
 *   改写成「已通过」——替审查者签字比留一条「用户裁定作废」的记录危险得多。
 * - 转为独立任务：意见**成立**，只是不属于本任务边界（多半是本轮修复引入的衍生问题）。
 *   建一个待办派生任务把它带走，本轮不再在这里修。**只在执行者逐条写明越界依据时才
 *   出现**——凭空给这颗按钮，它就成了谁都能按的免修开关（后端同样拒绝，这里不是唯一
 *   防线）。它与「采纳执行者」的差别是：那条意见没有作废，只是换了个地方修。
 * - 维持意见：驳回作废，后端接着按原报告发起修复。
 *
 * 三档之外还有一栏**裁定要点**：辩论常常辩出「第 2 条我认，但按后来达成的方案做，
 * 不是报告里那版」这种结论，三档一个都表达不了它（`upheld` 会让执行者照原报告改，
 * 正好是双方都已否掉的那版）。没有这一栏时用户只能事后再手打一条续聊，而那段话不在
 * 任何结构化状态里，也比修复指令到得晚。
 */
export function FreeReviewDisputeCard({
  taskId,
  run,
  round,
  disabled = false,
  onChanged,
  notify,
}: {
  taskId: string;
  run: FreeReviewRun;
  round: FreeReviewRound;
  disabled?: boolean;
  onChanged: (state: FreeWorkflowApiState) => void;
  notify: (message: string) => void;
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
  // 只提了转出、一条都没驳：标题不能还写「驳回了意见」——那会让用户以为执行者在说
  // 报告不对，而它说的恰恰是「报告是对的，只是不该在这儿修」。
  const deferOnly = !!deferReason && !dispute.reason;

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

  const resolve = async (resolution: "withdrawn" | "upheld" | "deferred") => {
    setBusy(true);
    try {
      const written = note.trim();
      const result = await api.resolveFreeReviewDispute(taskId, resolution, written || null);
      onChanged(result.state);
      setPending(null);
      setNote("");
      notify(resolution === "withdrawn"
        ? `已采纳执行者说法：第 ${round.round} 轮那条意见作废，审查记录原样保留`
        : resolution === "deferred"
          ? result.deferredTask
            ? `已转为独立任务：${result.deferredTask.title}（待办，未起跑）`
            : "已转为独立任务"
          : result.repairError
            ? `已维持审查意见，但发起修复失败：${result.repairError}`
            : `已维持审查意见，正在按第 ${round.round} 轮报告${written ? "和你写的要点" : ""}发起修复`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "裁定失败");
    } finally {
      setBusy(false);
    }
  };

  /** 三个裁定确认框共用的要点输入框（措辞按档位换，见 NOTE_FIELDS）。 */
  const noteField = (kind: "withdrawn" | "upheld" | "deferred") => (
    <label className="free-review-dispute-note">
      <span>{NOTE_FIELDS[kind].label}</span>
      <textarea
        autoFocus
        rows={4}
        value={note}
        maxLength={4000}
        disabled={busy}
        placeholder="例：第 2 条我认，但按刚才辩论里达成的方案做，别按报告里那版改法。"
        onChange={(event) => setNote(event.target.value)}
      />
      <small>{NOTE_FIELDS[kind].hint}</small>
    </label>
  );

  return (
    <section className="free-review-dispute-card" aria-label="执行者驳回审查意见">
      <header>
        <span><HandPalm size={13} weight="fill" /></span>
        <div>
          <b>{deferOnly
            ? `执行者认为第 ${round.round} 轮意见超出本任务边界`
            : `执行者驳回了第 ${round.round} 轮意见`}</b>
          <small>{run.reviewerName} · {debateRunning ? "辩论进行中" : "等你裁定"}</small>
        </div>
      </header>
      {dispute.reason && (
        <div className="free-review-dispute-card__reason">
          <b>驳回理由</b>
          <MarkdownBody text={dispute.reason} />
        </div>
      )}
      {deferReason && (
        <div className="free-review-dispute-card__reason is-defer">
          <b>认可、但认为超出本任务边界的那几条</b>
          <MarkdownBody text={deferReason} />
        </div>
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
      <p>
        {debateRunning
          ? "双方正在各自陈词；辩论只产生发言，不改变结论，说完仍由你裁定。"
          : latestDebate?.status === "finished"
            // 辩完最常见的结论恰恰落在三档之间（「这条我认，但按刚才达成的方案做」），
            // 不点明要点栏的话，用户只会在两颗都不对的按钮之间挑一颗。
            ? "双方都说完了。审查者收尾时给的只是它自己的立场，最后由你裁定；辩出来的结论如果三档都表达不了，写进裁定时的要点栏。"
            : latestDebate?.status === "failed"
              ? "上一场辩论中途断了（有一段没能发言）；可以重开一场，也可以直接裁定。"
              : "审查链已停在这里：既没有照改，也没有当成通过。"}
      </p>
      <div className="free-review-dispute-card__actions">
        {(canDebate || debateRunning) && (
          <button type="button" disabled={blocked || busy} onClick={() => setPending("debate")}>
            {debateRunning ? <SpinnerGap size={12} className="is-spinning" /> : <ChatsCircle size={12} />}
            {latestDebate ? "重开辩论" : "让双方辩论"}
          </button>
        )}
        {deferReason && (
          <button type="button" disabled={blocked || busy} onClick={() => setPending("deferred")}>
            <ArrowSquareOut size={12} />转为独立任务
          </button>
        )}
        <button type="button" disabled={blocked || busy} onClick={() => setPending("withdrawn")}>
          <HandPalm size={12} />采纳执行者说法
        </button>
        <button type="button" disabled={blocked || busy} onClick={() => setPending("upheld")}>
          <Wrench size={12} />维持意见并修复
        </button>
      </div>

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
          message="双方会轮流发言、都不改代码；辩完仍然回到这张卡上由你裁定。"
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
          title="转为独立任务"
          eyebrow="CONFIRM ACTION"
          icon={<ArrowSquareOut size={19} weight="duotone" />}
          message={
            `会建一个待办、不起跑的新任务，把上面那几条意见连同第 ${round.round} 轮的报告与证据目录带过去，` +
            "并回链到本任务。这几条意见没有作废，只是不在本任务里修；审查报告与截图原样保留，" +
            "这条审查链也不会被改写成「已通过」。什么时候开工由你决定。" +
            "本任务这一轮到此为止：执行者已经改掉的那部分还没审过，要继续推进就再派一轮审查。"
          }
          confirmLabel="建任务并转走这几条"
          busy={busy}
          onConfirm={() => void resolve("deferred")}
          onClose={() => { if (!busy) setPending(null); }}
        >{noteField("deferred")}</ConfirmDialog>
      )}
      {pending === "withdrawn" && (
        <ConfirmDialog
          title="采纳执行者说法"
          message={`第 ${round.round} 轮那条未通过意见作废，执行者不再按它修改。审查报告与截图原样保留，这条审查链也不会被改写成「已通过」。`}
          confirmLabel="采纳，作废这条意见"
          busy={busy}
          onConfirm={() => void resolve("withdrawn")}
          onClose={() => { if (!busy) setPending(null); }}
        >{noteField("withdrawn")}</ConfirmDialog>
      )}
      {pending === "upheld" && (
        <ConfirmDialog
          title="维持审查意见"
          message={
            `驳回作废，执行者会按第 ${round.round} 轮报告继续修复。` +
            (latestDebate?.status === "finished"
              // 辩论收尾那一段执行者结构上没见过（后端会随修复指令整段抄给它），这里
              // 说出来，免得用户以为「它刚才都听见了」而把要点栏留空。
              ? "辩论里审查者的收尾发言会一并发给它——那一段它自己的会话里没有。"
              : "")
          }
          confirmLabel="维持并发起修复"
          busy={busy}
          onConfirm={() => void resolve("upheld")}
          onClose={() => { if (!busy) setPending(null); }}
        >{noteField("upheld")}</ConfirmDialog>
      )}
    </section>
  );
}
