// 接力的**能力握手**:打包之前先问一句「对端跑不跑得动这个任务」。
//
// 为什么需要它:接力搬走的是任务连同它选中的智能体和模型,可**执行器是机器本地的事实**
// (装没装那个 CLI、那个 model id 在这台机器上认不认)。这一层原先完全没有校验 ——
// `handoff-import.ts` 把 `task.agentType` 原样落库、`executorId` 置 null 交给对端按类型
// 降级,于是两种坏事都只可能在**任务已经不在本机之后**才暴露:
//   ① 对端没装那个 CLI  → 一起跑就是 ENOENT,结算成 failed,得有人去翻日志才知道原因;
//   ② 对端 CLI 在、模型不在 → 更坏,有的 CLI/网关会**静默降级**到默认模型,回合照常
//      exit 0 跑完,从 ash 这一层完全看不出跑的已经不是你选的那个模型了。
//
// 握手把这两件事提到打包之前,判据与 `handoff-peer-client.ts` 的身份核对同档:**能在
// 打包前拦下的就别等推出去**。
//
// ── 诚实边界(照 CliModelCatalog 的规矩) ──────────────────────────────────
// 「报不出」和「报出来是空的」必须分开,否则握手自己会变成假警报的来源:
//   · 对端是**旧版**(不带 capabilities)→ status=unknown,如实说无从核对,**不拦**。
//     跟对端不报身份时的处理同哲学:升级路径不能被新功能一刀切断。
//   · 对端**故意没探**(多人模式不碰宿主机 CLI,见 model-probe.ts §八)→ 模型清单只是
//     内置兜底,拿它否定一个模型就是假警报,所以模型落差整档降级成提示。
//   · 模型清单 `source==="preset"` 同理:那是发版时抄下的快照,各家上新跟 ash 发版无关,
//     它**不权威**。只有 `source==="probe"`(现问 CLI 的实时目录)才有资格说「没这个模型」。
// 只有「对端明确报了它没装这个 CLI」才是硬结论 —— 那一档才拦。
import { and, eq } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import type {
  HandoffCapabilityGap, HandoffCapabilityReport, HandoffCapabilitySlot,
  HandoffPeerAgentCapability, HandoffPeerCapabilities,
} from "@ash/shared";
import { MULTI_USER_HOST_CLI_MODELS_HIDDEN } from "@ash/shared/multiuser";
import { CLI_MODEL_PRESETS } from "@ash/shared/cli-presets";
import { db } from "./db/index.js";
import { agents, freeWorkflowStates, scheduledMessages, sessions, tasks } from "./db/schema.js";
import { probeBins } from "./executors/bin-probe.js";
import { CLI_SPEC_BY_KEY } from "./executors/catalog/index.js";
import { isHostCliIsolated } from "./auth/mode.js";

// ── 本机上报(对端侧执行) ───────────────────────────────────────────────────

/**
 * 能力清单的缓存。ping 是**探活**,必须快且可预测:它在源机那边只有 15s 超时,而
 * 逐个 CLI 跑 `--version` 是十几个子进程。装没装 CLI 这件事在一个 server 进程的
 * 生命周期里几乎不变,60s 的保鲜期足够让「刚装上就重试一次」看到新结果。
 *
 * **刻意不问模型清单**(`modelCatalogFor`):那条路缓存未命中时会**等**一次真实探测
 * (最长 10s/个),放进 ping 就是拿探活的确定性换一份清单。模型在握手里只用于提示档
 * 判断,内置快照够用,而 `modelSource` 字段会如实说明它只是兜底 —— 拿兜底冒充实时
 * 目录才是不能接受的那一档。
 */
const CAPS_TTL_MS = 60_000;
let capsCache: { at: number; value: HandoffPeerCapabilities } | null = null;

/** 一种 CLI 装没装。判定走 probeBins —— 与真正派任务时同一套(候选顺序、备用名自证)。 */
async function availabilityOf(type: AgentType): Promise<boolean> {
  const spec = CLI_SPEC_BY_KEY[type];
  if (!spec) return false;
  return !!(await probeBins(spec.bins, spec.fallbackVersionMatch));
}

/**
 * 本机能力,供 ping 应答自报。
 *
 * profile 数只作参考:一个类型下没有任何 profile 仍然跑得动(`resolveExecutor` 退到
 * 内置本地默认),所以它进不了落差判定,只在界面上说明「那边没人配过这个执行器」。
 */
export async function localCapabilities(): Promise<HandoffPeerCapabilities> {
  if (capsCache && Date.now() - capsCache.at < CAPS_TTL_MS) return capsCache.value;
  const isolated = await isHostCliIsolated();
  const rows = await db.select({ type: agents.type }).from(agents);
  const profileCount = new Map<string, number>();
  for (const row of rows) profileCount.set(row.type, (profileCount.get(row.type) ?? 0) + 1);
  const agentCaps = await Promise.all(AGENT_TYPES.map(async (type): Promise<HandoffPeerAgentCapability> => ({
    type,
    available: await availabilityOf(type),
    profiles: profileCount.get(type) ?? 0,
    models: [...CLI_MODEL_PRESETS[type]],
    // 见上:ping 里不起模型探测,所以这里永远是兜底快照,如实标 preset。
    modelSource: "preset",
  })));
  const value: HandoffPeerCapabilities = {
    agents: agentCaps,
    // 隔离档下连「装没装」都不该拿宿主机的事实回答(§八):那时执行器必须挂自己的
    // 供应商才跑得起来,宿主装了什么与能不能跑无关。如实说明,让源机整档降级成提示。
    skipped: isolated ? MULTI_USER_HOST_CLI_MODELS_HIDDEN : null,
  };
  capsCache = { at: Date.now(), value };
  return value;
}

/** 只给测试用:清掉能力缓存。 */
export function resetCapabilityCache(): void {
  capsCache = null;
}

// ── 出站比对(源机侧执行) ───────────────────────────────────────────────────

/** 任务身上一处「要用某个智能体/模型」的需求。 */
interface Need {
  slot: HandoffCapabilitySlot;
  agentType: string;
  model: string | null;
  /** 给人看的来源说明,拼进 detail。 */
  where: string;
}

/**
 * 盘点这个任务落到对端之后**会真的拿去起回合**的执行器需求。
 *
 * 四个槽位都是「对端会自己跑起来」的路径,不是历史记录:
 *   · task    —— 任务主执行器,续跑/回复/重跑都用它(`tasks.agent_type`);
 *   · session —— 带 CLI 会话文件的会话,`--resume` 必须由**同一种** CLI 接手;
 *   · message —— 随任务迁移的待发送消息,到期由对端投递并起回合;
 *   · review  —— 自由工作流预约的审查,导入后由对端派审。
 * 历史上跑过、现在不会再跑的会话不进来 —— 那只会制造一堆没人需要的假落差。
 */
async function needsOf(taskId: string): Promise<Need[]> {
  const needs: Need[] = [];
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return needs;
  const mainType = task.agentType ?? "claude";
  needs.push({ slot: "task", agentType: mainType, model: task.model, where: "任务当前的执行器" });

  // 只认「有会话文件可续」的:cliSessionId 为空的会话在对端本来就是全新起跑。
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  const resumable = new Map<string, string | null>();
  for (const row of rows) {
    if (!row.cliSessionId || row.agentType === mainType) continue;
    if (!resumable.has(row.agentType)) resumable.set(row.agentType, row.turnModel);
  }
  for (const [agentType, model] of resumable) {
    needs.push({ slot: "session", agentType, model, where: "有会话历史要在对端续上" });
  }

  const msgs = await db.select().from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending")));
  const seenMsg = new Set<string>();
  for (const msg of msgs) {
    const agentType = msg.agent ?? mainType;
    const key = `${agentType} ${msg.model ?? ""}`;
    if (seenMsg.has(key)) continue;
    seenMsg.add(key);
    needs.push({ slot: "message", agentType, model: msg.model, where: "待发送消息指定的执行器" });
  }

  // 预约审查:导入后由对端起审查回合。没预约(或没做执行器覆盖)就没有这个需求 ——
  // reviewAgentType 为空表示照审查者自己的配置跑,那是对端本地的 profile,不是本机能盘的。
  const state = (await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, taskId))).at(0);
  if (state?.reviewArmed && state.reviewAgentType) {
    needs.push({
      slot: "review",
      agentType: state.reviewAgentType,
      model: state.reviewModel ?? null,
      where: "已预约的审查",
    });
  }
  return needs;
}

const SLOT_LABEL: Record<HandoffCapabilitySlot, string> = {
  task: "任务执行器",
  session: "会话续跑",
  message: "待发送消息",
  review: "预约审查",
};

/**
 * 比对需求与对端能力,产出握手结论。
 *
 * `peerCaps` 为空 = 对端旧版,报不出能力 → unknown,**不拦**(见文件头「诚实边界」)。
 */
export function compareCapabilities(
  needs: Need[],
  peerCaps: HandoffPeerCapabilities | null | undefined,
): HandoffCapabilityReport {
  if (!peerCaps) {
    return {
      status: "unknown",
      unknownReason: "目标机版本过旧,报不出它装了哪些智能体 —— 这次接力无法预先确认那边跑不跑得动。",
      gaps: [],
      blocking: false,
    };
  }
  const byType = new Map(peerCaps.agents.map((a) => [a.type as string, a]));
  const gaps: HandoffCapabilityGap[] = [];
  const seen = new Set<string>();
  for (const need of needs) {
    const key = `${need.slot} ${need.agentType} ${need.model ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cap = byType.get(need.agentType);
    const label = SLOT_LABEL[need.slot];
    // 对端认都不认识这个类型 = 它比本机还老(本机有、它没登记)。按缺失报,但话说清楚。
    if (!cap) {
      gaps.push({
        slot: need.slot, kind: "agent-missing", agentType: need.agentType, model: need.model,
        detail: `${label}用的是「${need.agentType}」(${need.where}),目标机的版本里没有这个智能体类型。`,
      });
      continue;
    }
    // 隔离档下对端连「装没装」都不代表能不能跑(执行器挂自己的供应商),整档降级成提示。
    if (!cap.available && !peerCaps.skipped) {
      gaps.push({
        slot: need.slot, kind: "agent-missing", agentType: need.agentType, model: need.model,
        detail: `${label}用的是「${need.agentType}」(${need.where}),目标机没有装它 —— 到那边一起跑就是 ENOENT。`,
      });
      continue;
    }
    // 模型:只有实时目录才有资格否定一个模型。preset 是发版时的快照、skipped 是压根没探,
    // 拿它们报「没这个模型」就是假警报(各家上新模型跟 ash 发版毫无关系)。
    if (!need.model || cap.modelSource !== "probe" || peerCaps.skipped) continue;
    if (cap.models.includes(need.model)) continue;
    gaps.push({
      slot: need.slot, kind: "model-missing", agentType: need.agentType, model: need.model,
      detail: `${label}指定了模型「${need.model}」(${need.where}),它不在目标机 ${need.agentType} 的模型清单里`
        + " —— 那边可能直接报错,也可能静默换成默认模型跑完(那样从任务状态上看不出来)。",
    });
  }
  const blocking = gaps.some((g) => g.kind === "agent-missing");
  return {
    status: gaps.length ? "gaps" : "ok",
    unknownReason: null,
    gaps,
    blocking,
  };
}

/**
 * 预检/导出共用的一次握手。**永不抛**:握手是增强,不是接力的前置条件 —— 盘点过程
 * 本身出问题(数据库读失败之类)不该把一条本来能成的接力拦死,如实降级成 unknown。
 */
export async function capabilityReportFor(
  taskId: string,
  peerCaps: HandoffPeerCapabilities | null | undefined,
): Promise<HandoffCapabilityReport> {
  try {
    return compareCapabilities(await needsOf(taskId), peerCaps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "unknown",
      unknownReason: `没能盘点这个任务要用的执行器(${reason}),这次接力无法预先确认目标机跑不跑得动。`,
      gaps: [],
      blocking: false,
    };
  }
}
