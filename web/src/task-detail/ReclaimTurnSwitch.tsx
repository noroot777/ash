import { useEffect, useState } from "react";
import { LockOpen } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import type { HumanApprovalChallenge, HumanApprovalProof } from "../lib/taskNoticeApi.ts";

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
  const [needsReload, setNeedsReload] = useState(false);
  const [challenge, setChallenge] = useState<HumanApprovalChallenge | null>(null);
  const [proof, setProof] = useState("");
  const [now, setNow] = useState(Date.now);
  const remaining = challenge ? Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000)) : 0;
  useEffect(() => {
    if (!challenge || released) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challenge, released]);

  const requestApproval = async () => {
    setBusy(true);
    setResult(null);
    setNeedsReload(false);
    try {
      const next = await api.requestTurnApproval(taskId);
      if (next.challengeId !== challenge?.challengeId) setProof("");
      setChallenge(next);
      setNow(Date.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult(message);
      setNeedsReload(message.includes("页面凭据"));
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    setBusy(true);
    setResult(null);
    setNeedsReload(false);
    try {
      let approval: HumanApprovalProof | null;
      try { approval = JSON.parse(proof) as HumanApprovalProof | null; }
      catch { throw new Error("请粘贴有效的授权 JSON"); }
      if (!challenge || !approval || approval.challengeId !== challenge.challengeId || typeof approval.signature !== "string") {
        throw new Error("请粘贴当前申请对应的授权结果");
      }
      const r = await api.reclaimTurn(taskId, approval);
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
      // 凭据对不上(用过了、过期了、或者这一份是上次启动发的)时服务端回 403。恢复路径就是
      // 重新加载一次页面文档——那一刻会换到新的一份。这句得说出口:否则用户看到的是一个
      // 按下去没反应的开关(server/src/auth/human-action-token.ts)。
      const message = error instanceof Error ? error.message : String(error);
      setResult(message.includes("页面凭据") ? `${message}。` : message);
      setNeedsReload(message.includes("页面凭据"));
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
      <button type="button" onClick={() => void requestApproval()} disabled={busy || released}>
        {released ? "已放开" : busy ? "处理中…" : challenge ? "查看当前申请" : "申请人工授权"}
      </button>
      {challenge && !released && <>
        <p>将申请保存为 JSON，在不受本机 agent 控制的设备上核对并签名。{remaining > 0
          ? `预计剩余有效期 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}，以服务端校验为准，查看申请不会延长有效期。`
          : "本机计时显示可能已过期，仍可提交签名，由服务端校验；也可查看当前申请。"}</p>
        <textarea aria-label="人工授权申请" readOnly value={JSON.stringify(challenge, null, 2)} rows={5} />
        <textarea aria-label="人工授权结果" value={proof} onChange={(event) => setProof(event.target.value)} placeholder="粘贴签名授权 JSON" rows={3} disabled={busy} />
        <button type="button" onClick={() => void release()} disabled={busy || !proof.trim()}>
          {busy ? "正在放开…" : "确认风险并放开回合占位"}
        </button>
      </>}
      {result && (
        <p className="task-turn-remedy__result" role="status">
          {result}
          {needsReload && (
            <button type="button" onClick={() => location.reload()}>重新加载页面</button>
          )}
        </p>
      )}
    </div>
  );
}
