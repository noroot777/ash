// 设置 → 飞书 的接口（契约在 shared/src/im.ts，网页端在 web/src/lib/feishuApi.ts）。
//
// 谁能做什么：
//   · 凭证与实例级选项（总开关、深链、额度、只推标题）只有「实例管理员本人」能改 —— 自用模式下
//     就是机主本人；agent 回合凭证即使在自用模式也改不了（它改深链就能把卡片上的链接指到别处）。
//   · 绑定、群绑定各管各的：按发起人（owner key）隔开，多人模式下群列表按项目可见性裁。
//   · 换凭证、生成绑定码、确认绑定另有一道「只认页面凭据」的闸（auth/personal-gate.ts）。
//   · 其余写操作也只放账号本人：这几下改的都是「飞书那头的人能指挥什么」。
// im 身份本身进不来：/im/* 不在 IM 通道的路由白名单里（auth/im-actor.ts）。
import type { FeishuStatus } from "@ash/shared";
import type { Context, Hono } from "hono";
import { actorOf, isAccountHolder, isAdminActor, ownerIdOf, type Actor } from "../auth/context.js";
import { isMultiUser } from "../auth/mode.js";
import { canSeeProject, visibleProjectIds } from "../auth/visibility.js";
import {
  bindingOfOwner, bindingView, confirmUserCode, createBindCode, ownerKeyOf, rejectCode, unbindOwner, updateBinding,
} from "./binding.js";
import {
  channelConfigError, connectionOf, feishuRuntime, instanceTag, quotaMeter, quotaUsage, restartFeishuChannel,
} from "./channel.js";
import { clearCredentials, domainUrl, isValidAppId, readCredentials, writeCredentials } from "./config.js";
import { FeishuApi } from "./feishu/api.js";
import { renderCard } from "./feishu/cards.js";
import { canEditGroup, confirmGroupCode, deleteGroup, GROUP_CHANGED, groupOf, groupsView, patchGroup } from "./groups.js";
import { optionsError, patchOptions, readOptions } from "./meta.js";
import { outboxCounts } from "./outbox.js";
import { SYSTEM_SCOPE } from "./scope.js";

const canManage = (actor: Actor) => isAdminActor(actor) && isAccountHolder(actor);
const ownerOf = (c: Context) => ownerKeyOf(ownerIdOf(actorOf(c)));

/**
 * 此刻配着的飞书应用（null = 没配）。凭证文件读不了（坏了、读到写了一半的、没权限）不等于没配、也不等于换了应用：
 * 先拿正在跑的那条通道的应用兜底，也没有就是不知道（ok: false）—— 绑定和群的接口这时直接回 503（mountImRoutes）。
 * 当成没配的话，网页会把每个绑定都标成「应用换了、要重新绑」，确认绑定被说成换了应用，群列表变空、改群报没有这个群。
 */
function appIdRead(): { ok: true; appId: string | null } | { ok: false; error: string } {
  const read = readCredentials();
  if (read.kind === "ok") return { ok: true, appId: read.credentials.appId };
  if (read.kind === "missing") return { ok: true, appId: null };
  const running = feishuRuntime()?.appId;
  return running ? { ok: true, appId: running } : { ok: false, error: read.error };
}

function currentAppId(): string | null {
  const read = appIdRead();
  return read.ok ? read.appId : null;
}

async function statusOf(actor: Actor): Promise<FeishuStatus> {
  const read = readCredentials();
  const manage = canManage(actor);
  const options = await readOptions();
  // 读不了不等于没配：通道还连着就照它起来时那份显示（原因在 configError 里），不掉进「第一次配置」的样子。
  const config = read.kind === "ok"
    ? { appId: read.credentials.appId, domain: read.credentials.domain, updatedAt: read.credentials.updatedAt }
    : read.kind === "broken" ? feishuRuntime()?.config ?? null : null;
  const appId = config?.appId ?? null;
  return {
    canManage: manage,
    multiUser: await isMultiUser(),
    config,
    configError: read.kind === "broken" ? read.error : optionsError() ?? channelConfigError(),
    connection: connectionOf(),
    options,
    usage: manage ? await quotaUsage() : null,
    instanceTag: instanceTag(),
    outbox: manage && appId ? await outboxCounts(appId) : null,
  };
}

/** 绑定/群绑定变了：卡片该推给谁跟着变，整体对一遍。 */
function refreshPushes(): void {
  void feishuRuntime()?.reconciler.full().catch((error) => console.error("[ash] 飞书对账出错:", error));
}

const bodyOf = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

/**
 * 直接改库、不发总线事件的那几条（网页靠接口返回值自己更新），通道只能等十分钟一次的全量对账才看得到：
 *   · 归档 / 取回、删任务、删项目 —— 这期间飞书里那张卡还挂着按钮（2026-11-06 实测：网页上归档后卡片迟迟不收）；
 *   · 停用 / 恢复账号、改角色、加 / 移项目成员 —— 谁能看哪张卡变了，已经发出去的卡要跟着收起或补推。
 * 等它们成功返回再顺手对一次账。要挂在这些路由之前（routes.ts 里最先调）。
 */
export function mountImSweeps(api: Hono): void {
  const sweepAfter = (method: string) => async (c: Context, next: () => Promise<void>) => {
    await next();
    if (c.req.method === method && c.res.ok) feishuRuntime()?.reconciler.sweepSoon();
  };
  api.use("/tasks/:id/archive", sweepAfter("POST"));
  api.use("/tasks/:id/unarchive", sweepAfter("POST"));
  api.use("/tasks/:id", sweepAfter("DELETE"));
  api.use("/projects/:id", sweepAfter("DELETE"));
  api.use("/users/:id", sweepAfter("PATCH"));
  api.use("/users/:id/suspend", sweepAfter("POST"));
  api.use("/users/:id/resume", sweepAfter("POST"));
  api.use("/projects/:id/members", sweepAfter("POST"));
  api.use("/projects/:id/members/:userId", sweepAfter("PATCH"));
  api.use("/projects/:id/members/:userId", sweepAfter("DELETE"));
}

export function mountImRoutes(api: Hono): void {
  // 写操作统一先过这一道：只放账号本人（agent 回合凭证、匿名都进不来）。
  api.use("/im/feishu/*", async (c, next) => {
    if (c.req.method !== "GET" && !isAccountHolder(actorOf(c))) {
      return c.json({ error: "飞书设置只能由账号本人在 ash 页面上改" }, 403);
    }
    await next();
  });

  const appKnown = async (c: Context, next: () => Promise<void>) => {
    const read = appIdRead();
    if (!read.ok) return c.json({ error: `飞书凭证文件这会儿读不了（${read.error}）：修好之前看不了、也改不了绑定。` }, 503);
    await next();
  };
  for (const path of ["/im/feishu/binding", "/im/feishu/binding/*", "/im/feishu/groups", "/im/feishu/groups/*"]) api.use(path, appKnown);

  api.get("/im/feishu/status", async (c) => c.json(await statusOf(actorOf(c))));

  api.put("/im/feishu/credentials", async (c) => {
    if (!canManage(actorOf(c))) return c.json({ error: "只有实例管理员可以改飞书应用凭证" }, 403);
    const body = await bodyOf(c);
    const appId = typeof body.appId === "string" ? body.appId.trim() : "";
    const domain = body.domain === "lark" ? "lark" : "feishu";
    if (!isValidAppId(appId)) return c.json({ error: "App ID 应形如 cli_xxxxxxxx" }, 400);
    const existing = readCredentials();
    const appSecret = typeof body.appSecret === "string" && body.appSecret.trim()
      ? body.appSecret.trim()
      : existing.kind === "ok" && existing.credentials.appId === appId ? existing.credentials.appSecret : "";
    if (!appSecret) return c.json({ error: "请填写 App Secret" }, 400);
    // 存之前核一次（一次 API 调用）：填错了当场说，而不是存下去之后连接一直失败。
    const meter = await quotaMeter();
    const check = await new FeishuApi({
      appId, appSecret, domain: domainUrl(domain), beforeCall: (kind, purpose) => meter.take(kind, purpose),
    }).checkCredentials();
    if (!check.ok) return c.json({ error: `飞书没认这对 App ID / App Secret：${check.msg || `错误码 ${check.code}`}` }, 400);
    writeCredentials({ appId, appSecret, domain });
    await restartFeishuChannel();
    return c.json(await statusOf(actorOf(c)));
  });

  api.delete("/im/feishu/credentials", async (c) => {
    if (!canManage(actorOf(c))) return c.json({ error: "只有实例管理员可以清除飞书应用凭证" }, 403);
    clearCredentials();
    await restartFeishuChannel();
    return c.json(await statusOf(actorOf(c)));
  });

  api.patch("/im/feishu/options", async (c) => {
    if (!canManage(actorOf(c))) return c.json({ error: "只有实例管理员可以改飞书推送选项" }, 403);
    const before = await readOptions();
    const result = await patchOptions(await bodyOf(c));
    if ("error" in result) return c.json({ error: result.error }, 400);
    (await quotaMeter()).setQuota(result.options.monthlyQuota);
    if (result.options.enabled !== before.enabled) await restartFeishuChannel();
    // 只推标题、深链改了：已经推出去、还挂着按钮的卡也按新的样子改一遍（对账按渲染指纹判）。
    else if (result.options.publicBaseUrl !== before.publicBaseUrl
      || result.options.titleOnlyProjectIds.join() !== before.titleOnlyProjectIds.join()) refreshPushes();
    return c.json(await statusOf(actorOf(c)));
  });

  api.post("/im/feishu/reconnect", async (c) => {
    if (!canManage(actorOf(c))) return c.json({ error: "只有实例管理员可以重连飞书" }, 403);
    await restartFeishuChannel();
    return c.json(await statusOf(actorOf(c)));
  });

  api.post("/im/feishu/test", async (c) => {
    const runtime = feishuRuntime();
    if (!runtime) return c.json({ error: "飞书还没连上" }, 409);
    const binding = await bindingOfOwner(ownerOf(c));
    if (!binding || binding.appId !== runtime.appId) return c.json({ error: "你还没绑定当前这个飞书应用" }, 409);
    if (!(await quotaMeter()).allows("notice")) return c.json({ error: "本月飞书额度已到降级线，测试卡不发了（决策卡照常推）" }, 409);
    const card = renderCard({
      title: "ash 测试卡", tone: "green",
      blocks: [{ type: "text", text: "能看到这张卡，说明推送通了。之后任务等你答复、失败、待验收时，卡片会推到这里。" }],
    });
    await runtime.reconciler.run(() => runtime.reconciler.insert({
      dest: { receiveType: "open_id", receiveId: binding.openId, recipientOpenId: binding.openId },
      taskId: null, kind: "test", subject: `test:${Date.now()}`, content: JSON.stringify(card), scope: SYSTEM_SCOPE,
    }));
    runtime.reconciler.kick();
    return c.json({ ok: true });
  });

  // ── 本人绑定 ───────────────────────────────────────────────────────────────
  api.get("/im/feishu/binding", async (c) => c.json(await bindingView(ownerOf(c), currentAppId())));

  api.post("/im/feishu/binding/code", async (c) => {
    if (!feishuRuntime()) return c.json({ error: "飞书还没连上：先配好应用凭证、等连接变成「已连接」" }, 409);
    return c.json(await createBindCode(ownerOf(c), "user", null));
  });

  api.post("/im/feishu/binding/confirm", async (c) => {
    const body = await bodyOf(c);
    if (typeof body.codeId !== "string") return c.json({ error: "缺少 codeId" }, 400);
    const result = await confirmUserCode(ownerOf(c), body.codeId, currentAppId());
    if (!result.ok) return c.json({ error: result.error }, 409);
    refreshPushes();
    return c.json(await bindingView(ownerOf(c), currentAppId()));
  });

  api.post("/im/feishu/binding/reject", async (c) => {
    const body = await bodyOf(c);
    if (typeof body.codeId !== "string") return c.json({ error: "缺少 codeId" }, 400);
    await rejectCode(ownerOf(c), "user", body.codeId);
    return c.json(await bindingView(ownerOf(c), currentAppId()));
  });

  api.patch("/im/feishu/binding", async (c) => {
    const body = await bodyOf(c);
    const projectId = body.projectId;
    if (projectId !== null && typeof projectId !== "string") return c.json({ error: "projectId 必须是项目 id 或 null" }, 400);
    if (projectId && !(await canSeeProject(actorOf(c), projectId))) return c.json({ error: "看不到这个项目" }, 403);
    const binding = await bindingOfOwner(ownerOf(c));
    if (!binding) return c.json({ error: "还没绑定飞书" }, 409);
    await updateBinding(binding, { projectId: projectId || null });
    return c.json(await bindingView(ownerOf(c), currentAppId()));
  });

  api.delete("/im/feishu/binding", async (c) => {
    await unbindOwner(ownerOf(c));
    refreshPushes();
    return c.json(await bindingView(ownerOf(c), currentAppId()));
  });

  // ── 群绑定 ────────────────────────────────────────────────────────────────
  const groupsFor = async (c: Context) => groupsView(ownerOf(c), isAdminActor(actorOf(c)), currentAppId(), await visibleProjectIds(actorOf(c)));

  api.get("/im/feishu/groups", async (c) => c.json(await groupsFor(c)));

  api.post("/im/feishu/groups/code", async (c) => {
    const body = await bodyOf(c);
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    if (!projectId || !(await canSeeProject(actorOf(c), projectId))) return c.json({ error: "看不到这个项目" }, 403);
    const runtime = feishuRuntime();
    if (!runtime) return c.json({ error: "飞书还没连上" }, 409);
    const binding = await bindingOfOwner(ownerOf(c));
    // 群码要由本人的飞书账号在群里发出来才认，所以先得有本人绑定。
    if (!binding || binding.appId !== runtime.appId) return c.json({ error: "先在上面绑定你自己的飞书账号，再绑群" }, 409);
    return c.json(await createBindCode(ownerOf(c), "group", projectId));
  });

  api.post("/im/feishu/groups/confirm", async (c) => {
    const body = await bodyOf(c);
    if (typeof body.codeId !== "string") return c.json({ error: "缺少 codeId" }, 400);
    const actor = actorOf(c);
    const result = await confirmGroupCode(ownerOf(c), body.codeId, currentAppId(), {
      canSeeProject: (projectId) => canSeeProject(actor, projectId),
      admin: isAdminActor(actor),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status ?? 409);
    refreshPushes();
    return c.json(await groupsFor(c));
  });

  api.post("/im/feishu/groups/reject", async (c) => {
    const body = await bodyOf(c);
    if (typeof body.codeId !== "string") return c.json({ error: "缺少 codeId" }, 400);
    await rejectCode(ownerOf(c), "group", body.codeId);
    return c.json(await groupsFor(c));
  });

  /** 改/解绑群：绑它的人本人，或实例管理员。判过资格的这一份交给写入口，写之前在事务里再核一次没换过。 */
  const editableGroup = async (c: Context) => {
    const appId = currentAppId();
    const group = appId ? await groupOf(appId, c.req.param("chatId") ?? "") : null;
    if (!group || !(await canSeeProject(actorOf(c), group.projectId))) return { error: c.json({ error: "没有这个群" }, 404) };
    if (!canEditGroup(group, ownerOf(c), isAdminActor(actorOf(c)))) {
      return { error: c.json({ error: "这个群是别人绑的，只有他本人或实例管理员能改" }, 403) };
    }
    return { group };
  };

  api.patch("/im/feishu/groups/:chatId", async (c) => {
    const found = await editableGroup(c);
    if ("error" in found) return found.error;
    const body = await bodyOf(c);
    const patch: { projectId?: string; pushCards?: boolean } = {};
    if ("projectId" in body) {
      if (typeof body.projectId !== "string" || !(await canSeeProject(actorOf(c), body.projectId))) return c.json({ error: "看不到这个项目" }, 403);
      patch.projectId = body.projectId;
    }
    if ("pushCards" in body) {
      if (typeof body.pushCards !== "boolean") return c.json({ error: "pushCards 必须是布尔值" }, 400);
      patch.pushCards = body.pushCards;
    }
    if (!await patchGroup(found.group, patch)) return c.json({ error: GROUP_CHANGED }, 409);
    refreshPushes();
    return c.json(await groupsFor(c));
  });

  api.delete("/im/feishu/groups/:chatId", async (c) => {
    const found = await editableGroup(c);
    if ("error" in found) return found.error;
    if (!await deleteGroup(found.group)) return c.json({ error: GROUP_CHANGED }, 409);
    refreshPushes();
    return c.json(await groupsFor(c));
  });
}
