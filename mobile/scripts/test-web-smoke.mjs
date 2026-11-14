// SDK 升级后的渲染冒烟：把 worktree 自己的 `mobile/dist`（expo export -p web 的产物）
// 挂在临时端口上，用 headless Chromium 逐条路由打开，断言「React 真的挂载出了内容」且
// 控制台没有报错。
//
// 为什么不直接看 :4317/mobile —— 那个 live 服务读的是**主仓**的 mobile/dist，在 worktree
// 里 build 对它零影响，拿它验证等于验了别人的产物。
//
// /api 由本脚本内置的假后端应答（导出产物在 web 下用 location.origin 当后端），给一个项目、
// 一条任务，让列表页有真东西可渲染。不反代 :4317：回归测试不许连 live 服务，live 不在时
// 502 会被当成控制台报错，测的就成了「:4317 开没开」。
import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chromeLaunchOptions } from "../../web/scripts/chrome-path.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

// playwright-core 挂在**仓库根**的 node_modules（web 的 devDependency，被 npm workspaces
// 提升上去了）。worktree 通常不装根依赖，所以解析不到时回落到主检出那份 —— git 的
// common-dir 指向主仓的 .git，它的上一级就是主检出根。
function resolvePlaywright() {
  const roots = [join(HERE, "..", "..")];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: HERE,
      encoding: "utf8",
    }).trim();
    roots.push(join(common, ".."));
  } catch {
    /* 不在 git 仓库里就只试当前根 */
  }
  for (const root of roots) {
    try {
      return createRequire(join(root, "package.json")).resolve("playwright-core");
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error("找不到 playwright-core —— 在仓库根跑一次 `npm install`");
}

// require.resolve 命中的是 CJS 入口（package.json 的 main），动态 import 后具名导出不一定
// 被识别出来，兜一层 default。
const pw = await import(resolvePlaywright());
const chromium = pw.chromium ?? pw.default?.chromium;
if (!chromium) throw new Error("playwright-core 没有导出 chromium");

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const BASE = "/mobile/app";
const at = new Date().toISOString();
const PROJECT = {
  id: "smoke", name: "冒烟项目", repoPath: "/tmp/ash-mobile-smoke", browserCdpDomains: [], createdAt: at,
  health: { exists: true, isRepo: true }, myRole: "admin",
};
const TASK = {
  id: "smoke-task", projectId: PROJECT.id, title: "冒烟任务", body: "渲染冒烟", mode: "single", status: "done",
  agentType: "codex", parentId: null, groupId: null, executorId: null, model: null, reasoningEffort: null, archived: false,
  workflowMode: "free", stage: "none", labels: [], createdAt: at, updatedAt: at, endedAt: at, question: null, resumePrompt: null,
};

// 只覆盖这几屏开机就会拉的接口；其余一律给空对象，形状不对页面自己会报 pageerror。
function fixture(path) {
  if (path === "/api/health") return { ok: true, ts: at };
  if (path === "/api/auth/state") return {};
  if (path === "/api/projects") return [PROJECT];
  if (path === "/api/tasks") return [TASK];
  if (path === "/api/skills") return { skills: [], cliCommands: [] };
  if (/^\/api\/projects\/[^/]+\/branches$/.test(path)) return { branches: ["main"], current: "main" };
  if (["/api/groups", "/api/agents", "/api/llm-providers", "/api/agents/detect", "/api/agents/models"].includes(path)) return [];
  if (process.env.SMOKE_DEBUG) console.log("    [fixture] 未覆盖", path);
  return {};
}
const ROUTES = ["/", "/groups", "/new", "/settings", "/project-new"];
// 首页得真把假后端给的那条任务渲染出来，才算数据链路通了，而不只是空壳挂载。
const EXPECT = { "/": "冒烟任务" };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

async function send(res, path) {
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/api")) {
    const body = fixture(url.pathname);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
    return;
  }

  // 剥掉 experiments.baseUrl 前缀，映射到 dist 里的实际文件。
  let rel = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : url.pathname;
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  if (rel === "" || rel === "/") rel = "/index.html";

  if (await send(res, join(DIST, rel))) return;
  if (await send(res, join(DIST, rel + ".html"))) return;
  res.writeHead(404).end("not found");
});

try {
  await access(join(DIST, "index.html"));
} catch {
  console.error(`没有导出产物 ${DIST}/index.html —— 先在仓库根跑 \`npm run build:mobile\``);
  process.exit(1);
}

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

// 用本机 Chrome（与仓库其它 DOM 测试同一套候选表），不依赖 playwright 下载的浏览器缓存。
const browser = await chromium.launch(await chromeLaunchOptions());
const failures = [];

for (const route of ROUTES) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  const target = `${origin}${BASE}${route}`;
  try {
    await page.goto(target, { waitUntil: "networkidle", timeout: 30_000 });
    // 静态渲染会先吐出 HTML 骨架，真正要确认的是 hydration 之后 JS 仍在跑：
    // 等到 body 里有非空文本，且没有 Expo 的错误覆盖层。
    await page.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 0, { timeout: 15_000 });
    const text = (await page.locator("body").innerText()).trim();
    if (!text) failures.push(`${route}: 渲染为空`);
    if (EXPECT[route] && !text.includes(EXPECT[route])) failures.push(`${route}: 没渲染出「${EXPECT[route]}」`);
    if (errors.length) failures.push(`${route}: 控制台报错 -> ${errors.slice(0, 3).join(" | ")}`);
    console.log(`  ${errors.length ? "✖" : "✓"} ${route.padEnd(14)} ${text.length} 字符`);
  } catch (err) {
    failures.push(`${route}: ${err.message.split("\n")[0]}`);
    console.log(`  ✖ ${route.padEnd(14)} ${err.message.split("\n")[0]}`);
  }
  await page.close();
}

await browser.close();
server.close();

if (failures.length) {
  console.error("\n冒烟失败:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("\n全部路由渲染正常。");
