// 认证与首启/转换的端点。**这些路由本身不在闸内**(见 middleware.ts 的 PUBLIC 清单)——
// 前端要先问「现在是什么模式、我登没登」才知道该渲染哪一屏。
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthState, InviteInfo, UserRole } from "@ash/shared";
import { dirNameFromNameHint, suggestDirName, suggestGitEmail, userDirNameError } from "@ash/shared/multiuser";
import { hostname } from "node:os";
import { actorOf, authErrorResponse, requireAdmin } from "./context.js";
import { SESSION_COOKIE, crossSiteRejection } from "./middleware.js";
import {
  ensureHomeDirUnder,
  ensureUserHomeDir,
  instanceConfig,
  isMultiUser,
  needsSetup,
  prepareRootDir,
  setInstanceMode,
  userHomeDir,
} from "./mode.js";
import {
  consumeInvite,
  createSession,
  createUser,
  deleteSession,
  halfBuiltAdmin,
  revokeUserKey,
  findUserByKey,
  getUser,
  issueInvite,
  loadInvite,
  resetUserKey,
  toUserView,
  touchUser,
} from "./store.js";
import { initUserCliEnv } from "./user-cli.js";
import { claimExistingDataFor, conversionPreflight } from "./conversion.js";

/**
 * cookie 一律 `SameSite=Lax` + `HttpOnly`:前者让跨站请求根本带不上它(CSRF 的第一
 * 道),后者让页面脚本读不到(XSS 拿不走会话)。
 *
 * **不设 `Secure`**:ash 本身不做 HTTPS(传输安全靠 Tailscale / 反代 TLS,§一),
 * 设了会让局域网 http 访问直接登不上去 —— 那不是更安全,是不能用。
 */
function issueSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 86_400,
  });
}

async function stateFor(c: Context): Promise<AuthState> {
  const config = await instanceConfig();
  const actor = actorOf(c);
  if (config.mode !== "multi") {
    return { mode: "single", needsSetup: config.mode === "", user: null, rootDir: null, homeDir: null };
  }
  const user = actor.kind === "user" && actor.userId ? await getUser(actor.userId) : null;
  const needs = await needsSetup();
  return {
    mode: "multi",
    needsSetup: needs,
    user: user ? toUserView(user) : null,
    // 补做中(needs)时还没有人能登录,但根目录已经锁死了 —— 不把它交出去,向导那张表
    // 只能靠用户凭记忆填对,填错就是一个 409。
    rootDir: user?.role === "admin" || needs ? config.rootDir : null,
    homeDir: user ? await userHomeDir(user.dirName) : null,
  };
}

export function mountAuthRoutes(api: Hono): void {
  api.get("/auth/state", async (c) => c.json(await stateFor(c)));

  // ── 登录 / 登出 ───────────────────────────────────────────────────────────
  api.post("/auth/login", async (c) => {
    if (!(await isMultiUser())) return c.json({ error: "自用模式不需要登录" }, 400);
    // 登录页本身也是写操作:没有这一道,别的站点能拿一把偷来的 key 在用户浏览器里
    // 静默换出一个会话 cookie。判据与中间件共用一份。
    const rejection = crossSiteRejection({
      secFetchSite: c.req.header("sec-fetch-site"),
      origin: c.req.header("origin"),
      host: c.req.header("host"),
    });
    if (rejection) return c.json({ error: rejection }, 403);
    const { key } = await c.req.json<{ key?: string }>().catch(() => ({ key: "" }));
    const user = await findUserByKey((key ?? "").trim());
    if (!user) return c.json({ error: "这个 key 不对，或者账号已被删除" }, 401);
    if (user.status === "suspended") return c.json({ error: "这个账号已被停用，找管理员恢复" }, 403);
    const token = await createSession(user.id, c.req.header("user-agent") ?? "");
    issueSessionCookie(c, token);
    await touchUser(user.id);
    return c.json({ user: toUserView(user) });
  });

  api.post("/auth/logout", async (c) => {
    await deleteSession(getCookie(c, SESSION_COOKIE) ?? "");
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // 自助轮换:旧 key 即刻失效,新 key 展示一次(§三)。轮换会断掉所有会话,所以
  // 当场再发一个新 cookie —— 否则用户点完「重新生成」就把自己踢出去了。
  api.post("/auth/rotate-key", async (c) => {
    const actor = actorOf(c);
    if (actor.kind !== "user" || !actor.userId) return c.json({ error: "请先登录" }, 401);
    const key = await resetUserKey(actor.userId);
    const token = await createSession(actor.userId, c.req.header("user-agent") ?? "");
    issueSessionCookie(c, token);
    return c.json({ key });
  });

  // ── 首启向导 / 模式转换 ───────────────────────────────────────────────────
  // 一个端点管两件事:它们的差别只有「库里有没有存量数据」,流程与校验完全一致。
  api.post("/auth/setup", async (c) => {
    // CSRF 判据在这里**再落一道**,不是重复:`authGate` 在自用模式下是整条穿透的
    // (§二「自用模式一行不拦」),而这条端点恰恰是自用模式里唯一能把实例**不可逆**
    // 推进另一个状态的写操作 —— 跨站一发,用户的实例就翻成攻击者命名的多人模式,
    // 他自己反倒只剩登录页,拿不到 key 就只能走宿主机逃生门(第 1 轮审查 P1)。
    // 判据与 `/auth/login`、中间件共用同一份 `crossSiteRejection`。
    const rejection = crossSiteRejection({
      secFetchSite: c.req.header("sec-fetch-site"),
      origin: c.req.header("origin"),
      host: c.req.header("host"),
    });
    if (rejection) return c.json({ error: rejection }, 403);
    const config = await instanceConfig();
    // 「首启」有两种:模式还没定过,以及**定了 multi 却没人能登录**(转换中途崩了)。
    // 后者必须也走这条路 —— 否则实例锁死在一个谁也进不去的多人模式里,只能手改库。
    const resuming = config.mode === "multi" && (await needsSetup());
    const first = config.mode === "" || resuming;
    // 已经定过模式 = 这是设置页危险区的转换,必须是管理员(自用模式下人人都是)。
    if (!first) {
      try {
        requireAdmin(actorOf(c));
      } catch (error) {
        const mapped = authErrorResponse(error);
        if (mapped) return c.json(mapped.body, mapped.status);
        throw error;
      }
    }
    if (config.mode === "multi" && !resuming) return c.json({ error: "已经是多人模式了" }, 409);

    const body = await c.req.json<{
      mode?: string;
      adminName?: string;
      rootDir?: string;
      dirName?: string;
      gitName?: string;
      gitEmail?: string;
    }>().catch(() => ({} as Record<string, never>));

    if (body.mode === "single") {
      // 补做中的实例走不到这里:multi 转不回 single(§二),与其抛个 500,不如说清楚。
      if (resuming) {
        return c.json({ error: "这个实例已经是多人模式了，只能把管理员补建出来；多人模式不能转回自用模式" }, 409);
      }
      await setInstanceMode("single", "");
      return c.json(await stateFor(c));
    }
    if (body.mode !== "multi") return c.json({ error: "mode 只能是 single 或 multi" }, 400);

    const adminName = (body.adminName ?? "").trim();
    if (!adminName) return c.json({ error: "管理员姓名必填" }, 400);
    const dirName = (body.dirName ?? "").trim() || suggestDirName(adminName);
    // 没传 dirName、姓名又推不出一个(中文名必然如此)时,别回一句干巴巴的「目录名必填」——
    // 那对着一张已经填了姓名的表单是句谜语。
    if (!dirName) return c.json({ error: dirNameFromNameHint(adminName) }, 400);
    const dirError = userDirNameError(dirName);
    if (dirError) return c.json({ error: `目录名不合法：${dirError}` }, 400);

    let rootDir: string;
    try {
      rootDir = prepareRootDir(body.rootDir ?? "");
    } catch (error) {
      return c.json({ error: (error as Error).message }, ((error as { status?: number }).status ?? 400) as 400);
    }

    // 顺序有讲究,而且**两头都要顾**:
    //  · 建人**之前**必须先把管理员目录建出来。反过来的话(第 1 轮审查 P0),
    //    `ensureUserHomeDir` 一失败(路径被文件占着、没写权限),实例已经是 multi、
    //    管理员行已落库却没有 key —— 向导被 needsSetup 藏起来,谁也进不去。目录先建
    //    则失败时**库里一个字都没动**,原样重试即可。
    //  · 落模式仍要排在建人之前:建人成功而写模式失败会留下孤儿用户,下次转换撞目录名。
    // 两条合起来就是「先磁盘、再模式、最后人」。
    try {
      ensureHomeDirUnder(rootDir, dirName);
    } catch (error) {
      return c.json({ error: (error as Error).message }, ((error as { status?: number }).status ?? 500) as 500);
    }
    try {
      await setInstanceMode("multi", rootDir);
    } catch (error) {
      // 根目录锁死(补做时填了另一个路径)是这里唯一的可预期失败,如实回它的原话。
      return c.json({ error: (error as Error).message }, 409);
    }
    // 补做时**先认领上一次留下的那半个管理员**,而不是再插一行。上次可能已经跑完
    // `claimExistingDataFor`(存量项目/执行器都记在那个 id 名下),另起一行会把那些
    // 数据留给一个谁也登录不了的账号。它的目录名是当初锁死的那个,以库里的为准。
    const half = resuming ? await halfBuiltAdmin() : null;
    const admin = half ?? await createUser({
      name: adminName,
      role: "admin",
      dirName,
      gitName: (body.gitName ?? "").trim() || adminName,
      gitEmail: (body.gitEmail ?? "").trim() || suggestGitEmail(adminName, dirName),
      createdBy: null,
    });
    // 认领来的那行的目录名可能与表单里填的不同(锁死的是库里那个),按它再保一次。
    if (half) await ensureUserHomeDir(half.dirName);
    initUserCliEnv(admin.id);
    // 存量项目/随手记/供应商/执行器等一律归初始管理员(§十三);项目路径一律不动。
    const claimed = await claimExistingDataFor(admin.id);
    const key = await resetUserKey(admin.id);
    // 建完就登录:向导展示 key 之后紧接着就是「进入实例」,再要求粘一次 key 是多余的。
    const token = await createSession(admin.id, c.req.header("user-agent") ?? "");
    issueSessionCookie(c, token);
    return c.json({ key, user: toUserView({ ...admin, keyHash: "set", status: "active" }), claimed, rootDir });
  });

  // 转多人之前的盘点:存量执行器里哪些没挂供应商(§十三)。向导据此逐条警告。
  api.get("/auth/setup/preflight", async (c) => {
    const { unbackedExecutors, counts } = await conversionPreflight();
    return c.json({ unbackedExecutors, counts, host: hostname() });
  });

  // ── 专属邀请链接的领取 ────────────────────────────────────────────────────
  // 三步:看说明(GET) → 领取生成 key(POST claim) → 点「我已保存」作废链接(POST confirm)。
  // 领取那一步**不作废链接** —— 手滑点开就锁死是 §五 明确要避免的。
  api.get("/auth/claim/:token", async (c) => {
    const found = await loadInvite(c.req.param("token"));
    if (!found) return c.json({ error: "这条邀请链接不存在" }, 404);
    const user = await getUser(found.row.userId);
    if (!user) return c.json({ error: "这条邀请对应的账号已经不在了" }, 404);
    const info: InviteInfo = {
      name: user.name,
      role: user.role as UserRole,
      host: hostname(),
      expiresAt: found.row.expiresAt,
      ...(found.invalid ? { invalid: found.invalid } : {}),
    };
    return c.json(info);
  });

  api.post("/auth/claim/:token", async (c) => {
    const found = await loadInvite(c.req.param("token"));
    if (!found) return c.json({ error: "这条邀请链接不存在" }, 404);
    if (found.invalid) return c.json({ error: found.invalid }, 409);
    const user = await getUser(found.row.userId);
    if (!user) return c.json({ error: "这条邀请对应的账号已经不在了" }, 404);
    if (user.status === "suspended") return c.json({ error: "这个账号已被停用" }, 403);
    const key = await resetUserKey(user.id);
    // 领完直接给会话:这一步之后用户就该看到实例本身了。链接仍未作废 —— 万一他
    // 没保存住 key,刷新这条链接还能再领一次(下一次会生成新 key,旧的失效)。
    const token = await createSession(user.id, c.req.header("user-agent") ?? "");
    issueSessionCookie(c, token);
    return c.json({ key, user: toUserView({ ...user, keyHash: "set", status: "active" }) });
  });

  api.post("/auth/claim/:token/confirm", async (c) => {
    const found = await loadInvite(c.req.param("token"));
    if (!found) return c.json({ error: "这条邀请链接不存在" }, 404);
    await consumeInvite(found.row.id);
    return c.json({ ok: true });
  });

  // ── 宿主机逃生门(§三)──────────────────────────────────────────────────────
  // 唯一管理员丢 key 时的出路。它**不是 HTTP 端点**,而是 scripts/ash-admin.mjs 直接
  // 操作数据库文件 —— 能碰到那个文件的人本来就拥有一切,所以这条路不削弱任何东西。
  // 这里只放一个说明端点,让界面能把命令原样告诉用户。
  api.get("/auth/recovery-hint", (c) =>
    c.json({
      command: "node scripts/ash-admin.mjs invite-admin",
      note: "在跑着 ash 的那台机器上、仓库根目录执行。它会打印一条新的管理员邀请链接。",
    }));

  // 管理员为任何用户重置 key:走专属邀请链接重领(§五),旧 key 即刻失效。
  api.post("/users/:id/reset-key", async (c) => {
    try {
      requireAdmin(actorOf(c));
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
    const user = await getUser(c.req.param("id"));
    if (!user) return c.json({ error: "用户不存在" }, 404);
    // 先作废旧 key 与所有会话,再发新链接 —— 反过来的话中间那一小段里旧 key 还能用,
    // 而「重置」的语义就是「他手上那把从现在起打不开门」。
    await revokeUserKey(user.id);
    const token = await issueInvite(user.id, actorOf(c).userId);
    return c.json({ inviteUrl: `/claim/${token}` });
  });
}
