#!/usr/bin/env node
// 在**新机器**上把 harness 装好:装依赖 → 构建 → 接好 MCP → 告诉你怎么起。
//
//   node scripts/setup.mjs           # 或 npm run setup
//   PORT=4317 node scripts/setup.mjs      # 换端口(MCP 里写的 URL 会跟着变)
//   SKIP_MCP=1 node scripts/setup.mjs     # 不动 ~/.claude.json 和 ~/.codex/config.toml
//   SKIP_BUILD=1 node scripts/setup.mjs   # 只装依赖、接 MCP,不构建
//
// 幂等:重复跑不会重复写配置,也不会覆盖已有的 harness MCP 条目。
//
// 为什么 MCP 这一步不能省:harness 起的 agent 是靠 harness MCP 的 complete_task 交卷的。
// 没接上 = 每个任务跑完都被判 failed(它压根没有那个工具可调)。
//
// 2026-08-14 从 setup.sh 改写成 .mjs:新机器上第一条命令必须是**每个平台都跑得动**的,
// 而 Windows 没有 bash。平台差异集中在 scripts/platform.mjs。
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";
import { IS_WINDOWS, which, windowsLongPaths } from "./platform.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
process.chdir(REPO);

const PORT = Number(process.env.PORT || 4317);
const URL_BASE = `http://localhost:${PORT}`;
let fail = 0;

const say = (line = "") => process.stdout.write(`${line}\n`);
const ok = (line) => say(`  ✓ ${line}`);
const warn = (line) => say(`  ⚠ ${line}`);
const bad = (line) => { say(`  ✕ ${line}`); fail = 1; };

/**
 * 跑一条外部命令拿退出码和 stdout。
 *
 * Windows 上 `claude` / `codex` 落地成 `.cmd` 垫片,而 Node 自 CVE-2024-27980 起拒绝
 * 在没有 shell 的情况下执行批处理 —— 必须开 `shell: true`,于是参数要自己加引号
 * (家目录里有空格是常态)。这里的参数全是本脚本写死的字面量加路径,没有用户输入。
 */
function run(cmd, args, opts = {}) {
  const file = which(cmd) ?? cmd;
  const useShell = IS_WINDOWS && /\.(cmd|bat)$/i.test(file);
  const res = spawnSync(
    useShell ? `"${file}"` : file,
    useShell ? args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)) : args,
    { encoding: "utf8", windowsHide: true, shell: useShell, ...opts },
  );
  return { status: res.status ?? 1, stdout: res.stdout ?? "" };
}

function npm(args, opts = {}) {
  return spawnSync(NPM, args, { stdio: "inherit", ...NPM_SPAWN_OPTS, ...opts }).status ?? 1;
}

say("▶ 1/5 检查运行环境");

// 三个平台都是一等公民。Windows 上不再要求 WSL2 —— 用到的系统调用都在
// scripts/platform.mjs / server/src/platform.ts 里分了平台。
ok(`系统 ${process.platform} (${process.arch})`);

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) ok(`node v${process.versions.node}`);
else bad(`node v${process.versions.node} 太旧,需要 >= 20(建议 22 或更新)`);

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
if (npm(["install"]) !== 0) {
  say("  ✕ npm install 失败。常见原因:没网/代理没配/npm registry 不通。");
  process.exit(1);
}
ok("依赖装好");

if (!process.env.SKIP_BUILD) {
  say();
  say("▶ 3/5 构建(shared → web-next → server → mcp)");
  if (npm(["run", "build"]) !== 0) {
    say("  ✕ 构建失败,上面有报错。修完重跑 node scripts/setup.mjs");
    process.exit(1);
  }
  ok("构建完成(server 从磁盘读 web-next/dist,mcp/dist/index.js 已就位)");
} else {
  say();
  say("▶ 3/5 构建 —— SKIP_BUILD=1,跳过");
  if (!existsSync(join(REPO, "mcp/dist/index.js"))) warn("mcp/dist/index.js 不存在,MCP 接上了也起不来");
}

say();
say("▶ 4/5 接上 harness MCP(agent 靠它交卷)");
const mcpEntry = join(REPO, "mcp", "dist", "index.js");

if (process.env.SKIP_MCP) {
  warn("SKIP_MCP=1,跳过。稍后自己接(命令见 docs/install.md),否则任务跑完一律记 failed。");
} else {
  // ── claude ────────────────────────────────────────────────────────────────
  if (which("claude")) {
    const listed = run("claude", ["mcp", "list"]);
    if (/^harness:/m.test(listed.stdout)) {
      ok("claude:harness 已注册,不动它");
    } else {
      const added = run("claude", [
        "mcp", "add", "harness", "--scope", "user", "-e", `HARNESS_URL=${URL_BASE}`, "--", "node", mcpEntry,
      ]);
      if (added.status === 0) ok("claude:已注册 harness(user 作用域,编排别的仓库时也在)");
      else {
        warn("claude mcp add 失败,手动跑:");
        say(`      claude mcp add harness --scope user -e HARNESS_URL=${URL_BASE} -- node ${mcpEntry}`);
      }
    }
  } else {
    warn("没装 claude CLI,跳过它的 MCP 注册");
  }

  // ── codex ─────────────────────────────────────────────────────────────────
  const codexCfg = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  if (which("codex")) {
    const existing = existsSync(codexCfg) ? readFileSync(codexCfg, "utf8") : "";
    if (/^\[mcp_servers\.harness\]/m.test(existing)) {
      ok(`codex:harness 已在 ${codexCfg} 里,不动它`);
    } else {
      mkdirSync(dirname(codexCfg), { recursive: true });
      // 先备份再追加:改的是用户自己的配置文件,出错要能一键还原。
      const backup = `${codexCfg}.bak-harness-setup`;
      if (existing) copyFileSync(codexCfg, backup);
      // TOML 的字符串是转义的,Windows 路径里的 `\` 必须成对写,否则 `\d`、`\n`
      // 会被当转义序列吞掉 —— 装完看着成功,codex 起 MCP 时才报路径不存在。
      const tomlPath = JSON.stringify(mcpEntry);
      appendFileSync(
        codexCfg,
        `\n[mcp_servers.harness]\ncommand = "node"\nargs = [${tomlPath}]\n\n`
        + `[mcp_servers.harness.env]\nHARNESS_URL = "${URL_BASE}"\n`,
      );
      ok(`codex:已写入 ${codexCfg}${existing ? "(原文件备份在同名 .bak-harness-setup)" : ""}`);
    }
  } else {
    warn("没装 codex CLI,跳过它的 MCP 注册");
  }
}

// git hooks:config 不随 clone/解包传播,必须每台机器执行一次。
if (existsSync(join(REPO, ".git"))) {
  if (run("git", ["config", "core.hooksPath", ".githooks"]).status === 0) ok("git hooks 已指向 .githooks");
  else warn("git config core.hooksPath 设置失败(不影响运行,只是少两道提交闸)");
} else {
  warn("不是 git 仓库(压缩包解出来的通常如此)。harness 本身能跑,但对**它自己这个仓库**做不了 worktree/diff/合并。");
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
  warn("一个 agent CLI 都没有。harness 是**调度台**,自己不写代码,得先装至少一个并登录:");
  say("      npm install -g @anthropic-ai/claude-code   然后 claude   登录一次");
  say("      npm install -g @openai/codex               然后 codex    登录一次");
} else {
  say("  (界面「设置 → 执行器」里能看到完整目录和各自的安装命令)");
}

say();
say("✅ 装完了。起服务:");
say(`     npm start                 # 前台跑,:${PORT} 同时托管界面和 API`);
say(`     npm run restart           # 或:构建+后台常驻(日志 ${IS_WINDOWS ? "%TEMP%" : "/tmp"}/harness-${PORT}.log)`);
say();
say(`  然后浏览器开 ${URL_BASE} —— 第一件事是「新建项目」,填一个 git 仓库的绝对路径。`);
say(`  数据全在 ${join(REPO, "data")}(SQLite + run 产物),备份就备份这个目录。`);
say("  更多(升级、常驻、排错)见 docs/install.md");
