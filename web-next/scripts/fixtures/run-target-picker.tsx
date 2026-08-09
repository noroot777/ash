import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentType } from "@harness/shared";
import { RunTargetPicker } from "../../src/components/RunTargetPicker.tsx";
import type { AgentModelSelection } from "../../src/task-detail/mentionPicker.ts";
import "../../src/styles/global.css";

const TYPES: AgentType[] = ["claude", "codex"];

function Harness() {
  const [selection, setSelection] = useState<{ agentType: AgentType; executorId: string | null }>({
    agentType: "claude",
    executorId: null,
  });
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState("");

  const commit = (next: AgentModelSelection) => {
    const changed = next.agent !== selection.agentType || next.executorId !== selection.executorId;
    setSelection({ agentType: next.agent, executorId: next.executorId });
    if (changed) {
      setModel(next.model);
      setEffort("");
    } else if (next.model !== null) {
      setModel(next.model);
    }
  };

  return (
    <main style={{ width: 520, padding: 80 }}>
      <RunTargetPicker
        label="测试执行目标"
        types={TYPES}
        profiles={[]}
        selection={selection}
        model={model}
        effort={effort}
        onCommit={commit}
        onEffortChange={setEffort}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
