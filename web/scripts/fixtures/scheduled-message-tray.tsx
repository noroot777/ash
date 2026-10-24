import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ScheduledMessage } from "@ash/shared";
import { ScheduledMessageTray, useScheduledMessages } from "../../src/components/ScheduledMessages.tsx";
import { joinDraftText } from "../../src/task-detail/withdrawDraft.ts";
import "../../src/styles/global.css";

function Fixture() {
  const [taskId, setTaskId] = useState("task-a");
  const [team, setTeam] = useState(false);
  const [draft, setDraft] = useState("未发送的草稿");
  const scheduled = useScheduledMessages(taskId);
  const withdraw = async (message: ScheduledMessage) => {
    if (!await scheduled.cancel(message.id)) return;
    setDraft((current) => joinDraftText(message.text, current));
  };
  return <>
    <nav style={{ height: 48, display: "flex", gap: 12, alignItems: "center", padding: "0 12px" }}>
      <button onClick={() => void scheduled.reload({ quiet: true })}>重新载入</button>
      <button onClick={() => setTaskId((current) => current === "task-a" ? "task-b" : "task-a")}>切换任务</button>
      <button onClick={() => setTeam((current) => !current)}>切换团队</button>
    </nav>
    <main className={team ? "team-flow-main" : "task-detail-main"} style={{ height: "calc(100dvh - 48px)", maxWidth: 1000, margin: "0 auto" }}>
      <div className="conversation-scroll-region"><section className={team ? "team-feed" : "task-conversation"}>
        <h1 style={{ fontSize: 18 }}>排队输入 · {team ? "团队" : "普通任务"}</h1>
        <p>当前回合继续运行，排队输入在同一张卡片内向上展开。</p>
        <button type="button">会话区域按钮</button>
      </section></div>
      <div className={team ? "team-reply-shell" : "task-reply-shell"}>
        <ScheduledMessageTray key={taskId} messages={scheduled.messages} loading={scheduled.loading} error={scheduled.error}
          cancelingIds={scheduled.cancelingIds} steeringIds={scheduled.steeringIds}
          onSteer={team ? undefined : (messageId) => void scheduled.steer(messageId)}
          onWithdraw={(message) => void withdraw(message)} onCancel={(messageId) => void scheduled.cancel(messageId)} />
        <div className={team ? "team-reply-box" : "task-reply-box"}>
          <textarea aria-label="回复草稿" value={draft} onChange={(event) => setDraft(event.target.value)} style={{ height: 110, minHeight: 110 }} />
          <footer style={{ padding: "8px 12px", fontSize: 11 }}>codex · 运行中，发送即排队</footer>
        </div>
      </div>
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
