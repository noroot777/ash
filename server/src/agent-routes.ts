// 执行器(agents 表)的增删改查。从 `routes.ts` 拆出来只有一个理由:那个文件到 700 行了。
//
// 新建执行器那一刻顺手把这家 CLI 的 ash MCP 登记接上(`ensureExecutorAshMcp`);每个返回
// 执行器的响应都带上它现在接没接上(`ashMcp`,三态)—— 理由见 `auth/executor-ash-mcp.ts` 顶部。
import type { Context, Hono } from "hono";
import { and, eq, exists, sql } from "drizzle-orm";
import type { AgentType, ExecutorAshMcp } from "@ash/shared";
import { isReasoningEffortSupported, normalizeReasoningEffort, reasoningEffortsFor } from "@ash/shared/cli-presets";
import { normalizeCliConfigOverrides, cliConfigOverrideErrors, readCliConfigOverrides } from "@ash/shared/cli-overrides";
import { db } from "./db/index.js";
import { agents, llmProviders } from "./db/schema.js";
import { id } from "./util.js";
import { detectKnownClis, detectLocalAgents, registrationBlockReason } from "./detect.js";
import { cliHostEnv } from "./executors/cli-env.js";
import { claudeConfigDirOf } from "./executors/claude-settings.js";
import { runEnvForOwner } from "./auth/run-env.js";
import { cachedModelEfforts } from "./executors/model-probe.js";
import { detachTaskRefs } from "./task-refs.js";
import { actorOf } from "./auth/context.js";
import { canUseOwned, filterOwned, notYours, ownerStamp } from "./auth/owned.js";
import { isHostCliIsolated } from "./auth/mode.js";
import { defaultClearScope, dispatchBlockReason } from "./auth/dispatch-gate.js";
import {
  ensureExecutorAshMcp, executorAshMcpState, registeredExecutorAshMcp, storedExtraArgs,
} from "./auth/executor-ash-mcp.js";

const toAgent = (r: typeof agents.$inferSelect) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  model: r.model ?? undefined,
  extraArgs: JSON.parse(r.extraArgs),
  reasoningEffort: r.reasoningEffort ?? undefined,
  speed: r.speed ?? undefined,
  providerId: r.providerId ?? null,
  // 读端不直接 JSON.parse:库里可能躺着升级前写下的越界值、甚至被手工改坏的
  // JSON —— 前者会让页面显示的数跟执行器实际注入的不是一个,后者直接把这个接口
  // 打成 500(设置页整页打不开)。跟执行器读的是同一份判据。
  configOverrides: readCliConfigOverrides(r.type, r.configOverrides),
  isDefault: r.isDefault,
});

// 隔离档下再叠一层「能不能派发」的标注(dispatchBlocked),前端据此把它标灰 ——
// 宿主机订阅被抹去后,没接 relay 的 CLI 与没挂供应商的执行器都跑不起来。
// 实例选了「共用宿主机 CLI」时这一层整个不加:那时没挂供应商恰恰是常态。
//
// **读和写返回同一形状。** 写路径曾经只回 `toAgent`,于是「刚注册出来的那一条」是
// 全应用唯一答不上「它能不能派活」的执行器记录 —— 首启向导据此把一个在隔离档下根本
// 跑不起来的 gemini 显示成已就绪(第 1 轮审查实测)。差一个字段的返回体等于逼每个
// 调用方写完再 GET 一次列表,而漏掉那一次的表现正是「界面说好了,派任务才知道不行」。
//
// `ashMcp` 同一个道理,而且不分档:没接上 ash MCP 的执行器两档都交不了卷。
const toGatedAgent = async (r: typeof agents.$inferSelect, ashMcp: AshMcpProbe = ashMcpProbe()) => ({
  ...toAgent(r),
  ...((await isHostCliIsolated()) ? { dispatchBlocked: dispatchBlockReason(r.type, r.providerId) } : {}),
  ashMcp: await ashMcp(r),
});

type AshMcpProbe = (r: typeof agents.$inferSelect) => Promise<ExecutorAshMcp>;

/**
 * 只读诊断,同一次响应里同一家、同一个人、同一组参数只读一次配置 —— 列表里十几个执行器
 * 多半是同一家 CLI 的几个档位,`.claude.json` 这种文件动辄几 MB,没必要每行都解析一遍。
 */
function ashMcpProbe(): AshMcpProbe {
  const seen = new Map<string, Promise<ExecutorAshMcp>>();
  return (r) => {
    const key = `${r.type}\0${r.ownerUserId ?? ""}\0${r.extraArgs}`;
    let hit = seen.get(key);
    if (!hit) {
      hit = executorAshMcpState(r.type, r.ownerUserId, storedExtraArgs(r.extraArgs));
      seen.set(key, hit);
    }
    return hit;
  };
}

/**
 * 「这个执行器能不能挂上这个供应商」。
 *
 * 供应商是**个人面资源**(§八):它装着这个人自己的 API key。执行器行同样按人隔离,
 * 但 providerId 只是一个字符串外键 —— 不校验的话,我可以建一个「我的」执行器却填上
 * **别人的** providerId,派发闸只看它非空就放行,真正起跑时 `loadRelay(providerId)`
 * 按 id 全局读库,烧的是别人的 key(第 1 轮审查 P1)。
 *
 * 返回拒绝体或 null。不存在与不是我的**回同一句话**(auth/owned.ts notYours 的理由)。
 */
async function providerRejection(c: Context, providerId: unknown): Promise<{ error: string } | null> {
  if (!providerId) return null;
  if (typeof providerId !== "string") return { error: "providerId 必须是字符串" };
  const row = (await db.select().from(llmProviders).where(eq(llmProviders.id, providerId))).at(0);
  return (await canUseOwned(row, actorOf(c))) ? null : notYours("供应商");
}

export function mountAgentRoutes(api: Hono): void {
  // 执行器是**个人面**资源(§八):每人自带供应商 key,别人的执行器既看不见也用不了。
  api.get("/agents", async (c) => {
    const rows = await filterOwned(await db.select().from(agents), actorOf(c));
    const ashMcp = ashMcpProbe();
    return c.json(await Promise.all(rows.map((r) => toGatedAgent(r, ashMcp))));
  });

  // Detect which agent CLIs are installed on the local machine (§5).
  api.get("/agents/detect", async (c) => c.json(await detectLocalAgents()));
  // 已知 CLI 目录:含上面那几个可执行器(带 type),外加一批只做「装没装」展示的。
  api.get("/agents/catalog", async (c) => c.json(await detectKnownClis()));
  // ash 起 CLI 时它会看到的环境事实(只读,不是配置项)。设置页要拿它换算压缩触发点:
  // 有效窗口 = 窗口 − min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, 20000),而那个变量在 server 进程里,
  // 前端算不出来 —— 不报过去的话,页面上写的水位和 CLI 的实际行为会对不上。
  // 多人隔离档下按**请求者自己**的 CLI 配置目录读(跟他的任务起跑时同一份,auth/run-env.ts),
  // 宿主那份配置跟他无关。
  api.get("/agents/cli-env", async (c) => {
    const runEnv = await runEnvForOwner(actorOf(c).userId, "claude");
    return c.json(cliHostEnv(undefined, claudeConfigDirOf(runEnv)));
  });


  api.post("/agents", async (c) => {
    const b = await c.req.json<any>();
    const type = b.type as AgentType;
    const blocked = await registrationBlockReason(type);
    if (blocked) return c.json({ error: blocked }, 409);
    const badProvider = await providerRejection(c, b.providerId);
    if (badProvider) return c.json(badProvider, 404);
    const model = b.model?.trim() || null;
    // 档位能力以**已探到的** CLI 原话为准,拿不到就按内置规则判(cachedModelEfforts 不
    // 触发探测,所以这条路不会因为冷缓存而变慢)。
    const efforts = cachedModelEfforts(type);
    if (b.reasoningEffort && !isReasoningEffortSupported(type, model, b.reasoningEffort, efforts)) {
      return c.json({
        error: `${type} 模型 ${model ?? "（跟随 CLI）"} 不支持思考强度 ${b.reasoningEffort}`,
        allowedReasoningEfforts: reasoningEffortsFor(type, model, efforts),
      }, 400);
    }
    // CLI 配置覆盖:有的键单独填是空转的(claude 的触发百分比要配合窗口才生效)。
    // 前端已经拦了一道,这里是权威那道 —— API 直连、旧前端、脚本改配置都过这里。
    const configOverrides = normalizeCliConfigOverrides(type, b.configOverrides);
    const overrideErrors = cliConfigOverrideErrors(type, configOverrides);
    if (overrideErrors.length) return c.json({ error: overrideErrors.join("；") }, 400);
    const row = {
      id: id(),
      name: b.name,
      type,
      ...ownerStamp(actorOf(c)),
      model,
      extraArgs: JSON.stringify(b.extraArgs ?? []),
      reasoningEffort: normalizeReasoningEffort(type, model, b.reasoningEffort, efforts),
      // 只落 "fast";"standard"/空 归一成 null(标准=不传参,单一表示)
      speed: b.speed === "fast" ? "fast" : null,
      providerId: b.providerId || null,
      configOverrides: JSON.stringify(configOverrides),
      isDefault: !!b.isDefault,
    };
    // 清旧默认与落新行**同批提交**:两次并发的「设为默认」若在清与设之间互相插队,同一
    // 类型会留下两个默认(解析时取到哪个全看行序)。清的范围见 defaultClearScope。
    const clearDefault = row.isDefault
      ? db.update(agents).set({ isDefault: false })
        .where(await defaultClearScope(row.type, row.ownerUserId))
      : null;
    const insert = db.insert(agents).values(row);
    if (clearDefault) await db.batch([clearDefault, insert]);
    else await insert;
    // 落库之后才接 MCP:接不上不该让注册本身失败(执行器照样能用,只是交不了卷;
    // `ensureExecutorAshMcp` 从不抛)。补接成功也不直接算接上 —— 这个执行器自己的参数可能把
    // ash 关掉,以 `registeredExecutorAshMcp` 合出来的那一份为准。
    const ensured = await ensureExecutorAshMcp(type, row.ownerUserId);
    return c.json(await toGatedAgent(
      row as typeof agents.$inferSelect,
      (r) => registeredExecutorAshMcp(ensured, r.type, r.ownerUserId, storedExtraArgs(r.extraArgs)),
    ), 201);
  });

  api.patch("/agents/:id", async (c) => {
    const aid = c.req.param("id");
    const existing = (await db.select().from(agents).where(eq(agents.id, aid))).at(0);
    if (!existing || !(await canUseOwned(existing, actorOf(c)))) return c.json({ error: "not found" }, 404);
    const b = await c.req.json<any>();
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = b.name;
    const type = existing.type as AgentType;
    const nextModel = b.model !== undefined ? b.model?.trim() || null : existing.model;
    const requestedEffort = b.reasoningEffort !== undefined ? b.reasoningEffort : existing.reasoningEffort;
    const efforts = cachedModelEfforts(type);
    if (b.reasoningEffort && !isReasoningEffortSupported(type, nextModel, b.reasoningEffort, efforts)) {
      return c.json({
        error: `${type} 模型 ${nextModel ?? "（跟随 CLI）"} 不支持思考强度 ${b.reasoningEffort}`,
        allowedReasoningEfforts: reasoningEffortsFor(type, nextModel, efforts),
      }, 400);
    }
    if (b.model !== undefined) patch.model = nextModel;
    if (b.extraArgs !== undefined) patch.extraArgs = JSON.stringify(b.extraArgs);
    if (b.reasoningEffort !== undefined || b.model !== undefined) {
      patch.reasoningEffort = normalizeReasoningEffort(type, nextModel, requestedEffort, efforts);
    }
    if (b.speed !== undefined) patch.speed = b.speed === "fast" ? "fast" : null;
    if (b.providerId !== undefined) {
      const badProvider = await providerRejection(c, b.providerId);
      if (badProvider) return c.json(badProvider, 404);
      patch.providerId = b.providerId || null;
    }
    if (b.configOverrides !== undefined) {
      const configOverrides = normalizeCliConfigOverrides(type, b.configOverrides);
      const overrideErrors = cliConfigOverrideErrors(type, configOverrides);
      if (overrideErrors.length) return c.json({ error: overrideErrors.join("；") }, 400);
      patch.configOverrides = JSON.stringify(configOverrides);
    }
    // 同上:清旧默认与设新默认打进同一批。但**成批不等于两条都命中** —— 开头那句
    // 「这个 profile 存在」是在批外读的,删除可以恰好落在它和这一批之间;而 SQLite 对
    // 不存在的行做 UPDATE 是成功的零行操作,不报错也不回滚。于是清旧默认照常提交,设
    // 新默认一行没中:**设置失败,却把另一个仍在的默认抹掉了**(第 1 轮审查 20/20 复现)。
    // 所以把「目标还在」做成清那条语句自己的条件(子查询跟它一起求值),两条就只剩
    // 「都中」或「都不中」—— 判据同 claude-monitor-write.ts 那段。
    const targetAlive = exists(db.select({ one: sql`1` }).from(agents).where(eq(agents.id, aid)));
    const clearDefault = b.isDefault === true
      ? db.update(agents).set({ isDefault: false })
        .where(and(await defaultClearScope(existing.type, existing.ownerUserId), targetAlive))
      : null;
    if (clearDefault) patch.isDefault = true;
    // 响应取**这次写入自己的结果**:写完再独立读一次是第二个空窗口(行刚被删就读成
    // undefined,老代码那个非空断言当场 500)。零行 = 目标已经没了,与开头的预读同一句话。
    const write = db.update(agents).set(patch).where(eq(agents.id, aid)).returning();
    const written = clearDefault ? (await db.batch([clearDefault, write]))[1] : await write;
    const updated = written.at(0);
    if (!updated) return c.json({ error: "not found" }, 404); // 与开头预读那条同一句话
    return c.json(await toGatedAgent(updated));
  });

  api.delete("/agents/:id", async (c) => {
    const aid = c.req.param("id");
    const existing = (await db.select().from(agents).where(eq(agents.id, aid))).at(0);
    if (!existing || !(await canUseOwned(existing, actorOf(c)))) return c.json({ error: "not found" }, 404);
    await db.delete(agents).where(eq(agents.id, aid));
    await detachTaskRefs("executorId", aid);
    return c.json({ deleted: true });
  });
}
