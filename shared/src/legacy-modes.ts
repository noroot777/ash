// 团队、讨论这两种老模式的开关。
//
// 用户 2026-11-15 定了只留一种任务（团队 = 派出去的任务，讨论 = 回复框里 @ 人），界面入口已经关掉
// （7yNMMx4ZPr1_）；2026-11-19 又要求：代码留着，但对智能体也「隐形」—— 它们看不到派执行者的工具、
// 工具说明里不提团队，服务端也建不出新的团队任务、讨论任务和团队执行者。
//
// 关着时（默认）：
//  · MCP 不注册 `dispatch`，各工具说明里讲团队调度台 / 执行者的那几句不出现（mcp/src/tools/*）；
//  · 新建团队 / 讨论任务、建团队执行者、把任务改成这两种模式、调度台派活，服务端一律拒（`legacyModeRefusal`）；
//  · 手机端新建页的「任务模式」那一格不出现；
//  · 已有的团队任务、讨论任务照旧能打开、能看、能验收，它们自己的那套代码一行没删。
//
// 想让它们回来：起 Navi 时带上 `NAVI_LEGACY_TEAM_AND_DUET=1`。智能体和它的 MCP 进程从 Navi 继承环境，
// 一个变量管全部。验收门禁也是带着它跑的（scripts/accept-test.mjs）：留着的代码要一直是能用的，
// 不然这个开关就成了摆设。
//
// 每次调用时现读：测试在同一个进程里开关它，不用重新加载模块。
import { readEnv } from "./env-names.ts";

// 浏览器和手机端没有 process（shared 也不带 node 类型），那两边恒为关着。
type Host = { process?: { env?: Readonly<Record<string, string | undefined>> } };

export function legacyTeamAndDuet(): boolean {
  const env = (globalThis as Host).process?.env;
  return !!env && readEnv(env, "NAVI_LEGACY_TEAM_AND_DUET") === "1";
}

/** 关着时 MCP 不注册的工具。回合起跑后核对「navi 的工具一样不少」时，它们不算缺。 */
export const LEGACY_ONLY_MCP_TOOLS: readonly string[] = ["dispatch"];

/** 只在开着时才说的那半句（工具说明里讲团队的那几句）。 */
export function whenLegacy(text: string): string {
  return legacyTeamAndDuet() ? text : "";
}

/** 这次创建 / 修改会不会造出新的团队、讨论任务或团队执行者。关着时回拒绝的原因，否则 null。 */
export function legacyModeRefusal(shape: { mode?: string | null; parentId?: string | null }): string | null {
  if (legacyTeamAndDuet()) return null;
  if (shape.mode === "team" || shape.mode === "duet") {
    return "团队任务、讨论任务已经停用：只有一种任务，要派活用 batch_create_tasks / create_task_chain，要讨论在回复框里 @ 人";
  }
  if (shape.parentId) return "团队执行者已经停用：要派活用 batch_create_tasks / create_task_chain 建普通任务";
  return null;
}
