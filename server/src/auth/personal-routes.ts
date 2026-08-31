// 「个人 CLI 环境」设置节的端点(§九)与配置导出/导入(§十)。
//
// 两块放一个文件里,因为它们是同一件事的两面:新成员冷启动**不靠共享库**,靠从别人
// 那里导入一份配置(§八),而导入的落点正是他自己的个人资源与个人 CLI 目录。
//
// **导出永远不含 API key**(§十)。这不是可配置项 —— 导出文件会被丢进群里、存进网盘,
// 一旦带 key 就等于把每个人的账单公开。导入方必须自己把 key 补回去,界面上明说。
//
// 改完个人技能**不用手动让技能缓存失效**:skills.ts 的扫描缓存以磁盘指纹为键
// (walk + fingerprintOf 每次现算),写完文件下一次扫描自然错开,不存在陈旧列表。
import type { Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AgentType, ConfigBundle, ConfigBundleKind } from "@ash/shared";
import { CONFIG_BUNDLE_KINDS } from "@ash/shared/multiuser";
import { db } from "../db/index.js";
import { agents, llmProviders, reviewerProfiles, teamPresets, workflows } from "../db/schema.js";
import { id, now } from "../util.js";
import { actorOf, isAccountHolder } from "./context.js";
import { isHostCliShared, isMultiUser } from "./mode.js";
import { filterOwned, ownedScope, ownerStamp } from "./owned.js";
import {
  deletePersonalSkill,
  listPersonalCliEnv,
  personalCliEnv,
  readPersonalMemory,
  readPersonalSkill,
  writePersonalMemory,
  writePersonalSkill,
} from "./user-cli.js";

/**
 * 个人 CLI 环境只对**本人**开放 —— 连实例管理员也看不了别人的(§八 个人面)。
 *
 * 「本人」不含 agent 回合凭证:它带着 owner 的 userId,但代表的是那一条任务
 * (`isAccountHolder` 的注释)。放它进来 = 任意一个正在跑的 agent 都能读改 owner 的
 * 全局 CLAUDE.md 与个人技能,而那正是**下一次派任务时喂给所有 CLI** 的东西 ——
 * 一条任务就能改写这个账号往后的行为(第 2 轮审查 P1 同一类)。
 */
function selfId(c: Context): string | null {
  const actor = actorOf(c);
  if (!isAccountHolder(actor)) return null;
  return actor.userId ?? null;
}

/** 拿不到「本人」时的拒绝。两种成因文案不同:没登录 vs 拿的是回合凭证。 */
function refuseSelf(c: Context): Response {
  if (actorOf(c).kind === "agent") {
    return c.json({ error: "个人设置只对账号本人开放：回合凭证代表的是那一条任务，不是这个账号" }, 403);
  }
  return c.json({ error: "请先登录" }, 401);
}

export function mountPersonalCliRoutes(api: Hono): void {
  api.get("/me/cli-env", async (c) => {
    if (!(await isMultiUser())) {
      // 自用模式没有「个人」这一层:CLI 用的就是宿主机默认目录,订阅照用(§九)。
      return c.json({ mode: "single", sharedHostCli: false, envs: [] });
    }
    const userId = selfId(c);
    if (!userId) return refuseSelf(c);
    // 实例选了「共用宿主机 CLI」时个人配置目录压根没被注入(§八之二),这一层如实报
    // **不生效**:目录还在盘上、编辑器也还能写,但 CLI 根本不会去读它。不说清楚的话,
    // 用户会在这里装一个技能然后发现补全里没有 —— 而界面上一切正常。
    return c.json({ mode: "multi", sharedHostCli: await isHostCliShared(), envs: listPersonalCliEnv(userId) });
  });

  api.get("/me/cli-env/:agentType", async (c) => {
    const userId = selfId(c);
    if (!userId) return refuseSelf(c);
    return c.json(personalCliEnv(userId, c.req.param("agentType") as AgentType));
  });

  // ── 个人技能 ─────────────────────────────────────────────────────────────
  api.get("/me/cli-env/:agentType/skills/:name", async (c) => {
    const userId = selfId(c);
    if (!userId) return refuseSelf(c);
    const body = readPersonalSkill(userId, c.req.param("agentType") as AgentType, c.req.param("name"));
    if (body === null) return c.json({ error: "技能不存在" }, 404);
    return c.json({ name: c.req.param("name"), body });
  });

  api.put("/me/cli-env/:agentType/skills/:name", async (c) => {
    const userId = selfId(c);
    if (!userId) return refuseSelf(c);
    const b = await c.req.json<{ body?: string }>().catch(() => ({}) as { body?: string });
    if (typeof b.body !== "string" || !b.body.trim()) return c.json({ error: "SKILL.md 内容不能为空" }, 400);
    try {
      writePersonalSkill(userId, c.req.param("agentType") as AgentType, c.req.param("name"), b.body);
    } catch (error) {
      return c.json({ error: (error as Error).message }, ((error as { status?: number }).status ?? 400) as 400);
    }
    return c.json(personalCliEnv(userId, c.req.param("agentType") as AgentType));
  });

  api.delete("/me/cli-env/:agentType/skills/:name", async (c) => {
    const userId = selfId(c);
    if (!userId) return refuseSelf(c);
    try {
      deletePersonalSkill(userId, c.req.param("agentType") as AgentType, c.req.param("name"));
    } catch (error) {
      return c.json({ error: (error as Error).message }, ((error as { status?: number }).status ?? 400) as 400);
    }
    return c.json(personalCliEnv(userId, c.req.param("agentType") as AgentType));
  });

  // ── 个人全局 CLAUDE.md / AGENTS.md ───────────────────────────────────────
  api.get("/me/cli-env/:agentType/memory", async (c) => {
    const userId = selfId(c);
    if (!userId) return refuseSelf(c);
    return c.json({ body: readPersonalMemory(userId, c.req.param("agentType") as AgentType) });
  });

  api.put("/me/cli-env/:agentType/memory", async (c) => {
    const userId = selfId(c);
    if (!userId) return refuseSelf(c);
    const b = await c.req.json<{ body?: string }>().catch(() => ({}) as { body?: string });
    try {
      writePersonalMemory(userId, c.req.param("agentType") as AgentType, b.body ?? "");
    } catch (error) {
      return c.json({ error: (error as Error).message }, ((error as { status?: number }).status ?? 400) as 400);
    }
    return c.json({ ok: true });
  });

  mountConfigTransferRoutes(api);
}

// ── 配置导出 / 导入(§十)──────────────────────────────────────────────────

function bundleKinds(raw: unknown): ConfigBundleKind[] {
  if (!Array.isArray(raw)) return [...CONFIG_BUNDLE_KINDS];
  const wanted = raw.filter((k): k is ConfigBundleKind => CONFIG_BUNDLE_KINDS.includes(k as ConfigBundleKind));
  return wanted.length ? wanted : [...CONFIG_BUNDLE_KINDS];
}

function mountConfigTransferRoutes(api: Hono): void {
  api.post("/me/config/export", async (c) => {
    // `/me/*` 整条都是账号面,导出也不例外:它按 owner 的 scope 把个人供应商、执行器、
    // 个人技能全打成一个包 —— 一条任务的回合凭证不该能把 owner 的整份配置端走。
    if (!isAccountHolder(actorOf(c))) return refuseSelf(c);
    const actor = actorOf(c);
    const kinds = bundleKinds(
      (await c.req.json<{ kinds?: unknown }>().catch(() => ({}) as { kinds?: unknown })).kinds,
    );
    const bundle: ConfigBundle = { version: 1, exportedAt: now(), kinds, items: {} };

    if (kinds.includes("providers")) {
      // **key 一律剥掉**(§十)。留下的是「上游是谁、协议怎么说、默认哪个模型」——
      // 导入方补上自己的 key 就能用,而这份文件本身丢在群里也不会漏账号。
      bundle.items.providers = (await filterOwned(await db.select().from(llmProviders), actor)).map((p) => ({
        name: p.name,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        model: p.model,
        protocolConversionEnabled: p.protocolConversionEnabled,
        modelListMode: p.modelListMode,
        pinnedModels: p.pinnedModels,
        context1mModels: p.context1mModels,
      }));
    }
    if (kinds.includes("executors")) {
      // providerName 是**按名字**的软引用:导入方那边的 provider id 必然不同,靠 id
      // 引用一定悬空。名字对不上就落成「没挂供应商」,由界面提示他自己接一下。
      const providerNames = new Map(
        (await db.select().from(llmProviders)).map((p) => [p.id, p.name] as const),
      );
      bundle.items.executors = (await filterOwned(await db.select().from(agents), actor)).map((a) => ({
        name: a.name,
        type: a.type,
        model: a.model,
        extraArgs: a.extraArgs,
        reasoningEffort: a.reasoningEffort,
        speed: a.speed,
        configOverrides: a.configOverrides,
        isDefault: a.isDefault,
        providerName: a.providerId ? providerNames.get(a.providerId) ?? null : null,
      }));
    }
    if (kinds.includes("workflows")) {
      bundle.items.workflows = (await filterOwned(await db.select().from(workflows), actor)).map((w) => ({
        builtinKey: w.builtinKey,
        name: w.name,
        description: w.description,
        def: w.def,
        disabled: w.disabled,
      }));
    }
    if (kinds.includes("reviewers")) {
      bundle.items.reviewers = (await filterOwned(await db.select().from(reviewerProfiles), actor)).map((r) => ({
        name: r.name,
        agentType: r.agentType,
        model: r.model,
        reasoningEffort: r.reasoningEffort,
      }));
    }
    if (kinds.includes("teamPresets")) {
      bundle.items.teamPresets = (await filterOwned(await db.select().from(teamPresets), actor)).map((t) => ({
        name: t.name,
        config: t.config,
      }));
    }
    if (kinds.includes("cliEnv")) {
      const userId = actor.userId;
      bundle.items.cliEnv = userId
        ? listPersonalCliEnv(userId)
            .filter((env) => env.supported)
            .map((env) => ({
              agentType: env.agentType,
              memory: readPersonalMemory(userId, env.agentType as AgentType),
              skills: env.skills
                .map((s) => ({ name: s.name, body: readPersonalSkill(userId, env.agentType as AgentType, s.name) ?? "" }))
                .filter((s) => s.body),
            }))
        : [];
    }
    return c.json(bundle);
  });

  api.post("/me/config/import", async (c) => {
    if (!isAccountHolder(actorOf(c))) return refuseSelf(c);
    const actor = actorOf(c);
    const bundle = await c.req.json<ConfigBundle>().catch(() => null);
    if (!bundle || bundle.version !== 1 || !bundle.items) {
      return c.json({ error: "这不是一份 ash 配置导出文件（或版本不认识）" }, 400);
    }
    const stamp = ownerStamp(actor);
    const owner = await ownedScope(actor);
    const imported: Record<string, number> = {};
    const notes: string[] = [];

    // 同名一律**跳过而不是覆盖**:导入是「把别人的配置搬过来」,不该把我自己已经调好
    // 的同名条目改掉。跳过了哪些如实回报,让用户自己决定要不要改名重导。
    const skipped: string[] = [];

    if (bundle.items.providers) {
      const existing = new Set((await filterOwned(await db.select().from(llmProviders), actor)).map((p) => p.name));
      let n = 0;
      for (const p of bundle.items.providers) {
        if (existing.has(p.name)) { skipped.push(`供应商「${p.name}」`); continue; }
        await db.insert(llmProviders).values({
          id: id(),
          ...stamp,
          name: p.name,
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          apiKey: "", // §十:导出从不含 key,导入后必须自己补
          model: p.model ?? "",
          protocolConversionEnabled: !!p.protocolConversionEnabled,
          modelListMode: p.modelListMode ?? "api",
          pinnedModels: p.pinnedModels ?? "[]",
          context1mModels: p.context1mModels ?? "[]",
          createdAt: now(),
        });
        n++;
      }
      imported.providers = n;
      if (n) notes.push(`导入的 ${n} 个供应商都没有 API key —— 请逐个补上自己的 key，否则挂它的执行器派不出任务`);
    }

    if (bundle.items.executors) {
      const providerByName = new Map(
        (await filterOwned(await db.select().from(llmProviders), actor)).map((p) => [p.name, p.id] as const),
      );
      const existing = new Set((await filterOwned(await db.select().from(agents), actor)).map((a) => a.name));
      let n = 0;
      let unlinked = 0;
      for (const a of bundle.items.executors) {
        if (existing.has(a.name)) { skipped.push(`执行器「${a.name}」`); continue; }
        const providerId = a.providerName ? providerByName.get(a.providerName) ?? null : null;
        if (a.providerName && !providerId) unlinked++;
        await db.insert(agents).values({
          id: id(),
          ...stamp,
          name: a.name,
          type: a.type,
          model: a.model ?? null,
          extraArgs: a.extraArgs ?? "[]",
          reasoningEffort: a.reasoningEffort ?? null,
          speed: a.speed ?? null,
          providerId,
          configOverrides: a.configOverrides ?? "{}",
          // 导入的条目**一律不是默认** —— 否则一次导入就把我自己的默认执行器换掉了。
          isDefault: false,
        });
        n++;
      }
      imported.executors = n;
      if (unlinked) notes.push(`${unlinked} 个执行器原本挂的供应商在这边找不到同名的，已落成「未挂供应商」`);
    }

    if (bundle.items.workflows) {
      const mine = await filterOwned(await db.select().from(workflows), actor);
      const existing = new Set(mine.map((w) => w.builtinKey ?? w.name));
      let n = 0;
      for (const w of bundle.items.workflows) {
        const key = w.builtinKey ?? w.name;
        if (existing.has(key)) { skipped.push(`起手式「${w.name}」`); continue; }
        await db.insert(workflows).values({
          id: id(),
          ...stamp,
          builtinKey: w.builtinKey ?? null,
          name: w.name,
          description: w.description ?? "",
          def: w.def,
          disabled: !!w.disabled,
          createdAt: now(),
          updatedAt: now(),
        });
        n++;
      }
      imported.workflows = n;
    }

    if (bundle.items.reviewers) {
      const existing = new Set((await filterOwned(await db.select().from(reviewerProfiles), actor)).map((r) => r.name));
      let n = 0;
      for (const r of bundle.items.reviewers) {
        if (existing.has(r.name)) { skipped.push(`审查者「${r.name}」`); continue; }
        await db.insert(reviewerProfiles).values({
          id: id(),
          ...stamp,
          name: r.name,
          agentType: r.agentType,
          // executorId 是**本地私有资源的主键**,跨人跨机一定悬空,一律不带过来。
          executorId: null,
          model: r.model ?? null,
          reasoningEffort: r.reasoningEffort ?? null,
          createdAt: now(),
          updatedAt: now(),
        });
        n++;
      }
      imported.reviewers = n;
    }

    if (bundle.items.teamPresets) {
      const existing = new Set((await filterOwned(await db.select().from(teamPresets), actor)).map((t) => t.name));
      let n = 0;
      for (const t of bundle.items.teamPresets) {
        if (existing.has(t.name)) { skipped.push(`模式预设「${t.name}」`); continue; }
        await db.insert(teamPresets).values({
          id: id(),
          ...stamp,
          name: t.name,
          config: t.config,
          createdAt: now(),
        });
        n++;
      }
      imported.teamPresets = n;
    }

    if (bundle.items.cliEnv && owner) {
      let n = 0;
      for (const env of bundle.items.cliEnv) {
        try {
          if (env.memory?.trim()) writePersonalMemory(owner, env.agentType as AgentType, env.memory);
          for (const skill of env.skills ?? []) {
            if (readPersonalSkill(owner, env.agentType as AgentType, skill.name) !== null) {
              skipped.push(`技能「${skill.name}」`);
              continue;
            }
            writePersonalSkill(owner, env.agentType as AgentType, skill.name, skill.body);
            n++;
          }
        } catch (error) {
          notes.push(`${env.agentType} 的个人环境导入失败：${(error as Error).message}`);
        }
      }
      imported.cliSkills = n;
    }

    return c.json({ imported, skipped, notes });
  });
}

/** 删用户时把他的个人资源一并清掉的入口(目前只在测试与排查里用)。 */
export async function deleteOwnedResources(userId: string): Promise<void> {
  await db.delete(agents).where(eq(agents.ownerUserId, userId));
  await db.delete(llmProviders).where(eq(llmProviders.ownerUserId, userId));
  await db.delete(workflows).where(eq(workflows.ownerUserId, userId));
  await db.delete(reviewerProfiles).where(eq(reviewerProfiles.ownerUserId, userId));
  await db.delete(teamPresets).where(eq(teamPresets.ownerUserId, userId));
}
