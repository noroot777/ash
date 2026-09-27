import { useState } from "react";
import type { FreeReviewDebateTurn, FreeReviewRound, FreeReviewRun } from "@ash/shared";
import { MAX_FREE_REVIEW_DEBATE_EXCHANGES } from "@ash/shared/free-workflow";
import { ArrowSquareOut, ArrowsOutSimple, ChatsCircle, HandPalm, SpinnerGap, Wrench } from "@phosphor-icons/react";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { DEBATE_SIDE_LABEL } from "./debateModel.ts";
import { FreeReviewDebateReader } from "./FreeReviewDebateReader.tsx";
import { FreeReviewDebateTranscript } from "./FreeReviewDebateTranscript.tsx";

type Pending = "debate" | "withdrawn" | "upheld" | "deferred";

/**
 * 三个出口的按钮文案。
 *
 * **按「接下来干什么」命名，不按「谁对」命名**（用户 2026-09-27 拍的板）。上一版叫
 * 「维持意见并修复」和「采纳执行者说法」——那是裁判用语，回答的是谁赢；而用户真正要
 * 做的是下一步的指令。两者一旦分叉，界面就会问出一个没有正确答案的问题：辩论辩出
 * 「第 2 条成立，但按后来达成的新方案做」时，既不是「维持」原报告（报告要的是另一版），
 * 也不是「采纳执行者」（它说的是这条不成立），用户只能在两颗都不对的按钮里挑一颗。
 *
 * 「谁对」是**事实**，仍要留档——它写在确认框、时间线和审查记录里，那才是它该待的
 * 地方。按钮是下命令用的，不是记分用的。
 */
const RESOLUTIONS = {
  upheld: {
    button: "让它接着改",
    title: "让执行者接着改",
    note: {
      label: "写给执行者的要点（选填）",
      hint: "会随修复指令一起发过去，并注明与报告冲突时以你这段为准；留空就是照报告改。",
    },
  },
  withdrawn: {
    button: "这一轮不用改了",
    title: "这一轮不用改了",
    note: {
      label: "记下你的理由（选填）",
      hint: "这一档不会给执行者发任何消息，这段话只留在审查记录和时间线里备查。",
    },
  },
  deferred: {
    button: "转为独立任务",
    title: "转为独立任务",
    note: {
      label: "写给新任务的要点（选填）",
      hint: "会写进新建那个待办任务的描述里，接手的人一开始就看得到。",
    },
  },
} as const;

/**
 * 「执行者不认这一轮意见」的那张卡：驳回理由 + 辩论回放 + 几个只有用户能按的出口。
 *
 * 出口互不等价，确认框的文案必须把差别说死（按钮上只写动作，见 RESOLUTIONS）：
 * - 让双方辩论：先听几段再决定，**不改变任何结论**，辩完还是回到这张卡上裁定。
 * - 这一轮不用改了（记为采纳执行者）：这条未通过意见作废；审查记录与证据原样留着，
 *   那条 run 也**不会**被改写成「已通过」——替审查者签字比留一条「用户裁定作废」的
 *   记录危险得多。
 * - 转为独立任务：意见**成立**，只是不属于本任务边界（多半是本轮修复引入的衍生问题）。
 *   建一个待办派生任务把它带走，本轮不再在这里修。**只在执行者逐条写明越界依据时才
 *   出现**——凭空给这颗按钮，它就成了谁都能按的免修开关（后端同样拒绝，这里不是唯一
 *   防线）。它与上一档的差别是：那条意见没有作废，只是换了个地方修。
 * - 让它接着改（记为维持审查意见）：驳回不被采纳，后端接着发起修复。
 *
 * 三档共用一栏**裁定要点**：辩论常常辩出「第 2 条我认，但按后来达成的方案做」这种
 * 结论，三档一个都表达不了它。没有这一栏时用户只能事后再手打一条续聊，而那段话不在
 * 任何结构化状态里，也比修复指令到得晚。辩论回放的每一段还挂着「用这段作要点」，
 * 省掉跨面板的手动复制——最常见的一次裁定就是「照审查者收尾说的办」。
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
  const noteField = (kind: "withdrawn" | "upheld" | "deferred") => (
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
      <p>
        {debateRunning
          ? "双方正在各自陈词；辩论只产生发言，不改变结论，说完仍由你裁定。"
          : latestDebate?.status === "finished"
            // 辩完最常见的结论恰恰落在三档之间（「这条我认，但按刚才达成的方案做」），
            // 不点明要点栏的话，用户只会在两颗都不对的按钮之间挑一颗。
            ? "双方都说完了。审查者收尾时给的只是它自己的立场，最后由你裁定；想让它照某一段说的办，点那一段上的「用这段作要点」。"
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
            <ArrowSquareOut size={12} />{RESOLUTIONS.deferred.button}
          </button>
        )}
        <button type="button" disabled={blocked || busy} onClick={() => setPending("withdrawn")}>
          <HandPalm size={12} />{RESOLUTIONS.withdrawn.button}
        </button>
        {/* 主按钮：辩论之后绝大多数情况下要的就是「带着刚谈定的方案接着改」。 */}
        <button className="is-primary" type="button" disabled={blocked || busy} onClick={() => setPending("upheld")}>
          <Wrench size={12} />{RESOLUTIONS.upheld.button}
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
          title={RESOLUTIONS.withdrawn.title}
          message={
            `第 ${round.round} 轮那条未通过意见作废，执行者不再按它修改，记为「用户采纳执行者说法」。` +
            "审查报告与截图原样保留，这条审查链也不会被改写成「已通过」。"
          }
          confirmLabel="作废这条意见"
          busy={busy}
          onConfirm={() => void resolve("withdrawn")}
          onClose={() => { if (!busy) setPending(null); }}
        >{noteField("withdrawn")}</ConfirmDialog>
      )}
      {pending === "upheld" && (
        <ConfirmDialog
          title={RESOLUTIONS.upheld.title}
          message={
            // 记录里这一档仍叫「维持审查意见」（= 没有采纳执行者的驳回），那是要留档的
            // 事实。按钮上只写动作，所以这里必须把两个说法对上，否则用户在时间线上会
            // 读到一个他没按过的词。
            "执行者的驳回不被采纳（记为「维持审查意见」），后端接着发起修复。" +
            `下面写了要点就按要点 + 第 ${round.round} 轮报告改，留空就照报告改。` +
            (latestDebate?.status === "finished"
              // 辩论收尾那一段执行者结构上没见过（后端会随修复指令整段抄给它），这里
              // 说出来，免得用户以为「它刚才都听见了」而把要点栏留空。
              ? "辩论里审查者的收尾发言会一并发给它——那一段它自己的会话里没有。"
              : "")
          }
          confirmLabel="发起修复"
          busy={busy}
          onConfirm={() => void resolve("upheld")}
          onClose={() => { if (!busy) setPending(null); }}
        >{noteField("upheld")}</ConfirmDialog>
      )}
    </section>
  );
}
