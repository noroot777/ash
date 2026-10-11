// 团队视图顶上那两条状态提示：全组已停止、computer-use 服务仍有残留。
//
// 从 TeamView 里拎出来只因为那份已经顶到单文件 700 行上限；两条的共同点是「**停下来之后**
// 用户还得能看见发生过什么」——只弹个 toast 不算数（根 AGENTS.md「停止/暂停必须留下持久
// 可见的状态」），所以它们都是刷新后仍在的常驻条，而不是一次性提示。
import { useState } from "react";
import { Broom, WarningCircle } from "@phosphor-icons/react";
import type { TaskListItem } from "@ash/shared";
import { workerHaltStats } from "@ash/shared/team";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { api, type TeamCuaStatus } from "../lib/api.ts";

export function HaltNotice({ workers, groupCount, historyOnly }: { workers: TaskListItem[]; groupCount: number; historyOnly: boolean }) {
  const stats = workerHaltStats(workers);
  return (
    <div className="team-halt-notice" role="status">
      <b>全组已停止</b>
      <span>{stats.interrupted} 个执行者被暂停打断 · {stats.completed} 个已完成 · {stats.waiting} 个尚未启动</span>
      <small>{historyOnly ? "停止记录来自持久会话；内部组详情暂未返回" : `${groupCount} 个内部组保持暂停，刷新页面后仍可见`}</small>
    </div>
  );
}

export function CuaResidualNotice({ taskId, status, onStatus, notify }: { taskId: string; status: TeamCuaStatus | null; onStatus: (status: TeamCuaStatus | null) => void; notify: (message: string) => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = status?.current;
  // applicable === false：非 macOS，这套机制根本不存在，这块提示连同「强制清理」
  // 按钮一起不该出现（detected 本来也会是 false，这一条是防御性的第二道）。
  if (!current?.detected || current.applicable === false) return null;
  const kill = async () => {
    setBusy(true);
    try {
      await api.killTeamCua(taskId);
      onStatus(await api.teamCuaStatus(taskId));
      setConfirmOpen(false);
      notify("已请求强制清理 computer-use 服务");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="team-cua-notice" role="alert">
        <WarningCircle size={14} weight="fill" />
        <b>computer-use 服务仍在运行</b>
        <span>{current.sideEffect}</span>
        {current.processes.length > 0 && <code>pid {current.processes.map((entry) => entry.pid).join(", ")}</code>}
        <button type="button" onClick={() => setConfirmOpen(true)}><Broom size={13} />强制清理</button>
      </div>
      {confirmOpen && <ConfirmDialog title="强制清理 computer-use？" message={current.sideEffect} confirmLabel="强制清理" danger busy={busy} onConfirm={() => void kill()} onClose={() => setConfirmOpen(false)} />}
    </>
  );
}
