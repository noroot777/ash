import type { AgentExecutorProfile } from "@harness/shared";
import { TEAM_DEFAULTS } from "@harness/shared";
import type { ExecutorSelection } from "./ExecutorPicker";
import {
  availableTypes,
  fallbackExecutor,
  isExecutorPickable,
  residentTypes,
  type DetectedAgent,
} from "./useDetectedAgents";

export type { DetectedAgent } from "./useDetectedAgents";

// Shared by TaskComposer's /team mode and debate handoff. A lead must support a
// resident session; the default worker deliberately prefers another available
// type so the team starts with a second perspective.
//
// 「能不能常驻」和「本机装没装」是两个独立条件，**不能合并**（2026-07-30 第二轮审查抓到）：
// - 「按类型新选」调度者要两个都满足：`residentTypes ∩ availableTypes`；
// - 但**已注册的 profile 只按 resident 筛**，不再要求本机 available —— 它可能是 ssh 远端
//   （本机自然探不到），而用户显式注册过的东西不该被检测结果吞掉。合并这两个条件会让
//   「本机没装 claude、靠 ssh 跑 claude 调度台」的用户根本建不了团队。
export function teamExecutorDefaults(
  detected: DetectedAgent[] | null,
  leadPick: ExecutorSelection | null,
  workerPick: ExecutorSelection | null,
  profiles: AgentExecutorProfile[] = [],
) {
  const resident = residentTypes(detected);
  const available = availableTypes(detected);
  const leadTypes = resident.filter((type) => available.includes(type));
  const leadProfiles = profiles.filter((profile) => resident.includes(profile.type));
  const workerTypes = available;
  // 缺省调度者:能直接按类型新选就按类型(第一个 available 且能常驻的),否则退到已注册的
  // 远端调度者 profile,两者都没有才落在 TEAM_DEFAULTS.lead 上 —— 那种情况下建单表面会
  // 明示「本机没检测到」,严重时(连 profile 都没有)直接拦提交。
  const leadFallback = fallbackExecutor(leadTypes, leadProfiles)
    ?? { agentType: TEAM_DEFAULTS.lead, executorId: null };
  const leadSelection = leadPick && isExecutorPickable(leadPick, leadTypes, leadProfiles)
    ? leadPick
    : leadFallback;
  // 缺省执行者:优先另一个 available 类型(两个视角),没有第二个就用任一 available,
  // 一个 available 都没有时退到已注册 profile,最后才与调度者同款。
  const workerSelection = workerPick && isExecutorPickable(workerPick, workerTypes, profiles)
    ? workerPick
    : fallbackExecutor(workerTypes, profiles, leadSelection.agentType)
      ?? { agentType: leadSelection.agentType, executorId: leadSelection.executorId };
  return { leadTypes, leadProfiles, workerTypes, leadSelection, workerSelection };
}
