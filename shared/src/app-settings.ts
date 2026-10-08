import type { HandoffTarget } from "./handoff.ts";
import type { AcceptClean } from "./workflow.ts";

export interface AppSettings {
  defaultWorkflowId: string;
  skillRefreshSeconds: number;
  claudeModelRefreshHours: number;
  claudeCustomModelIds: string[];
  handoffTargets: HandoffTarget[];
  handoffRequireApproval: boolean;
  handoffEncrypt: boolean;
  handoffMaxBodyMb: number;
  // 归档时连 worktree/分支一起收到什么程度（用户 2026-10-08 要求「归档也删」）。
  // 复用验收清理那三档语义与标签：all=删 worktree 和任务分支、worktree=只删
  // worktree、none=都留着（上线前的旧行为）。两处都只用 `-d`/不带 `--force`，
  // 所以「删」的实际效果受 git 自己的安全检查节制，见 task-archive-cleanup.ts。
  archiveClean: AcceptClean;
  instanceMode: "" | "single" | "multi";
  rootDir: string;
  sharedHostCli: boolean;
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  defaultWorkflowId: "",
  skillRefreshSeconds: 3600,
  claudeModelRefreshHours: 6,
  claudeCustomModelIds: [],
  handoffTargets: [],
  handoffRequireApproval: true,
  handoffEncrypt: true,
  handoffMaxBodyMb: 512,
  archiveClean: "all",
  instanceMode: "",
  rootDir: "",
  sharedHostCli: false,
});
