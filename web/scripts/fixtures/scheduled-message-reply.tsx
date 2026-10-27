import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { DraftProvider, useTaskReplyDraft } from "../../src/lib/DraftStore.tsx";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { TeamReplyBox } from "../../src/team/TeamView.tsx";
import { attachmentsFromPaths } from "../../src/task-detail/withdrawDraft.ts";
import "../../src/styles/global.css";

const team = new URLSearchParams(location.search).get("variant") === "team";
const task: Task = {
  id: "task-a", projectId: "project-1", groupId: null, parentId: null, title: "排队回复布局", body: "", mode: team ? "team" : "single",
  status: "running", labels: [], dependsOn: [], resumeDependsOn: [], agentType: "codex",
  createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
};

function Fixture() {
  const draft = useTaskReplyDraft(task.id);
  return <>
    <header style={{ height: 48, display: "flex", alignItems: "center", gap: 12, padding: "0 12px" }}>
      <span>真实{team ? "团队" : "普通"}回复框</span>
      <button onClick={() => draft.setAttachments(attachmentsFromPaths(Array.from({ length: 12 }, (_, index) => `/tmp/review-${index}.txt`)))}>加入附件</button>
    </header>
    <div className="task-detail-body" style={{ height: "calc(100dvh - 48px)" }}>
      <section className={team ? "team-flow-main" : "task-detail-main"}>
        <div className="conversation-scroll-region"><section className={team ? "team-feed" : "task-conversation"}>会话内容</section></div>
        {team ? <TeamReplyBox task={task} onSend={async () => null} />
          : <ReplyBox task={task} hasConversation onSend={async () => null}
            topRail={<div className="task-reply-rail"><button className="task-reply-rail-button">打开预览</button><button className="task-reply-rail-button">接力到…</button></div>} />}
      </section>
    </div>
  </>;
}

createRoot(document.getElementById("root")!).render(<DraftProvider><Fixture /></DraftProvider>);
