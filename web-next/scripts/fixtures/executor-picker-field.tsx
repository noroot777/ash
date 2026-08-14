// 「选执行器 → 选模型」之后智能体不许被打回原样的回归夹具。
//
// 用的是最朴素的消费方写法：一份 draft 存在 state 里，回调从 props 上的 draft 展开。
// ExecutorPickerField 只要把一次选择拆成两个回调，后一个就会带着旧 draft 把刚选的
// 执行器盖回去——现象正是「选了 grok，模型变成 grok-4.5，智能体却弹回 codex」。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import {
  createReviewerDraft,
  ReviewerProfileFields,
  type ReviewerDraft,
} from "../../src/free-workflow/ReviewerProfileFields.tsx";
import "../../src/styles/global.css";

const TYPES: AgentType[] = ["codex", "grok"];

const PROFILES: AgentExecutorProfile[] = [
  {
    id: "codex-local",
    name: "codex@local",
    type: "codex",
    target: { kind: "local" },
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    isDefault: true,
  },
  {
    id: "grok-local",
    name: "grok@local",
    type: "grok",
    target: { kind: "local" },
    model: null,
    reasoningEffort: null,
    isDefault: false,
  },
];

function Fixture() {
  const [draft, setDraft] = useState<ReviewerDraft>(() => createReviewerDraft(PROFILES));
  return (
    <main style={{ width: 640, padding: 60 }}>
      <ReviewerProfileFields draft={draft} profiles={PROFILES} types={TYPES} onChange={setDraft} />
      <pre data-testid="draft">{JSON.stringify(draft)}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
