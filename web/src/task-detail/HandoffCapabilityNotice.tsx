// 能力握手的提示块:目标机跑不跑得动这个任务(装没装它要用的智能体、认不认那个模型)。
//
// 单任务对话框和批量对话框共用同一份 —— 判据在服务端(handoff-capability.ts),这里只负责
// 把结论摆出来。两边各写一份的话,措辞和「哪一档要勾确认」迟早会分叉,而这道闸恰恰是
// 「默认拦住」的那种,分叉的代价是某一边静默放行。
//
// 三档对应服务端的 status,展示上的区别就是**能不能接着点接力**:
//   · gaps + blocking  —— 目标机没装那个 CLI:红,必须勾「仍然接力」才放行;
//   · gaps 非 blocking —— 模型对不上:黄,只提示不拦(那边可能报错,也可能静默换模型跑完);
//   · unknown          —— 对端旧版报不出能力:灰,如实说无从核对,不拦。
import { Warning, WarningCircle, Info } from "@phosphor-icons/react";
import type { HandoffCapabilityReport } from "@ash/shared";

export function HandoffCapabilityNotice({
  capability,
  acknowledged,
  onAcknowledge,
  blockedCount,
}: {
  capability: HandoffCapabilityReport | null | undefined;
  /** 用户勾没勾「仍然接力」。blocking 档才用得上。 */
  acknowledged: boolean;
  onAcknowledge: (next: boolean) => void;
  /**
   * 批量场景:这批里有几个任务被拦下。非空时措辞换成「跳过」——批量的语义是把跑不动的
   * 那几个**留在本机**、其余照搬,而不是拦住整批(一个任务缺 CLI 不该挡住其余的)。
   */
  blockedCount?: number;
}) {
  if (!capability) return null;
  if (capability.status === "unknown") {
    return capability.unknownReason
      ? (
        <p className="handoff-peer-line">
          <Info size={13} aria-hidden="true" />
          <span>{capability.unknownReason}</span>
        </p>
      )
      : null;
  }
  if (capability.status === "ok") return null;
  const blocking = capability.blocking;
  return (
    <div className={`handoff-capability${blocking ? " is-blocking" : " is-warn"}`}>
      <p className="handoff-peer-line is-warn">
        {blocking
          ? <WarningCircle size={13} aria-hidden="true" />
          : <Warning size={13} aria-hidden="true" />}
        <span>
          {blocking
            ? blockedCount
              ? `这批里有 ${blockedCount} 个任务的执行器目标机跑不动，默认留在本机不搬：`
              : "目标机跑不动这个任务的执行器配置："
            : "目标机的模型清单里没有这个任务指定的模型："}
        </span>
      </p>
      <ul className="handoff-capability-list">
        {capability.gaps.map((gap) => (
          <li key={`${gap.slot}-${gap.agentType}-${gap.model ?? ""}`}>{gap.detail}</li>
        ))}
      </ul>
      {blocking && (
        <label className="handoff-capability-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => onAcknowledge(event.target.checked)}
          />
          <span>
            {blockedCount
              ? "仍然接力这几个 —— 我知道它们到那边跑起来会失败，会先在目标机装上智能体再运行。"
              : "仍然接力 —— 我知道任务到那边跑起来会失败，会先在目标机装上智能体（或到那边把任务改成它有的）再运行。"}
          </span>
        </label>
      )}
    </div>
  );
}
