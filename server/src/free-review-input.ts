// 自由工作流派审/预约的**输入校验**（从 free-workflow.ts 拆出，纯行数拆分）：
// 检查类型、复审轮数、附言，以及「这一次换个人/换个模型跑」的执行器覆盖。
import type { AgentType, FreeReviewCheckMode, FreeReviewExecutorOverride } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { FREE_REVIEW_CHECK_MODES } from "@harness/shared/free-workflow";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { agents } from "./db/schema.js";

const MAX_RETRIES = 5;
const MAX_REVIEW_NOTE_LENGTH = 2_000;

export function checkMode(value: unknown): FreeReviewCheckMode {
  if (typeof value !== "string" || !(FREE_REVIEW_CHECK_MODES as readonly string[]).includes(value)) {
    throw new Error("审查类型只能是 syntax 或 logic");
  }
  return value as FreeReviewCheckMode;
}

export function retryLimit(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MAX_RETRIES) {
    throw new Error(`自动复审轮数必须是 0-${MAX_RETRIES} 的整数`);
  }
  return Number(value);
}

export function reviewNote(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("审查附言必须是文本");
  const note = value.trim();
  if (note.length > MAX_REVIEW_NOTE_LENGTH) throw new Error(`审查附言不能超过 ${MAX_REVIEW_NOTE_LENGTH} 字`);
  return note || null;
}

function overrideText(value: unknown, max: number, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${field}必须是文本或 null`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field}不能超过 ${max} 个字符`);
  return normalized || null;
}

/**
 * 「这一次换个人/换个模型跑」的覆盖。**审查者配置一个字都不动**——用户在派审面上改了
 * 三段胶囊却选了「不保存」，改动就只能活在这一条审查里（预约则活在预约槽的四列里）。
 *
 * 校验与审查者配置同源（`reviewer-profiles.ts`）：执行器必须存在、且类型对得上，否则
 * 覆盖会把审查派给一个根本解析不出来的执行器，失败要等到真正开跑才暴露。
 */
export async function reviewOverride(value: unknown): Promise<FreeReviewExecutorOverride | null> {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("审查执行器覆盖必须是对象");
  const raw = value as Record<string, unknown>;
  const type = raw.agentType;
  if (typeof type !== "string" || !(AGENT_TYPES as readonly string[]).includes(type)) {
    throw new Error("覆盖的智能体类型无效");
  }
  const agentType = type as AgentType;
  const executorId = overrideText(raw.executorId, 100, "执行器");
  if (executorId) {
    const profile = (await db.select({ type: agents.type }).from(agents).where(eq(agents.id, executorId))).at(0);
    if (!profile) throw new Error("覆盖所选的执行器不存在");
    if (profile.type !== agentType) throw new Error(`覆盖所选的执行器属于 ${profile.type}，与 ${agentType} 不匹配`);
  }
  return {
    agentType,
    executorId,
    model: overrideText(raw.model, 160, "模型"),
    reasoningEffort: overrideText(raw.reasoningEffort, 60, "智能水平"),
  };
}

type ReviewerRunConfig = Pick<FreeReviewExecutorOverride, "agentType" | "executorId" | "model" | "reasoningEffort">;

/** 这次审查实际要跑的执行器：有覆盖就整套用覆盖的，没有就整套用审查者自己的。 */
export function reviewRunConfig(
  profile: { agentType: string; executorId: string | null; model: string | null; reasoningEffort: string | null },
  override: FreeReviewExecutorOverride | null,
): ReviewerRunConfig {
  return override ?? {
    agentType: profile.agentType as AgentType,
    executorId: profile.executorId,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
  };
}

/** 覆盖的人话形态：「codex · gpt-5.6-sol · high」，跟着有值的段走。 */
export function overrideLabel(override: FreeReviewExecutorOverride): string {
  return `${override.agentType}${override.model ? ` · ${override.model}` : ""}` +
    `${override.reasoningEffort ? ` · ${override.reasoningEffort}` : ""}`;
}

/** 时间线里点明「这次跟审查者存的配置不一样」，否则用户只看到审查者名字，读不出跑的是谁。 */
export function overrideSuffix(override: FreeReviewExecutorOverride | null): string {
  return override ? `（本次用 ${overrideLabel(override)}）` : "";
}
