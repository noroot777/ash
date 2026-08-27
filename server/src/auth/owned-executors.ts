// 「谁的执行器」的单点(§八)。执行器 profile 是**个人面**资源,列表少给几行只是第一层,
// 真正要贯彻到的是另外两侧:
//  · 写侧 —— 别人的 executorId 不能被存进我的任务 / 团队预设 / 审查者配置 / 审查预约;
//  · 读侧 —— executorLabel 不能从别人的默认执行器回退出一个名字。
// (第 2 轮审查 P1:Alice 的 `GET /agents` 是空的,却能拿 Bob 的 id 建出一条 executorLabel
//  写着「Bob Secret Executor」的任务;连 `executorId:null` 的默认回退都会回退到 Bob 头上。)
//
// 判据一句话:**看不见的执行器 = 对这个人来说不存在**。于是每个调用点沿用它自己原本对
// 「不存在」的处置,不必再发明一套跨用户措辞 —— 也正因为如此,「不是我的」和「根本没有」
// 对外必须长得一模一样(理由同 owned.ts 的 `notYours`:能区分就能拿 id 挨个问出来):
//   · 审查者配置 / free-review 覆盖:本来就报「所选执行器不存在」,照报;
//   · 建任务 / 批量建任务 / 团队预设:本来对悬空 id 是「按类型默认执行器降级」(MCP 工具
//     说明里写死的语义),那就把看不见的 id 归一成 null —— 别把外人的 id 落库,那正是审查
//     报告说的行为分裂:库里写着 Bob,真跑起来 orchestrator 按 Alice 降级。
//
// 自用模式下 `ownedScope` 是 null,这里每个函数都退化成恒等变换(悬空 id 照旧原样落库),
// 与本功能上线前逐字节一致。
//
// **挑哪个 scope:锚在「这份记录最终的归属人」,不是「这次点它的人」。** 两者常常同一个人,
// 但不总是 —— 第 4 轮审查 P1 就出在这条缝上:带 parentId 建子任务时归属继承父任务,共享
// 项目里别人也能 PATCH 我的任务,而运行侧一律按归属人解析。按操作人过滤 = 存进去一个
// 运行时永远解析不到的 id,库里写的和真跑的分家。对照表:
//   · 任务(executorId / duet 两位讨论者 / team 三角色)→ `executorScopeForOwner(taskOwner)`
//   · 团队派活的执行者任务 → `executorScopeForOwner(lead.ownerUserId)`
//   · 执行器 / 审查者 / 团队预设本身 → `executorScope(actor)`;这几张表的 ownerUserId
//     就是 `ownerStamp(actor)` 盖的,归属人**就是**操作人,两条路同一个答案。
import type { AgentType } from "@ash/shared";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import type { Actor } from "./context.js";
import { isMultiUser } from "./mode.js";
import { filterOwned, ownedScope, type Owned } from "./owned.js";

/** label 解析需要的最小列集(名字 + 类型 + 是不是该类型的默认)。 */
export type ExecutorProfileRow = {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  ownerUserId: string | null;
};

export interface ExecutorScope {
  /** 这个人看得见的 profile。 */
  readonly rows: ExecutorProfileRow[];
  /** 看得见的 id → 类型;看不见的不在表里(与「不存在」同一个结果)。 */
  typeOf(executorId: string | null | undefined): AgentType | undefined;
  /** 看得见就原样返回,看不见归一成 null。自用模式恒等。 */
  keep(executorId: string | null | undefined): string | null;
}

async function allProfiles(): Promise<ExecutorProfileRow[]> {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      isDefault: agents.isDefault,
      ownerUserId: agents.ownerUserId,
    })
    .from(agents);
}

function buildScope(rows: ExecutorProfileRow[], limited: boolean): ExecutorScope {
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  return {
    rows,
    typeOf: (executorId) => (executorId ? (byId.get(executorId)?.type as AgentType | undefined) : undefined),
    keep: (executorId) => {
      if (!executorId) return null;
      return limited && !byId.has(executorId) ? null : executorId;
    },
  };
}

/**
 * 一次请求取一次:一条创建路径上要判四个 executorId(任务 + 团队三角色)。
 *
 * `actor` 传 `null` = **没有 HTTP 身份可用**、且此刻也不该有(结算内部重放一份早已校验
 * 过的预约槽配置)。写成显式的 null 而不是省略参数,是为了让「这里为什么不设限」在调用
 * 点上看得见 —— 省略参数的重载迟早会被顺手当默认值用。
 */
export async function executorScope(actor: Actor | null): Promise<ExecutorScope> {
  const all = await allProfiles();
  const limited = actor !== null && (await ownedScope(actor)) !== null;
  return buildScope(actor === null ? all : await filterOwned(all, actor), limited);
}

/**
 * 按**「谁的活」**建 scope:调用方不是人而是 agent(团队派活的 lead、派生链路),此刻没有
 * HTTP actor,但有一个明确的归属人 —— 派出去的活按 §八 用的就是那个人的执行器与 key。
 *
 * 与 `executorScope(actor)` 的差别只在选谁:那条按操作人,这条按归属人。管理员在这里
 * **不额外看见**无主行 —— 「以谁的名义跑」跟「谁在管实例」是两回事。
 */
export async function executorScopeForOwner(ownerUserId: string | null): Promise<ExecutorScope> {
  const all = await allProfiles();
  if (!(await isMultiUser())) return buildScope(all, false);
  return buildScope(profilesOwnedBy(all, ownerUserId), true);
}

/**
 * 读侧的 owner scope:一份资源的 executorLabel 只能在**这份资源归属人**自己的执行器里
 * 解析,而不是看客的。
 *
 * 为什么锚在归属人而不是看客:共享项目里 Bob 的任务确实跑在 Bob 的执行器上,按看客
 * (Alice)的集合回退会在界面上写出「这条任务用 Alice 的默认执行器」—— 那不是隐藏,是
 * 编造。锚在归属人则两件事同时成立:Alice 建的任务永远回退到 Alice 自己的默认(审查报告
 * 里那条 `executorId:null` 泄露就此消失),Bob 的任务照实显示。
 *
 * 另外这条筛子还兼任「发事件时用哪套 profile」:`enrichTasks` 的结果会经 SSE 广播,那里
 * 根本没有看客身份可用,锚在归属人是唯一算得出来的口径。
 *
 * 自用模式下两侧都是 null,筛子是恒等的。
 */
export const profilesOwnedBy = <T extends Owned>(rows: T[], ownerUserId: string | null): T[] =>
  rows.filter((row) => row.ownerUserId === ownerUserId);
