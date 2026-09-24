// 对外批量建任务 API 的载荷形状(agent 面,§ interfaces)。纯类型模块 —— 从 index.ts
// 拆出来只是为了不让那个文件继续长,消费方仍从 "@ash/shared" 导入,路径不变。
import type { AgentType } from "./index.ts";
import type { TaskWorkflowMode } from "./free-workflow.ts";

// One call to create a whole batch of single-mode tasks into an EXISTING group,
// wiring cross-task dependency edges that the in-group scheduler honors. The
// chain case ("A 做完再做 B …") is the headline; arbitrary in-batch DAGs are
// expressible via per-task `key` + `dependsOn`. projectId is inherited from the
// group, so the caller never repeats it.
export interface BatchTaskInput {
  // Local id used ONLY to reference this task from a sibling's dependsOn within
  // the same batch (ids don't exist yet at call time). Not persisted.
  key?: string;
  title?: string; // omitted → derived from body's first line, and autoTitle'd
  body?: string; // the prompt / objective
  agentType?: AgentType; // overrides defaults.agentType
  executorId?: string | null; // overrides defaults.executorId; stale id degrades by agentType
  model?: string | null; // overrides defaults.model; null follows the resolved executor profile
  reasoningEffort?: string | null; // overrides defaults.reasoningEffort
  useWorktree?: boolean; // overrides defaults.useWorktree; omitted follows the global setting
  worktreeBase?: string | null; // base ref when this task uses a worktree
  mergeTargetBranch?: string | null;
  workflowId?: string | null; // 起手式 id；省略则按项目→全局默认解析，并拷成快照
  // 走哪种工作方式。省略 = 按「配不配」推导（`freeWorkflowFits`）：这一批都是普通单任务，
  // 所以只要没给 workflowId 就是 free。给了 workflowId 还写 free 会被整批打回——
  // 自由工作流没有起手式这个概念。
  workflowMode?: TaskWorkflowMode;
  labels?: string[];
  // Each entry is resolved against sibling `key`s first; anything that doesn't
  // match a sibling key is treated as an existing task id and passed through.
  dependsOn?: string[];
  // Same resolution as dependsOn, but checked only when resuming a paused task.
  resumeDependsOn?: string[];
}

export interface BatchCreateTasksBody {
  tasks: BatchTaskInput[];
  chain?: boolean; // true → append the previous task's id to each task's deps (A→B→C→D)
  run?: boolean; // true → kick off the group (runGroup) right after creating
  defaults?: {
    // applied to every task unless that task overrides the field
    agentType?: AgentType;
    executorId?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    useWorktree?: boolean; // omitted follows the project's useWorktreeDefault
    workflowId?: string | null; // 这一批默认走哪条起手式
    workflowMode?: TaskWorkflowMode; // 这一批默认的工作方式；任务自身可覆盖
    worktreeBase?: string | null;
    mergeTargetBranch?: string | null;
    labels?: string[];
  };
}
