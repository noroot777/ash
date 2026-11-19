import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ScheduledMessage } from "@navi/shared";
import type { TaskMonitor } from "@navi/shared/monitor";
import { ScheduledMessageTray, useScheduledMessages } from "../../src/components/ScheduledMessages.tsx";
import { joinDraftText } from "../../src/task-detail/withdrawDraft.ts";
import { useReplyLayout } from "../../src/task-detail/useReplyLayout.ts";
import "../../src/styles/global.css";

// 「挂上哨兵」打开后托盘里多出的四个在盯的哨兵（窄窗下收着那一行最挤的样子）。
const watchers = Array.from({ length: 4 }, (_, index) => ({
  id: `live-${index}`, taskId: "task-a", kind: "ash", nativeId: null, lifetime: "bounded", command: `watch ${index}`,
  description: `盯第 ${index + 1} 份日志`, cwd: "/repo", status: "running", pid: 1, events: 0, exitCode: null,
  startedAt: new Date(Date.now() - 3 * 60_000).toISOString(), startedAtExact: true,
  expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(), timeoutMs: 900_000,
  endedAt: null, endedReason: null, stopWhen: null, resultHandoffAt: null, resultsAbandonedAt: null,
}) as unknown as TaskMonitor);

function Fixture() {
  const [taskId, setTaskId] = useState("task-a");
  const [team, setTeam] = useState(false);
  const [watching, setWatching] = useState(false);
  const [draft, setDraft] = useState("未发送的草稿");
  const scheduled = useScheduledMessages(taskId);
  const shellRef = useReplyLayout();
  const withdraw = async (message: ScheduledMessage) => {
    if (!await scheduled.cancel(message.id)) return;
    setDraft((current) => joinDraftText(message.text, current));
  };
  return <>
    <nav style={{ height: 48, display: "flex", gap: 12, alignItems: "center", padding: "0 12px" }}>
      <button onClick={() => void scheduled.reload({ quiet: true })}>重新载入</button>
      <button onClick={() => setTaskId((current) => current === "task-a" ? "task-b" : "task-a")}>切换任务</button>
      <button onClick={() => setTeam((current) => !current)}>切换团队</button>
      <button onClick={() => setWatching((current) => !current)}>挂上哨兵</button>
      {/* 回复框发出一句后拿到的那份回执:只有这一行本身,没有服务端算的 wait / steerable。 */}
      <button onClick={() => {
        const shown = scheduled.messages.find((message) => message.steerable);
        if (!shown) return;
        const { wait: _wait, steerable: _steerable, ...receipt } = shown;
        scheduled.add(receipt);
      }}>模拟入队回执</button>
    </nav>
    <main className={team ? "team-flow-main" : "task-detail-main"} style={{ height: "calc(100dvh - 48px)", maxWidth: 1000, margin: "0 auto" }}>
      <div className="conversation-scroll-region"><section className={team ? "team-feed" : "task-conversation"}>
        <h1 style={{ fontSize: 18 }}>排队输入 · {team ? "团队" : "普通任务"}</h1>
        <p>当前回合继续运行，排队输入那一行点开向上长。</p>
        <button type="button">会话区域按钮</button>
      </section></div>
      <div ref={shellRef} className={team ? "team-reply-shell" : "task-reply-shell"}>
        <div className="reply-context">
        <ScheduledMessageTray key={taskId} messages={scheduled.messages} loading={scheduled.loading} error={scheduled.error}
          cancelingIds={scheduled.cancelingIds} steeringIds={scheduled.steeringIds}
          onSteer={team ? undefined : (messageId) => void scheduled.steer(messageId)}
          onWithdraw={(message) => void withdraw(message)} onCancel={(messageId) => void scheduled.cancel(messageId)}
          monitors={watching ? { live: watchers, ended: new Set(), running: true, resumePrompt: null, reviewArmed: false,
            onOpen: () => undefined, onStop: async () => undefined } : undefined} />
        </div>
        <div className={team ? "team-reply-box" : "task-reply-box"}>
          <textarea aria-label="回复草稿" value={draft} onChange={(event) => setDraft(event.target.value)} style={{ height: 110 }} />
          <footer style={{ padding: "8px 12px", fontSize: 11 }}>codex · 运行中，发送即排队</footer>
        </div>
      </div>
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
