import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { makeStep, type WorkflowDef } from "@ash/shared/workflow";
import { ForcePassVerifyButton } from "../../src/workflow/VerifyGateControls.tsx";
import { TEAM_INSPECTORS, type TeamInspectorContext } from "../../src/team/TeamInspector.tsx";
import "../../src/styles/global.css";

const def: WorkflowDef = { workspace: "isolated", steps: [makeStep("verify", "verify"), makeStep("accept", "accept")] };
const seed = {
  id: "frozen-task", title: "自动基准任务", body: "", mode: "team", status: "done", useWorktree: true,
  worktreeBase: null, worktreeStartCommit: "frozen-start", mergeTargetBranch: "version-upgrade", acceptedTargetBranch: null,
  team: { lead: "claude", worker: "codex" }, createdAt: "2026-10-20T00:00:00.000Z",
} as Task;
const info = TEAM_INSPECTORS.find((descriptor) => descriptor.id === "info")!;

function Fixture() {
  const [task, setTask] = useState(seed);
  return <main style={{ padding: 24 }}>
    <p>项目当前分支：main（任务创建后已切换）</p>
    <button onClick={() => setTask(seed)}>自动基准</button>
    <button onClick={() => setTask({ ...seed, worktreeBase: "legacy-base" })}>冻结优先</button>
    <button onClick={() => setTask({ ...seed, mergeTargetBranch: null, worktreeBase: "legacy-base" })}>旧任务基准</button>
    <button onClick={() => setTask({ ...seed, mergeTargetBranch: null })}>未记录目标</button>
    <ForcePassVerifyButton task={task} def={def} stationId="verify" onTaskUpdated={() => {}} notify={() => {}} />
    {info.render({ task, workers: [], sessions: [] } as unknown as TeamInspectorContext)}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
