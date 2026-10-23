// 回复框正上方那条「验收前置命令在跑」。
//
// 为什么不能只放在验收台上（用户 2026-10-23 指出）：那条命令是人点了「验收通过」才起跑
// 的，一跑十几分钟，而这期间**任务本身一个字都不会变** —— status 还是 done、stage 还是
// 等验收，会话最后一条还是智能体上一轮说的话。于是用户回到主会话页，看到的是一个安静
// 的、已经完成的任务，完全不知道此刻有一条命令正踩在它的工作区里跑。时间轴里确实写了
// 一行「开跑」，但再聊两句就被顶走了。
//
// 形态跟哨兵那条**完全一样**（共用 .wait-bar 骨架）：折叠是一条 26px 的横条，点开才摊成
// 卡。理由也一样 —— 常驻的东西必须先便宜，而常驻要回答的只有一句：还在跑吗、跑了多久。
// 只有颜色不同：哨兵是 accent，它是 amber，跟侧栏那颗呼吸的黄点对上（「这一条不是智能体
// 在跑」）。
import { useId, useState } from "react";
import { ArrowClockwise, CaretDown, FileText, SpinnerGap, WarningCircle, XCircle } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useAcceptGate } from "./useAcceptGate.ts";

export function AcceptGateWaitCard({ taskId, expected = false, notify }: {
  taskId: string;
  /**
   * 任务投影里那个「此刻有命令在跑」（`Task.acceptGateRunning`，由 SSE 跟着更新）。
   *
   * 它的用处只有一个：门禁状态读失败时，这条**仍然要出现**。否则一次 500 之后这条就
   * 整个消失，而用户看到的是一个安静的任务 —— 跟「什么都没在跑」一模一样（第 1 轮审查
   * 不拦项 3）。拿它当「该不该出现」的兜底，比让这条自己猜更准：它来自服务端。
   */
  expected?: boolean;
  notify: (message: string) => void;
}) {
  const { running, runningFor, error, reload } = useAcceptGate(taskId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 全文按**哪一次**缓着：同一个任务又跑一次之后，上一次的全文不能接着摆在那儿
  // （第 1 轮审查不拦项 2）。
  const [full, setFull] = useState<{ runId: string; text: string } | null>(null);
  const bodyId = useId();
  // 读不出来、但服务端说有在跑：如实说「读不出来」并给一颗重试，不装作没在跑。
  if (!running) {
    if (!expected || !error) return null;
    return (
      <section className="wait-bar accept-gate-wait" aria-label="验收前置命令">
        <div className="wait-bar__bar">
          <WarningCircle size={13} weight="fill" aria-hidden="true" />
          <b>验收前置命令在跑</b>
          <span className="wait-bar__brief">状态读不出来：{error}</span>
          <button type="button" className="wait-bar__retry" disabled={busy} onClick={() => void reload()}>
            <ArrowClockwise size={11} aria-hidden="true" />重试
          </button>
        </div>
      </section>
    );
  }
  const shownLog = full?.runId === running.id ? full.text : null;

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.cancelAcceptGate(taskId);
      notify("已收掉验收前置命令；这次没有合并，重新点验收会从头跑一遍");
      await reload();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const openLog = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setFull({ runId: running.id, text: await api.acceptGateLog(taskId, running.id) });
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`wait-bar accept-gate-wait${open ? " is-open" : ""}`} aria-label="验收前置命令">
      <button
        type="button"
        className="wait-bar__bar"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        <SpinnerGap size={13} className="is-spinning" aria-hidden="true" />
        <b>验收前置命令在跑</b>
        <span className="wait-bar__brief">{running.command}</span>
        <span className="wait-bar__when">已经 {runningFor}</span>
        <CaretDown size={11} weight="bold" className="wait-bar__caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="wait-bar__body" id={bodyId}>
          {(shownLog ?? running.logTail) && (
            <pre className="accept-gate-wait__log">{shownLog ?? running.logTail}</pre>
          )}
          <p className="wait-bar__note">
            {/* 不说「你点的」：MCP 的 accept_task、HTTP、工作流都触发得了这一次
                （第 1 轮审查不拦项 7），而发起人是谁这条不需要猜。 */}
            这是本次验收触发的：<code>{running.command}</code>，跑在 <code>{running.cwd}</code>。
            <b>rc=0 这次验收会自动做完，不用再点</b>；红了会把日志交回这个任务的智能体去修，
            目标分支一个字节都不会动。
          </p>
          <div className="wait-bar__ops">
            <button type="button" disabled={busy} onClick={() => void openLog()}>
              <FileText size={11} aria-hidden="true" />{shownLog === null ? "看完整日志" : "刷新日志"}
            </button>
            <button type="button" disabled={busy} onClick={() => void cancel()}>
              <XCircle size={11} aria-hidden="true" />不等了，收掉它
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
