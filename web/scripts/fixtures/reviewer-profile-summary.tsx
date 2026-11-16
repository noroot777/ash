import { createRoot } from "react-dom/client";
import type { AgentExecutorProfile, ReviewerProfile } from "@ash/shared";
import { ReviewerProfileSummary } from "../../src/free-workflow/ReviewerProfileFields.tsx";
import "../../src/styles/global.css";

const profiles: AgentExecutorProfile[] = [{
  id: "codex-local",
  name: "codex@local",
  type: "codex",
  target: { kind: "local" },
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
  isDefault: true,
}];

const reviewer: ReviewerProfile = {
  id: "reviewer-1",
  name: "5.5审查",
  agentType: "codex",
  executorId: null,
  executorLabel: null,
  model: null,
  reasoningEffort: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

// 外壳照设置页「审查者」那一行（settings/ReviewerProfilesSettings.tsx）：这份摘要现在只在那里画。
function Fixture() {
  return (
    <main style={{ width: 720, margin: "40px auto" }}>
      <div className="settings-row settings-item" style={{ width: 470 }}>
        <div>
          <b>{reviewer.name}</b>
          <ReviewerProfileSummary reviewer={reviewer} profiles={profiles} />
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
