// 「加了供应商但没有执行器挂它」时,它不许出现在选模型那一步的回归夹具。
//
// 两家供应商都是 anthropic 协议、都能挂给 claude,区别只在有没有执行器挂上去:
// 挂上的那家必须可选,没人挂的那家必须一个候选都不给 —— 因为一次选择只能落
// 「智能体 + 执行器 + 模型」,供应商没有通道,列出来点中等于拿这家的模型名去
// 该类型默认执行器(官方账号)的端点上撞,任务起来就死。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentExecutorProfile, AgentType } from "@ash/shared";
import { RunTargetPicker } from "../../src/components/RunTargetPicker.tsx";
import type { AgentModelSelection } from "../../src/task-detail/mentionPicker.ts";
import "../../src/styles/global.css";

const TYPES: AgentType[] = ["claude"];

const PROFILES: AgentExecutorProfile[] = [
  {
    id: "claude-cli",
    name: "claude@官方",
    type: "claude",
    providerId: null,
    model: undefined,
    isDefault: true,
  },
  {
    id: "claude-relay",
    name: "claude@已挂中转",
    type: "claude",
    providerId: "p-mounted",
    model: "relay-opus",
    isDefault: false,
  },
];

function Fixture() {
  const [selection, setSelection] = useState<{ agentType: AgentType; executorId: string | null }>({
    agentType: "claude",
    executorId: "claude-cli",
  });
  const [model, setModel] = useState<string | null>(null);

  const commit = (next: AgentModelSelection) => {
    setSelection({ agentType: next.agent, executorId: next.executorId });
    setModel(next.model);
  };

  return (
    <main style={{ width: 560, padding: 80 }}>
      <RunTargetPicker
        label="测试执行目标"
        types={TYPES}
        profiles={PROFILES}
        selection={selection}
        model={model}
        effort=""
        onCommit={commit}
      />
      <pre data-testid="draft">{JSON.stringify({ executorId: selection.executorId, model })}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
