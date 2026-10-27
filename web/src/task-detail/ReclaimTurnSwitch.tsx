import { useState } from "react";
import { LockOpen } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";

// 「放开回合占位」那个开关。
//
// 为什么要有它:占着不动的回合占位会让这个任务点运行一律被挡回「任务回合正在进行」,而
// 停止只杀进程、碰不到它。系统**不会自动放开** —— 判据(没句柄、没令牌、占得久)证不了
// 原持有者已经结束,duet 等人工裁决、dispatch 等仓库锁都能长时间长成这个样子,自动拔锁
// 解除的是互斥本身。所以照 AGENTS.md 对这类不可逆又外溢操作的口径:系统如实上报,放开
// 由用户自己按,按之前把副作用说清楚。
//
// 上一版只有服务端有这条路,界面上一个入口都没有,而诊断文案还让用户去点「运行」——那条
// 路只会继续 409(第 2 轮审查 F3)。
export function ReclaimTurnSwitch({ taskId, onDone }: { taskId: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [released, setReleased] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const release = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.reclaimTurn(taskId, true);
      setResult(r.note);
      setReleased(r.reclaimed);
      // **锁放开了不等于任务点得动了。** 放开只撤内存里那把锁,库里的状态归另一个人负责,
      // 而这条路要救的正是「没有人会来负责」的遗留 —— 于是任务停在排队中、点运行继续被
      // 挡回(第 1 轮审查 F3 实测)。
      //
      // 所以只有真恢复了才 `onDone`:那一下会刷新 notices、remedy 变 null、这块跟着卸载,
      // 对「已经解决」是对的。没恢复就**留在原地** —— 这段 note 里写着接着该做哪一步,
      // 它是用户当场唯一看得见的下一步(服务端同时落了一条 `incomplete` 通知到任务历史,
      // 刷新之后照样在)。收起来等于让他对着一个消失的开关猜。
      if (r.runnable) onDone?.();
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="task-turn-remedy" role="group">
      <p>
        <LockOpen size={14} aria-hidden="true" />
        <span>
          这个任务的回合占位占着不动，点运行会被挡回。系统无法确认占着它的那一位是否真的已经
          结束，所以不会自动放开；确认它不动了可以手动解开——
          <strong>代价是万一那一位还活着，互斥就没了，同一个任务会有两个回合并行改同一个工作区。</strong>
        </span>
      </p>
      <button type="button" onClick={() => void release()} disabled={busy || released}>
        {busy ? "正在放开…" : released ? "已放开" : "放开回合占位"}
      </button>
      {result && <p className="task-turn-remedy__result" role="status">{result}</p>}
    </div>
  );
}
