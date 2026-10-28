import { useEffect, useState } from "react";
import { HandPalm } from "@phosphor-icons/react";
import { api, type LaunchResidueView } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import "./launch-abandon-dialog.css";

// 「这次启动的管理责任我自己接手了」——一个**显式**出口。为什么非得有它、以及它跟「静默
// 核销」的分界线在哪，写在 server/src/terminal-abandon.ts 的文件头（端口归属核不上时整条
// 链路一律悲观：起不动、停不掉、连项目都删不掉，而界面上一个出口都没有）。
//
// 这个框的三条硬要求都来自那份判据：
//   ① **先摆事实再签字**：开框先只读地问一遍残留（哪个 pid 还活着、端口上坐着谁），
//      拿不到就不许按——让人在看不见的东西上签字，等于把显式确认做成了静默核销；
//   ② **解除范围原样显示**：ash 从此不再做哪几件事，逐条列出来，按之前就读得到；
//   ③ **它不是「已停止」**：文案一个字都不许说停了。放弃之后那些进程大概率还在跑，
//      只是从此由用户自己处理。
//
// 期间这条命令又起了一份时后端回 409（签字针对的是用户刚看过的那条会话 id）——这里照实
// 说一句并重新拉一遍残留，让他对着新的那一份重新决定。

const when = (at: number) => new Date(at).toLocaleString("zh-CN");

export function LaunchAbandonDialog({ projectId, commandId, onClose, onDone, notify }: {
  projectId: string;
  commandId: string;
  onClose: () => void;
  /** 签字成功：调用方刷新会话事实。 */
  onDone: () => void;
  notify: (message: string) => void;
}) {
  const [view, setView] = useState<LaunchResidueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setView(null);
    setError(null);
    api.launchResidue(projectId, commandId)
      .then(setView)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "残留事实读不出来"));
  };
  useEffect(load, [projectId, commandId]);

  const confirm = () => {
    if (!view || busy) return;
    setBusy(true);
    api.abandonLaunch(projectId, commandId, view.sessionId)
      .then((result) => {
        notify(result.alreadyAbandoned
          ? `「${view.name}」这次启动早先已经放弃过，这次没有改动那份记录`
          : `已放弃「${view.name}」这次启动的管理责任——上面列出的残留从此由你自己处理`);
        onDone();
        onClose();
      })
      .catch((cause) => {
        notify(cause instanceof Error ? cause.message : "放弃失败");
        // 409 = 期间又起了一份。重新拉一遍，让他对着**新的**那条会话重新看、重新决定。
        setAcknowledged(false);
        load();
      })
      .finally(() => setBusy(false));
  };

  const done = view?.abandoned ?? null;
  return <ConfirmDialog
    title={view ? `放弃「${view.name}」这次启动的管理责任` : "放弃这次启动的管理责任"}
    message={done
      ? `这次启动的管理责任已经在 ${when(done.at)} 放弃过了。下面是当时记下的残留事实。`
      : "ash 不再把这次启动当「还在跑」的东西管，删除保护一并解除。它不杀任何进程，也不代表服务停了——下面这些残留从此由你自己处理。"}
    eyebrow="ABANDON LAUNCH"
    icon={<HandPalm size={18} weight="fill" />}
    danger
    confirmLabel={done ? "知道了" : "放弃管理责任"}
    confirmDisabled={!done && (!view || !acknowledged)}
    busy={busy}
    onConfirm={done ? onClose : confirm}
    onClose={onClose}
  >
    <div className="launch-abandon">
      {error && <p className="launch-abandon__error">残留事实读不出来：{error}（没看清现场就不该签字）</p>}
      {!view && !error && <p className="launch-abandon__loading">正在问一遍此刻还有什么活着…</p>}
      {view && (
        <>
          <p className="launch-abandon__notice">{(done ?? view.residue).notice}</p>
          <ul className="launch-abandon__facts">
            <li>启动时间：{when(view.startedAt)}</li>
            {(done ?? view.residue).taggedPids.length > 0 && (
              <li>带这次启动记号还活着：pid {(done ?? view.residue).taggedPids.join("、")}</li>
            )}
            {(done ?? view.residue).owedPids.length > 0 && (
              <li>账上没核销的号：pid {(done ?? view.residue).owedPids.join("、")}</li>
            )}
            {(done ?? view.residue).ports.length > 0 && (
              <li>这次启动记下的端口：{(done ?? view.residue).ports.join("、")}（归属：{(done ?? view.residue).portState}）</li>
            )}
          </ul>
          {!done && (
            <>
              <p className="launch-abandon__scope-title">放弃之后 ash 不再做这几件事：</p>
              <ul className="launch-abandon__scope">
                {view.scope.map((line) => <li key={line}>{line}</li>)}
              </ul>
              <label className="launch-abandon__ack">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>我已经看过上面的残留，这些进程/端口由我自己处理</span>
              </label>
            </>
          )}
        </>
      )}
    </div>
  </ConfirmDialog>;
}
