import "./env.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, statSync, createReadStream, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { join, extname, normalize, sep } from "node:path";
import type { Context } from "hono";
import {
  acquireDbSingletonLock,
  SingletonConflictError,
  type SingletonLock,
} from "./singleton.js";
import { inspectPortCommand, inspectProcessSync, killPidsCommand, listenerPidsSync } from "./platform.js";
// 纯粹读一个环境变量，不碰 DB，所以可以静态 import（其余会打开库的模块一律等拿到锁之后）。
import { IS_PREVIEW_INSTANCE } from "./preview-instance.js";
import { recordListeningPort } from "./listening-port.js";

let singletonLock: SingletonLock | null = null;
let activeServer: ReturnType<typeof serve> | null = null;
let startupComplete = false;
let startupExitInProgress = false;

// Never let a stray async error (e.g. an SSE write to a disconnected client)
// take the whole server down once it is healthy. During startup, however, an
// unhandled error means the server never became usable and must be fatal.
process.on("unhandledRejection", (e) => {
  if (!startupComplete) exitAfterStartupFailure("unhandled rejection during startup", e);
  console.error("[ash] unhandledRejection:", e);
});
process.on("uncaughtException", (e) => {
  if (!startupComplete) exitAfterStartupFailure("uncaught exception during startup", e);
  console.error("[ash] uncaughtException:", e);
});

const port = Number(process.env.PORT ?? 4317);

function exitAfterStartupFailure(message: string, error?: unknown): never {
  if (!startupExitInProgress) {
    startupExitInProgress = true;
    console.error(`[ash] Refusing to start: ${message}`);
    if (error) console.error(error);

    // The scheduler starts only after listen succeeds. If starting it throws
    // after creating its interval, process.exit below still removes that timer.
    if (activeServer?.listening) {
      try {
        activeServer.close();
      } catch (closeError) {
        console.error("[ash] failed to close server during startup cleanup:", closeError);
      }
    }
    // release() verifies this process' PID + token before unlinking, so this
    // cannot remove a lock subsequently acquired by another server.
    singletonLock?.release();
  }
  process.exit(1);
}

function portConflictMessage(conflictingPort: number) {
  const pids = listenerPidsSync(conflictingPort);
  const lines = [`port ${conflictingPort} is already in use.`, `  Port: ${conflictingPort}`];
  for (const pid of pids) {
    const info = inspectProcessSync(pid);
    lines.push(`  Listener PID ${pid}: ${info?.command ?? "unknown command"}`);
  }
  if (pids.length === 0) lines.push("  Listener: PID could not be determined");
  // 探测跟监听者退出赛跑、或者探测命令本身不可用时,下面这条可复制的命令仍然有用。
  lines.push("Inspect the listener with:", `  ${inspectPortCommand(conflictingPort)}`);
  if (pids.length > 0) lines.push("Stop it, then retry:", `  ${killPidsCommand(pids)}`);
  return lines.join("\n");
}

try {
  singletonLock = acquireDbSingletonLock({ port });
} catch (e) {
  if (e instanceof SingletonConflictError) {
    console.error(e.message);
    process.exit(1);
  }
  exitAfterStartupFailure("failed to acquire the database singleton lock", e);
}

const { startScheduler, api, authGate, resourceGate, personalWriteGate, withHandoffActor, actorOf, ownerIdOf } = await initializeServer().catch((e) =>
  exitAfterStartupFailure("server initialization failed", e),
);

async function initializeServer() {
  const [{ ensureSchema }, { migrateQueues }, { reconcileInterrupted }, { reattachRunningTasks }, { sweepRunLogs }, schedulesModule, routesModule, stageModule, acceptanceModule, reviewModule, verifyOverrideModule] =
    await Promise.all([
      import("./db/index.js"),
      import("./db/migrateQueues.js"),
      import("./orchestrator.js"),
      import("./reattach.js"),
      import("./run-logs-gc.js"),
      import("./schedules.js"),
      import("./routes.js"),
      import("./task-stage.js"),
      import("./task-accept.js"),
      import("./review.js"),
      import("./verify-override.js"),
    ]);

  await ensureSchema();
  // 实例模式(自用 / 多人)要在任何路由被打之前读出来:同步派进程那条路只认
  // auth/multi-flag.ts 里的缓存镜像,而那个镜像由 instanceConfig() 负责刷新。
  const [modeModule, { authGate }, { resourceGate }, { personalWriteGate }, { withHandoffActor }, { actorOf, ownerIdOf }] =
    await Promise.all([
      import("./auth/mode.js"),
      import("./auth/middleware.js"),
      import("./auth/resource-gate.js"),
      import("./auth/personal-gate.js"),
      import("./auth/handoff-outbound.js"),
      import("./auth/context.js"),
    ]);
  const instance = await modeModule.instanceConfig();
  if (instance.mode === "multi") {
    const { sweepExpiredSessions } = await import("./auth/store.js");
    await sweepExpiredSessions();
    console.log(`[ash] 多人模式：根目录 ${instance.rootDir}`);
  }
  // 测试库档第一次从主库播种，之后复用这个 worktree 自己的副本。
  if (process.env.ASH_SEED_FROM) {
    const { seedPreviewDb } = await import("./preview-seed.js");
    const mode = process.env.ASH_SEED_MODE === "config" ? "config" : "snapshot";
    await seedPreviewDb(process.env.ASH_SEED_FROM, mode);
  }
  // 测试库会持久，所以每次启动都重新洗运行态；不能只在首次播种时洗。
  if (IS_PREVIEW_INSTANCE) {
    const { sanitizeSnapshot } = await import("./preview-seed.js");
    const washed = await sanitizeSnapshot((await import("./db/index.js")).dbClient);
    console.log(`[ash] 预览库已洗运行态：${washed.join("、") || "无"}`);
  }
  const usageRepair = await (await import("./usage-repair.js")).repairLegacyUsageAccounting();
  if (!usageRepair.alreadyApplied) {
    console.log(
      `[ash] Token 历史账已校正：Codex ${usageRepair.repairedCodexSessions} 条，`
      + `Claude ${usageRepair.repairedClaudeSessions} 条，证据不足跳过 ${usageRepair.skippedSessions} 条`,
    );
  }
  await migrateQueues(); // 一次性把 legacy depends_on / resume_depends_on 迁到 queue_items（幂等）
  // **顺序不能反**：先把还活着的 agent 接管回来（它们的输出走文件，压根没随上
  // 一个 server 进程一起死），再 reconcile 剩下那些真被打断的。反过来的话，一个
  // 正在干活的 agent 会先被判 failed，用户一点重试就有第二个 agent 进同一个
  // worktree —— 那是数据损坏，不是显示问题。
  // 预览永远不接管、不结算真 agent。即使某份旧库没洗干净，这道硬闸也保证它不碰真进程。
  if (!IS_PREVIEW_INSTANCE) {
    await reattachRunningTasks();
    await reconcileInterrupted(); // recover tasks left "running"/"queued" by a previous crash/restart
    // 自由审查对账要排在 reattach 之后：它以「有没有接回的 reviewer 会话」为判据，
    // 收拾死在投递链上的 reviewing run（详见 free-workflow.ts reconcileFreeReviews）。
    const { reconcileFreeReviews } = await import("./free-workflow.js");
    await reconcileFreeReviews().catch((err) => console.error("[ash] 自由审查对账失败（不影响启动）:", err));
  }
  // 回收上一轮遗留的原始输出文件（纯传输介质，正文早已进 .md）。放在接管之后：
  // 它靠 sessions 判断哪些文件仍在用，接管完那份名单才是准的。best-effort。
  void sweepRunLogs()
    .then(({ removed, bytes }) => {
      if (removed) console.log(`[ash] 回收 ${removed} 个已结束运行的原始输出文件（${(bytes / 1048576).toFixed(1)} MB）`);
    })
    .catch((err) => console.error("[ash] 原始输出文件回收失败（不影响运行）:", err));
  stageModule.mountTaskStageRoutes(routesModule.api);
  acceptanceModule.mountTaskAcceptanceRoutes(routesModule.api);
  reviewModule.mountReviewRoutes(routesModule.api);
  // 人工替一站「自动验证」签字放行（验证器不认账时唯一的出路）。
  verifyOverrideModule.mountVerifyOverrideRoutes(routesModule.api);
  // 预览进程是 ash 主动起的长驻服务，判据全落在盘上（data/runs/<task>/preview.json），
  // 所以重启后照样收得掉：先扫一遍孤儿，之后定时收 idle 那一档。
  const { startPreviewSweeper } = await import("./preview.js");
  startPreviewSweeper();
  // 技能清单预热:第一次在输入框敲 `/` 之前就把磁盘扫完(冷扫 ~15ms,之后靠
  // mtime 指纹命中缓存)。best-effort,失败了请求那一刻自己会重扫。
  // 多人模式下缓存键带 userId(各人扫各自的 CLI 配置目录),所以要按人各热一遍 ——
  // 只热 null 那一份等于热了一个谁也用不到的条目。
  void (async () => {
    const [{ warmSkills }, { projects, users }] = await Promise.all([import("./skills.js"), import("./db/schema.js")]);
    const { db } = await import("./db/index.js");
    const { isMultiUser } = await import("./auth/mode.js");
    const userIds = (await isMultiUser())
      ? (await db.select({ id: users.id }).from(users)).map((u) => u.id)
      : [null];
    warmSkills((await db.select().from(projects)).map((p) => p.repoPath), userIds);
  })().catch(() => {});
  return {
    startScheduler: schedulesModule.startScheduler,
    api: routesModule.api,
    authGate,
    resourceGate,
    personalWriteGate,
    withHandoffActor,
    actorOf,
    ownerIdOf,
  };
}

const app = new Hono();
// 鉴权闸。**必须排在所有路由之前** —— 它是一张正面清单:公开的那几条逐条列在
// auth/middleware.ts 里,其余一律要身份。自用模式下它整体空转(§三)。
app.use("*", authGate());
// 认了身份之后紧接着认资源:`/api/tasks/:id/…` 这类路径一律先过可见性。逐条路由自己
// 查是漏不完的(那条轴上的端点分散在十几个文件里且还在长),所以做成横切的一道。
app.use("/api/*", resourceGate());
// 第三道:个人面资源的写侧。项目轴放行了不代表账号面也放行 —— agent 回合凭证在自己
// 项目里干活是合法的,但它不该拿 owner 的身份去改执行器/供应商/审查者这些**后续任务
// 会继承的配置**(auth/personal-gate.ts 顶部)。
app.use("/api/*", personalWriteGate());
// 出站接力的「我是谁」。一次接力是 ping → refs → import 好几个来回,分散在四五个文件
// 里,逐个传 ownerUserId 一定会漏 —— 漏掉的那条会不带 key 发出去,对端多人实例直接
// 拒收。做成一道横切的 AsyncLocalStorage,出站客户端自己去取(auth/handoff-outbound.ts)。
app.use("/api/*", async (c, next) => withHandoffActor(ownerIdOf(actorOf(c)), () => next()));
app.route("/api", api);

// 没被上面任何一条 api 路由认领的 `/api/*`,到这里就停,不许落到下方的 SPA 兜底。
// 兜底那条是 `app.get("/*")`,它会把 index.html 当 200 回给一个 GET 接口——前端
// `parseBody` 拿到一坨 HTML 字符串,报错报在离现场十万八千里的地方。POST 则会撞上
// Hono 默认的 `404 Not Found`(纯文本、没有 `error` 字段),前端只能显示
// 「404 请求失败」,看不出是"路由不存在"还是"资源不存在"。
// 这两种都指向同一个真实成因:**服务端跑的代码比前端旧**——web/dist 是从磁盘现读的
// (重新 build 就生效),server 得重新 build 且重启进程才换代码,一旦只做了前者,新界面
// 就会去调一个老服务端没有的接口。所以这里直接把成因说出来。
app.all("/api/*", (c) =>
  c.json({
    error: `接口 ${c.req.method} ${new URL(c.req.url).pathname} 不存在。` +
      `多半是服务端跑的代码比前端旧:重新 npm run build 并重启 ash 再试。`,
  }, 404));

// ── 待审视频预览(Tailscale 旁路)─────────────────────────────────────────────
// 待审 mp4 软链到仓库根的 review/ 下,手机经 Tailscale 直接开
// http://<tailnet-ip>:4317/review/current/ 审核,不必另起第二个服务。必须注册在下方
// catch-all "/*" 之前,否则被 SPA 兜底截走。SPA 那条 readFile 把整文件读进内存、不支持
// Range;视频大且要拖动进度,所以这里单独用 createReadStream 流式 + 解析 Range 返回 206。
// createReadStream 跟随软链,所以 review 目录放软链即可,无需拷贝原片。
// 根目录默认跟随 ash 项目(review/ 在仓库根下,迁机器也不失效);可用 ASH_REVIEW_ROOT
// 覆盖。src 与编译后的 dist 都在 server/ 下一层,../../ 均指向仓库根。
const REVIEW_ROOT = normalize(
  process.env.ASH_REVIEW_ROOT ?? fileURLToPath(new URL("../../review", import.meta.url)),
);
app.get("/review", (c) => c.redirect("/review/"));
app.get("/review/*", async (c) => {
  const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/review\/?/, "");
  const target = normalize(join(REVIEW_ROOT, rel));
  // 防路径穿越:解析后必须仍落在 ROOT 内(软链的"目标"可以在 ROOT 外——那正是本方案的关键)。
  // 分隔符走 `sep`:`normalize` 在 Windows 上还的是反斜杠,拼 `/` 比前缀恒为假,整个
  // /review/ 会全线 404(不是拒绝越界,是连界内的也进不去)。
  if (target !== REVIEW_ROOT && !target.startsWith(REVIEW_ROOT + sep)) return c.notFound();
  if (!existsSync(target)) return c.notFound();
  const st = statSync(target); // 跟随软链

  // 目录 → 极简清单页,手机点开就能播。
  if (st.isDirectory()) {
    const base = "/review/" + (rel ? rel.replace(/\/+$/, "") + "/" : "");
    const items = readdirSync(target)
      .filter((n) => n.toLowerCase().endsWith(".mp4"))
      .sort()
      .map((n) => {
        const href = base + encodeURIComponent(n);
        return `<li><a href="${href}">${n}</a><video controls preload="metadata" src="${href}"></video></li>`;
      })
      .join("\n");
    return c.html(
      `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
        `<title>待审视频</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:1rem;background:#111;color:#eee}` +
        `h2{font-size:1.1rem}ul{padding:0}li{list-style:none;margin:0 0 2rem}a{color:#6cf;word-break:break-all}` +
        `video{display:block;width:100%;max-width:760px;margin:.5rem 0;border-radius:8px;background:#000}</style>` +
        `<h2>待审视频 ${rel || "/"}</h2><ul>${items || "<li>(暂无 mp4)</li>"}</ul>`,
    );
  }

  // 文件:只放行 mp4,支持 Range 拖动。
  if (extname(target).toLowerCase() !== ".mp4") return c.notFound();
  const size = st.size;
  const range = c.req.header("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    if (start >= size || end >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(Readable.toWeb(createReadStream(target, { start, end })) as any, {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(Readable.toWeb(createReadStream(target)) as any, {
    status: 200,
    headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": String(size) },
  });
});

// Serve the built SPA in production. The path is resolved relative to this module
// (works regardless of cwd). API/review/mobile routes above remain higher-priority
// than the final web catch-all below.
const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const hasWebBuild = existsSync(join(WEB_DIST, "index.html"));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

// ── 手机预览(桌面端)──────────────────────────────────────────────────────────
// mobile(Expo)用 `npm run build:mobile`(= expo export -p web)出的静态站,同源挂在
// :4317 的 /mobile/app/ 下;再用 /mobile 一个手机外框页 iframe 套住它 —— 电脑浏览器里
// 点着看手机 app,不用开真机。同源 → 预览里的 app 直接连本机 :4317 拿数据(mobile
// config.ts 在 web 下默认用 location.origin)。app.json experiments.baseUrl="/mobile/app"
// 让导出资源路径落在这个子前缀下。改了 mobile 代码要重新 build:mobile 再刷新。
// 必须注册在下方 web/dist 的 "/*" catch-all 之前,否则被 SPA 兜底截走。
const MOBILE_DIST = fileURLToPath(new URL("../../mobile/dist", import.meta.url));
const hasMobile = existsSync(join(MOBILE_DIST, "index.html"));
const mobileMiss = "手机预览还没构建 —— 在仓库根跑 `npm run build:mobile` 生成 mobile/dist 后刷新。";

// 手机外框页:设备尺寸切换 + 刷新/首页,iframe 与本页同源所以能直接控制它。
const PHONE_FRAME = `<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Ash · 手机预览</title>
<style>
:root{--bg:#0C0E12;--panel:#161A20;--line:#2A2F38;--ink:#E6E9EE;--muted:#8B92A0;--accent:#5EE6C5}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(1200px 800px at 50% -10%,#12161d,#0C0E12);color:var(--ink);
font:14px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif;display:flex;flex-direction:column;align-items:center;gap:18px;padding:24px}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:center}
h1{font-size:16px;font-weight:600;margin:0;letter-spacing:.3px}
.seg{display:flex;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.seg button{background:transparent;border:0;color:var(--muted);padding:7px 12px;font:inherit;cursor:pointer}
.seg button.on{background:#1E232B;color:var(--ink)}
.btn{background:var(--panel);border:1px solid var(--line);color:var(--ink);padding:7px 12px;border-radius:10px;cursor:pointer;font:inherit}
.btn:hover{border-color:#3a4250}
.phone{position:relative;background:#000;border-radius:44px;padding:12px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px #222 inset}
.phone::before{content:"";position:absolute;top:14px;left:50%;transform:translateX(-50%);width:118px;height:26px;background:#000;border-radius:0 0 16px 16px;z-index:2}
iframe{display:block;border:0;border-radius:32px;background:var(--bg);width:390px;height:844px}
.hint{color:var(--muted);font-size:12px;max-width:480px;text-align:center}
.hint code{color:var(--accent);background:#11151b;padding:1px 6px;border-radius:5px}
</style></head><body>
<header><h1>Ash · 手机预览</h1>
<div class="seg" id="sizes"></div>
<button class="btn" onclick="reloadVp()">↻ 刷新</button>
<button class="btn" onclick="homeVp()">⌂ 首页</button></header>
<div class="phone"><iframe id="vp" src="/mobile/app/"></iframe></div>
<p class="hint">改了 mobile 代码后,仓库根跑 <code>npm run build:mobile</code> 重新构建,再点 ↻ 刷新。数据来自本机 :4317。</p>
<script>
var sizes=[['iPhone',390,844],['Pro Max',430,932],['小屏',360,780],['Android',412,915]];
var vp=document.getElementById('vp'),seg=document.getElementById('sizes');
function pick(i){var s=sizes[i];vp.style.width=s[1]+'px';vp.style.height=s[2]+'px';
[].forEach.call(seg.children,function(b,j){b.className=j===i?'on':''})}
function reloadVp(){try{vp.contentWindow.location.reload()}catch(e){vp.src=vp.src}}
function homeVp(){vp.src='/mobile/app/'}
sizes.forEach(function(s,i){var b=document.createElement('button');b.textContent=s[0];b.onclick=function(){pick(i)};seg.appendChild(b)});
pick(0);
</script></body></html>`;

app.get("/mobile", (c) => (hasMobile ? c.html(PHONE_FRAME) : c.text(mobileMiss, 503)));
// 缓存策略:HTML 一律 no-cache(否则浏览器启发式缓存会让用户在 build 后仍拿旧
// index.html → 旧 hash JS,「明明 build 了却看不到新效果」;2026-07-28 实锤过一次)。
// Vite 的 /assets/* 文件名带内容 hash,可以放心 immutable 长缓存。
const cacheHeader = (file: string): string =>
  extname(file) === ".html"
    ? "no-cache"
    : file.includes(`${sep}assets${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache";

async function serveSpa(c: Context, dist: string, rel: string) {
  const candidate = normalize(join(dist, rel));
  // 用 `sep` 而不是写死 `/`:Windows 上 `normalize` 还的是反斜杠,拼 `/` 比前缀恒为假,
  // 于是**每一个** js/css 都判成界外、统统回退 index.html——浏览器按 text/html 收到
  // 一份 HTML 当模块加载,整个前端白屏。判定本身没放松,只是让它在两个平台上都成立。
  const file =
    (candidate === dist || candidate.startsWith(dist + sep)) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
      ? candidate
      : join(dist, "index.html");
  const body = await readFile(file);
  return c.body(body, 200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": cacheHeader(file),
  });
}

app.get("/mobile/app", (c) => c.redirect("/mobile/app/"));
app.get("/mobile/app/*", async (c) => {
  if (!hasMobile) return c.text(mobileMiss, 503);
  const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/mobile\/app\/?/, "");
  const candidate = normalize(join(MOBILE_DIST, rel));
  if (candidate !== MOBILE_DIST && !candidate.startsWith(MOBILE_DIST + sep)) return c.notFound();
  // SPA 兜底:expo-router 的客户端路由路径(非真实文件)回退到 index.html。
  const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(MOBILE_DIST, "index.html");
  const body = await readFile(file);
  return c.body(body, 200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": cacheHeader(file),
  });
});

const webMiss = "Ash web build not found — run `npm -w web run build`.";
app.get("/*", (c) => {
  if (!hasWebBuild) return c.text(webMiss, 503);
  const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
  return serveSpa(c, WEB_DIST, rel);
});

// Bind the port before starting the scheduler. A process that cannot accept
// HTTP callbacks must never be allowed to poll schedules or launch agents.
activeServer = serve({ fetch: app.fetch, port }, (info) => {
  // PORT=0 的测试/临时实例在绑定后才知道真实端口；接力清单读取这个动态值，才能把
  // 可回连地址带给对端，而不是把不可用的 0 端口写进任务历史。只写模块内状态，不能
  // 改 process.env.PORT：应用内终端和 agent 都会继承它，前端 dev server 会误抢 ash 端口。
  recordListeningPort(info.port);
  // 预览实例**不跑调度器**：它连的是主库的快照，一条 cron 到点就会拿真项目目录去派活。
  // 快照压根没搬 schedules / scheduled_messages，这里是同一件事的第二道保险（成本一行）。
  if (IS_PREVIEW_INSTANCE) {
    console.log("[ash] 预览实例：调度器没启动（不会到点派活、不会到点发消息）");
  } else {
    try {
      startScheduler();
    } catch (e) {
      exitAfterStartupFailure("scheduler failed to start", e);
    }
  }
  startupComplete = true;
  console.log(`[ash] server on http://localhost:${info.port}`);
});

activeServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    exitAfterStartupFailure(portConflictMessage(port));
  }
  exitAfterStartupFailure("server listen failed", err);
});
