// `npm run dev` 被人手调用时照旧启动 4317 + 前端；被 ash 预览站调用时，
// `PORT` 是借来的前端端口，`ASH_PREVIEW_MODE` 是页面上选的启动方式：
//
//   frontend  只起这个 worktree 的前端，/api 打回本机 4317
//   full      起这个 worktree 的前后端，用 `<worktree>/data/preview-empty.db`，只播种设置
//   test      起这个 worktree 的前后端，用 `<worktree>/data/preview.db`，首次从主库播种
//   command   项目自定义；对本脚本来说沿用 test 这个安全默认
//
// 每个 worktree 的 DB 文件路径不同，所以各预览后端可并行；单实例锁仍保证同一份库
// 不会被两个 server 同时调度。测试库每次启动都洗掉 pid/running/定时任务，预览实例也
// 无条件禁用调度器、接管与合并清理。
//
// **预览里的 agent 够不着预览这台 ash 的 MCP**，这条得先说清楚，不然会以为坏了：
// ash MCP 是注册在用户 `~/.claude.json` 里的，那条记录写死了
// `env: {ASH_URL: "http://localhost:4317"}`；而 claude 只把配置里列的 env 交给 MCP
// 子进程，**不传父进程的环境变量**（实测：父进程设的 ASH_URL / 自定义变量在 MCP
// 子进程的 environ 里根本不出现）。所以预览里跑的任务，`complete_task` 一定打去主实例、
// 拿一个 404 —— 严格完成协议下每个任务都会以 failed 收场。于是预览走既有的逃生口
// `ASH_LAX_DONE=1`（「接没配 ash MCP 的 agent 时用」，正是这个情形）：exit 0 即
// done，同时完成协议的前言也不再发（做不到的指令不如不说，见 single-run.ts）。
// 代价说在明处：预览里 ask_question / report_stage 这些 MCP 工具同样不通。要连它们一起
// 修，得让 ash 每次起 CLI 时自带 mcp 配置，那是另一件事、另一个爆炸半径。
import "./env.mjs";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
let tracked = [];
let down = false;

async function main() {
  const lent = process.env.PORT;
  if (!lent) {
    const child = spawn(NPM, ["run", "dev:all"], { stdio: "inherit", ...NPM_SPAWN_OPTS });
    child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
    return;
  }
  const requested = process.env.ASH_PREVIEW_MODE;
  const mode = requested === "frontend" || requested === "full" || requested === "test" ? requested : "test";
  if (mode === "frontend") startFrontendOnly(Number(lent));
  else await startPreviewStack(Number(lent), mode);
}

function webDevArgs(webPort) {
  // 不能只靠 worktree 里的 vite.config.ts：任务被清理后配置文件会消失，仍存活的 vite
  // 会按默认 localhost/5173 重启，继而与 127.0.0.1:5173 形成 IPv4/IPv6 同号双占。
  // CLI 参数在配置热重载时仍保留；strictPort 则保证借来的端口若被抢，只失败、不漂移。
  return [
    "-w", "web", "run", "dev", "--",
    "--host", "127.0.0.1", "--port", String(webPort), "--strictPort",
  ];
}

function startFrontendOnly(webPort) {
  const proxy = process.env.ASH_PROXY ?? "http://127.0.0.1:4317";
  console.log(`[dev] 预览：只起前端 ${webPort}，/api 打到 ${proxy}。`);
  const web = spawn(NPM, webDevArgs(webPort), {
    cwd: REPO,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(webPort),
      ASH_PROXY: proxy,
      VITE_ASH_PREVIEW: "预览实例 · 只启动这个分支的前端 · API 连本机 4317",
    },
    ...NPM_SPAWN_OPTS,
  });
  watchChildren([["前端", web]]);
}

async function startPreviewStack(webPort, mode) {
  const apiPort = await freePort();
  if (!apiPort) {
    console.error("[dev] 借不到端口给预览的后端，这一站起不来。");
    process.exit(1);
  }
  const mainData = mainRepoDataDir();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const ownDb = mode === "full" ? "preview-empty.db" : "preview.db";
  const dbFile = process.env.ASH_DB || fileURLToPath(new URL(`../data/${ownDb}`, import.meta.url));
  const firstBoot = !existsSync(dbFile);
  const seedFrom = process.env.ASH_SEED_FROM
    ?? (firstBoot ? join(mainData, "ash.db") : "");
  const seedMode = process.env.ASH_SEED_MODE ?? (mode === "full" ? "config" : "snapshot");
  const dbLabel = mode === "test"
    ? `${dbFile}，${firstBoot ? "首次从主库播种" : "复用这个 worktree 的测试数据"}`
    : `${dbFile}，${firstBoot ? "首次只播种设置" : "复用这个 worktree 的独立数据"}`;
  console.log(
    `[dev] 预览：整套起——后端 ${apiPort}（独立库 ${dbLabel}）、`
    + `前端 ${webPort}，前端的 /api 打到后端。`,
  );

  // ASH_URL 要跟着传：agent 进程继承 server 的环境变量，ash MCP 就靠它知道
  // 「complete_task 该报给谁」。不传的话预览里跑的任务会去敲本机那份 4317。
  // ASH_SEED_FROM：开局从主库拷一份快照过来（见文件头）。
  // ASH_RUNS_FALLBACK：历史会话的正文/trace 是文件不是库行，只读回退到主仓那份。
  // ASH_PREVIEW：告诉后端「你是预览」——不启动调度器，不许合并/删 worktree/删分支。
  // ASH_LAX_DONE：预览里退回「exit 0 即 done」，理由见下面 MCP 那段。
  // 前四个用 `??` 让外面覆盖得了（`??` 而不是 `||`：空串是「不要播种」这个明确意思）；
  // 后两个是闸不是配置，一律写死——外面能关掉的闸不叫闸。
  const api = spawn(NPM, ["-w", "server", "run", "dev"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(apiPort),
      ASH_DB: dbFile,
      ASH_URL: apiUrl,
      ASH_SEED_FROM: seedFrom,
      ASH_SEED_MODE: seedMode,
      ASH_RUNS_FALLBACK: process.env.ASH_RUNS_FALLBACK ?? join(mainData, "runs"),
      ASH_PREVIEW: "1",
      ASH_LAX_DONE: "1",
    },
    ...NPM_SPAWN_OPTS,
  });
  forward(api.stdout);
  forward(api.stderr);

  const web = spawn(NPM, webDevArgs(webPort), {
    cwd: REPO,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(webPort),
      ASH_PROXY: apiUrl,
      VITE_ASH_PREVIEW: mode === "test"
        ? "预览实例 · 这个分支的前端 + 后端 · 自己的测试库快照"
        : "预览实例 · 这个分支的前端 + 后端 · 自己的独立新库",
    },
    ...NPM_SPAWN_OPTS,
  });

  watchChildren([["后端", api], ["前端", web]]);
}

function watchChildren(children) {
  tracked = children;
  for (const [name, child] of children) {
    child.on("exit", (code, signal) => {
      console.error(`[dev] 预览的${name}退出了（code=${code} signal=${signal ?? "-"}），整套一起收。`);
      teardown();
    });
    child.on("error", (error) => {
      console.error(`[dev] 预览的${name}起不来：${error.message}`);
      teardown();
    });
  }
  process.on("SIGINT", teardown);
  process.on("SIGTERM", teardown);
}

/**
 * 主仓的 `data/` 在哪：预览跑在 worktree 里，`<worktree>/data/` 是空的，主库和一千个
 * 历史 run 目录都在**主仓**。`--git-common-dir` 在 worktree 里指回主仓的 `.git`，取它的
 * 上一级就是主仓根；不是 worktree（你自己 `npm run dev`）时它指向本仓的 `.git`，答案一样对。
 */
function mainRepoDataDir() {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return join(dirname(gitDir), "data");
  } catch {
    return join(REPO, "data"); // 不是 git 仓库就按本地猜一个，搬不到就搬不到
  }
}

/**
 * 收摊得收干净：npm 不会把信号往下传给它拉起的 `tsx watch` / vite，逐个 `child.kill()`
 * 必留孤儿（一个 dev server 占着端口没人管）。而预览这条路上整棵树都在同一个进程组里
 * （preview.ts 用 `sh -lc` detached 起的那个组），所以直接对**整组**发信号——一发全中，
 * 包括我们自己，正好就是「一个死了整套收」。只在预览分支这么干：你自己开发时那个组是
 * 终端的前台作业组，轰整组会连着把别的东西一起带走。
 *
 * Windows 上没有进程组信号（`process.kill(0, …)` 打不出去），换成对每个直接子进程
 * `taskkill /T /F`——它靠 ppid 关系往下走，够得着 npm → tsx/vite 这一层。
 */
function teardown() {
  if (down) return;
  down = true;
  if (process.platform === "win32") {
    for (const [, child] of tracked) {
      if (!child.pid) continue;
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch { /* 已经没了 */ }
    }
  } else {
    try { process.kill(0, "SIGTERM"); } catch { /* 组已经空了 */ }
  }
  setTimeout(() => process.exit(1), 300);
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(null));
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 后端的日志按行转出去，顺手把 `http://` 去掉。
 *
 * 不是嫌它长：预览的就绪判定挑的是日志里第一个 `http://localhost:...`，而后端那行
 * `[ash] server on http://localhost:<port>` 多半比 vite 先打出来——照原样转，用户点开
 * 预览会落到 API 上（一片 JSON）。去掉 scheme 就不再匹配那条正则，人还是读得懂。
 */
function forward(stream) {
  let buf = "";
  stream.setEncoding("utf8");
  const emit = (line) => process.stdout.write(`[api] ${line.replace(/https?:\/\//g, "")}\n`);
  stream.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) emit(line);
  });
  stream.on("end", () => { if (buf) emit(buf); });
}

// 入口放在全部状态初始化和函数声明之后。预览分支会同步调用 watchChildren；放在文件
// 顶部会在 tracked/down 仍处于 TDZ 时先拉起 vite、随后自己崩掉，把 vite 留成孤儿。
await main();
