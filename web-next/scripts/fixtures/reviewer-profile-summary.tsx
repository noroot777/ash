import { createRoot } from "react-dom/client";
import type { AgentExecutorProfile, ReviewerProfile } from "@harness/shared";
import { ReviewerProfileSummary } from "../../src/free-workflow/ReviewerProfileFields.tsx";
import { CheckCircle } from "@phosphor-icons/react";
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

function Fixture() {
  return (
    <main style={{ width: 720, margin: "40px auto" }}>
      <div className="free-review-reviewer-list" style={{ width: 470 }}>
        <button type="button" aria-selected="true">
          <span><b>{reviewer.name}</b><ReviewerProfileSummary reviewer={reviewer} profiles={profiles} /></span>
          <CheckCircle size={16} weight="fill" />
        </button>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
