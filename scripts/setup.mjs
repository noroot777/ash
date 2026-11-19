#!/usr/bin/env node
// 在**新机器**上把 navi 装好:装依赖 → 构建 → 接好 MCP → 告诉你怎么起。
//
//   node scripts/setup.mjs           # 或 npm run setup
//   PORT=4317 node scripts/setup.mjs      # 换端口(MCP 里写的 URL 会跟着变)
//   SKIP_MCP=1 node scripts/setup.mjs     # 不动 ~/.claude.json 和 ~/.codex/config.toml
//   SKIP_BUILD=1 node scripts/setup.mjs   # 只装依赖、接 MCP,不构建
//
// 幂等:重复跑不会重复写配置,也不会覆盖已有的 navi MCP 条目。
//
// 为什么 MCP 这一步不能省:navi 起的 agent 是靠 navi MCP 的 complete_task 交卷的。
// 没接上 = 每个任务跑完都被判 failed(它压根没有那个工具可调)。
//
// 2026-08-14 从 setup.sh 改写成 .mjs:新机器上第一条命令必须是**每个平台都跑得动**的,
// 而 Windows 没有 bash。平台差异集中在 scripts/platform.mjs。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";
import { IS_WINDOWS, runCli as run, which, windowsLongPaths } from "./platform.mjs";
import { WORKSPACE_FAIL_HINT, inspectNpmConfig, inspectWorkspaces, npmConfigValue } from "./workspace-check.mjs";
import { registerNaviMcp } from "./mcp-register.mjs";
import { NODE_MIN, sqliteUsable } from "./runtime-check.mjs";
import { holdOrExit } from "./upgrade-lock.mjs";

// setup 必须能在声明支持的 Node 22.16 上裸跑；那一版不能无 flag 导入 .ts（MCP 登记那份同理，见 mcp-register.mjs）。

const REPO = fileURLToPath(new URL("..", import.meta.url));
process.chdir(REPO);
// 跟 upgrade / restart 互斥(upgrade-lock.mjs):它们也在装依赖、构建,插进来就是两边一起踩。
holdOrExit({ repo: REPO, note: "setup" });

const PORT = Number(process.env.PORT || 4317);
const URL_BASE = `http://localhost:${PORT}`;
let fail = 0;

const say = (line = "") => process.stdout.write(`${line}\n`);
const ok = (line) => say(`  ✓ ${line}`);
const warn = (line) => say(`  ⚠ ${line}`);
const bad = (line) => { say(`  ✕ ${line}`); fail = 1; };

function npm(args, opts = {}) {
  return spawnSync(NPM, args, { stdio: "inherit", ...NPM_SPAWN_OPTS, ...opts }).status ?? 1;
}

say("▶ 1/5 检查运行环境");

// 三个平台都是一等公民。Windows 上不再要求 WSL2 —— 用到的系统调用都在
// scripts/platform.mjs / server/src/platform.ts 里分了平台。
ok(`系统 ${process.platform} (${process.arch})`);

// Node 不比版本号,直接问能力(为什么见 runtime-check.mjs);版本号只在报错时出场,给个说得出口的目标。
if (sqliteUsable()) ok(`node v${process.versions.node}`);
else bad(`node v${process.versions.node} 带不动内置的 node:sqlite(Navi 的数据库),需要 >= ${NODE_MIN}(建议 24)`);

const npmVersion = run(NPM, ["-v"]);
if (npmVersion.status === 0) ok(`npm ${npmVersion.stdout.trim()}`);
else bad("没有 npm");

const gitVersion = run("git", ["--version"]);
if (gitVersion.status === 0) ok(`git ${gitVersion.stdout.trim().split(/\s+/)[2] ?? ""}`);
else bad("没有 git(worktree 隔离、审查 diff、验收合并全靠它)");

// Windows 的 MAX_PATH=260:worktree 落在 `<repo>\.worktrees\<taskId>`,里面再装一遍
// node_modules,不开长路径的话 `git worktree add` 会以 "Filename too long" 收场。
// 只警告不阻断 —— 路径够短的项目本来就不受影响,不该拦着人装。
const longPaths = windowsLongPaths();
if (longPaths?.registry && longPaths.git) {
  ok("长路径已开(系统开关 + git core.longpaths)");
} else if (longPaths) {
  warn("长路径没开全,worktree 深路径可能撞 MAX_PATH(260)。缺哪条补哪条:");
  if (!longPaths.registry) {
    say("      管理员 PowerShell:Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' LongPathsEnabled 1");
  }
  if (!longPaths.git) say("      git config --global core.longpaths true");
  say("      两条改完要重开终端;项目路径本来就短的话可以先不管。");
}

if (fail) {
  say();
  say("✕ 环境不满足,先把上面 ✕ 的装好再重跑。");
  process.exit(1);
}

say();
say("▶ 2/5 安装依赖(npm install,首次要几分钟)");

// 先自查 workspace 齐不齐,再开始下载。不齐的话 npm 会把 `@navi/*` 当公共包去
// registry 上找,报一条读起来像断网的 E404 —— 于是人去查代理、换镜像源,方向全反。
// 详见 scripts/workspace-check.mjs 顶部。
const ws = inspectWorkspaces(REPO);
for (const h of ws.hints) warn(h);
if (!ws.ok) {
  for (const p of ws.problems) bad(p);
  say();
  say("  ✕ 这份代码不完整,npm install 一定会失败(而且会报成 404)。");
  for (const line of WORKSPACE_FAIL_HINT) say(`     ${line}`);
  for (const line of ws.fix) say(`     ${line}`);
  process.exit(1);
}

// 再过一道 npm 配置闸(为什么两个入口都要过,见 workspace-check.mjs 里 inspectNpmConfig 的注释)。
const npmCfg = inspectNpmConfig();
for (const w of npmCfg.warnings) warn(w);
if (npmCfg.blockers.length) {
  for (const b of npmCfg.blockers) bad(b);
  process.exit(1);
}

if (npm(["install"]) !== 0) {
  // workspace 和上面两个配置都自查过了,剩下的成因基本在网络那一侧 —— 但别只丢一句
  // 「检查网络」:把现场一起打出来,用户能直接贴回来,不用再来回问「你 npm 几、registry 指哪」。
  const registry = npmConfigValue("registry") || "?";
  const proxy = npmConfigValue("https-proxy") || "(没设)";
  say("  ✕ npm install 失败。workspace 自查是通过的,所以多半真在网络这一侧:代理没配、");
  say("     registry 不通,或者 node-pty / libsql 的预编译产物下不来。");
  say(`     现场:npm ${npmVersion.stdout.trim()} · registry ${registry} · https-proxy ${proxy}`);
  say("     上面那条 npm 报错里有完整日志的路径,排错时连日志一起看。");
  process.exit(1);
}
ok("依赖装好");

if (!process.env.SKIP_BUILD) {
  say();
  say("▶ 3/5 构建(shared → web → server → mcp)");
  if (npm(["run", "build"]) !== 0) {
    say("  ✕ 构建失败,上面有报错。修完重跑 node scripts/setup.mjs");
    process.exit(1);
  }
  ok("构建完成(server 从磁盘读 web/dist,mcp/dist/index.js 已就位)");
} else {
  say();
  say("▶ 3/5 构建 —— SKIP_BUILD=1,跳过");
  if (!existsSync(join(REPO, "mcp/dist/index.js"))) warn("mcp/dist/index.js 不存在,MCP 接上了也起不来");
}

say();
say("▶ 4/5 接上 Navi MCP(agent 靠它交卷)");
if (process.env.SKIP_MCP) {
  warn("SKIP_MCP=1,跳过。之后在界面「设置 → 执行器」注册执行器时会补接,或按 docs/install.md 手接;没接上的任务跑完一律记 failed。");
} else {
  registerNaviMcp({ repo: REPO, port: PORT, ok, warn, say });
}

// git hooks:config 不随 clone/解包传播,必须每台机器执行一次。
if (existsSync(join(REPO, ".git"))) {
  if (run("git", ["config", "core.hooksPath", ".githooks"]).status === 0) ok("git hooks 已指向 .githooks");
  else warn("git config core.hooksPath 设置失败(不影响运行,只是少了两道提交闸和 push 前的前端回归闸)");
} else {
  warn("不是 git 仓库(压缩包解出来的通常如此)。Navi 本身能跑,但对**它自己这个仓库**做不了 worktree/diff/合并。");
  say("      想用完整能力:git init && git add -A && git commit -m init && git config core.hooksPath .githooks");
}

say();
say("▶ 5/5 检查可派活的 CLI");
let found = 0;
for (const cli of ["claude", "codex", "gemini", "cursor-agent", "opencode", "qwen", "copilot"]) {
  const path = which(cli);
  if (path) {
    say(`  ✓ ${cli} — ${path}`);
    found += 1;
  }
}
if (!found) {
  warn("一个 agent CLI 都没有。Navi 是**调度台**,自己不写代码,得先装至少一个并登录:");
  say("      npm install -g @anthropic-ai/claude-code   然后 claude   登录一次");
  say("      npm install -g @openai/codex               然后 codex    登录一次");
} else {
  say("  (界面「设置 → 执行器」里能看到完整目录和各自的安装命令)");
}

say();
say("✅ 装完了。起服务:");
say(`     npm start                 # 前台跑,:${PORT} 同时托管界面和 API`);
say(`     npm run restart           # 或:构建+后台常驻(日志 ${IS_WINDOWS ? "%TEMP%" : "/tmp"}/navi-${PORT}.log)`);
say();
say(`  然后浏览器开 ${URL_BASE} —— 第一件事是「新建项目」,填一个 git 仓库的绝对路径。`);
say(`  数据全在 ${join(REPO, "data")}(SQLite + run 产物),备份就备份这个目录。`);
say("  更多(升级、常驻、排错)见 docs/install.md");
