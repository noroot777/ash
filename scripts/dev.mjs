// `npm run dev` 有两个调用方，要的东西不一样：
//
//   · 你自己开发 —— 后端（4317）+ 前端一起起。原来的行为，一点没变。
//   · harness 的预览站（`server/src/preview.ts`）—— 它在任务自己的 worktree 里跑这条
//     命令，并借一个空闲端口用环境变量 `PORT` 递进来。这种时候起**整套**：这个分支的
//     后端 + 这个分支的前端，前端的 `/api` 打到前者，两个都是 worktree 里的代码。
//
// 判据用 `PORT` 而不是另开一个变量：借端口这件事本身就是「有人在替我起预览」的信号，
// 而 `PORT` 是 harness 唯一注入的那一个（来由见 preview.ts 里 freePort 的注释）。
//
// **为什么不再只起前端**（2026-08-07 改掉的旧做法）：前端的 `/api` 默认 proxy 到本机
// 那份 4317，于是预览是「新前端 + 旧后端」。凡是需要后端配合的改动（新字段、新接口）
// 在预览里一律看不见，而且**失败得静悄悄**——接口照常 200，只是少一个字段，前端按
// 「没有就不显示」处理，看上去跟功能没做一模一样。用户对着这样的预览验收，结论是错的。
//
// 旧做法列的三个坎，各自的解法：
//   ① 后端端口写死 4317 → 这里自己借第二个空闲端口，不走 `dev:server`。
//   ② 同一个库只允许一个 server（锁的粒度是 **DB 文件路径**，见 server/src/singleton.ts）
//      → 所有 harness 预览共用主仓 `data/preview-test.db`；主 harness 起新预览前先收掉旧的。
//   ③ 后端启动那行 `http://localhost:<port>` 会被就绪判定当成预览地址（它挑日志里第一个
//      地址）→ 转发时把 scheme 去掉，见 forward()。
//
// 预览的库是**主库创建的持久测试副本**（主仓 `data/preview-test.db`），不是空库、
// 也不是主库本身。第一次从主库播种，之后预览里的改动会保留；每次启动只清理运行态。
//
//   · 不能共用主库文件：单实例锁的粒度就是 DB 文件路径（server/src/singleton.ts）。真让
//     两个 server 开同一个库，第二个照样 30s tick、照样拉起 agent，而它的子进程只在它自己
//     内存里——主界面点停止停不掉它（`docs/incidents.md`「端口撞车产幽灵」）。
//   · 不能是空库：一个执行器都没有，新建任务面板直接写着「还没有已注册执行器」，创建按钮
//     是灰的；任务列表也空空如也，凡是得有数据才看得见的改动（token 计数就是）一概验不了。
//   · 所以是持久副本 + 每次洗运行态：running 任务、会话上的真 pid 会被洗掉，并且压根不留
//     schedules/scheduled_messages（白名单和洗法在 server/src/preview-seed.ts）。
//
// 快照兜不住的两处，另外堵：①任务行带着**真** worktree 路径和分支名 → 预览实例上合并/删
// worktree/删分支一律拒绝，调度器也不启动（server/src/preview-instance.ts）；②会话正文是
// 文件不是库行 → `HARNESS_RUNS_FALLBACK` 让预览**只读**回退到主仓的 data/runs，写照旧落
// 自己的（paths.ts / transcript.ts），所以预览里对老任务说话不会污染真实历史。
//
// **想换个花样，改预览站那一格的命令就行，不用碰这里**——那一格本来就是一条 shell 命令：
//
//   npm -w web-next run dev                 只起前端，/api 打回本机 4317 的真数据（老行为）
//   npm run dev                             整套 + 共享持久测试库（默认）
//   HARNESS_SEED_MODE=config npm run dev    整套，但只搬设置不搬任务（快照出问题时的退路）
//   HARNESS_SEED_FROM= npm run dev          整套，空库
//   HARNESS_DB=/tmp/我的.db npm run dev      整套，用你自己的库（不清空、不播种覆盖）
//
// 刻意**不**把这几档做成起手式上的复选框：预览站是所有项目共用的（Go、Rails、静态站都在
// 用它），而「前端/后端/测试库」是 harness 自己的项目结构——做成字段，别的项目那几格永远
// 空着还得挨个解释。通用层只存命令，项目特有的花样归项目自己的脚本认，就是这条分界。
//
// **预览里的 agent 够不着预览这台 harness 的 MCP**，这条得先说清楚，不然会以为坏了：
// harness MCP 是注册在用户 `~/.claude.json` 里的，那条记录写死了
// `env: {HARNESS_URL: "http://localhost:4317"}`；而 claude 只把配置里列的 env 交给 MCP
// 子进程，**不传父进程的环境变量**（实测：父进程设的 HARNESS_URL / 自定义变量在 MCP
// 子进程的 environ 里根本不出现）。所以预览里跑的任务，`complete_task` 一定打去主实例、
// 拿一个 404 —— 严格完成协议下每个任务都会以 failed 收场。于是预览走既有的逃生口
// `HARNESS_LAX_DONE=1`（「接没配 harness MCP 的 agent 时用」，正是这个情形）：exit 0 即
// done，同时完成协议的前言也不再发（做不到的指令不如不说，见 single-run.ts）。
// 代价说在明处：预览里 ask_question / report_stage 这些 MCP 工具同样不通。要连它们一起
// 修，得让 harness 每次起 CLI 时自带 mcp 配置，那是另一件事、另一个爆炸半径。
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const lent = process.env.PORT;
if (!lent) {
  const child = spawn("npm", ["run", "dev:all"], { stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
} else {
  await startPreviewStack(Number(lent));
}

async function startPreviewStack(webPort) {
  const apiPort = await freePort();
  if (!apiPort) {
    console.error("[dev] 借不到端口给预览的后端，这一站起不来。");
    process.exit(1);
  }
  const mainData = mainRepoDataDir();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  // 下面这三样**外面给了就听外面的**。预览站那一格存的就是一条 shell 命令，所以
  // `HARNESS_DB=/tmp/我的测试库.db npm run dev` 天然能表达「这次用我自己的库」——
  // 不必为此在起手式上多开一个字段（那种字段对非 harness 项目永远是空的，见文件头）。
  //   · HARNESS_DB       换一个库。默认是主仓共享的 preview-test.db，任何一档都不自动删库。
  //   · HARNESS_SEED_FROM 换源库；显式给空串 = 起一个空库（server 端判的是非空）。
  //   · HARNESS_SEED_MODE server 端已经认（`config` = 只搬设置不搬任务），这里原样透传。
  // 指到主库本身会被单实例锁挡下来（锁的粒度就是 DB 文件路径），后端起不来、整套一起收，
  // 理由写在 preview.log 第一屏——这正是我们要的结果，不额外拦一道。
  const dbFile = process.env.HARNESS_DB || join(mainData, "preview-test.db");
  const firstBoot = !existsSync(dbFile);
  console.log(
    `[dev] 预览：整套起——后端 ${apiPort}（持久测试库 ${dbFile}，${firstBoot ? "首次从主库播种" : "复用现有数据，不自动清空"}）、`
    + `前端 ${webPort}，前端的 /api 打到后端。`,
  );

  // HARNESS_URL 要跟着传：agent 进程继承 server 的环境变量，harness MCP 就靠它知道
  // 「complete_task 该报给谁」。不传的话预览里跑的任务会去敲本机那份 4317。
  // HARNESS_SEED_FROM：开局从主库拷一份快照过来（见文件头）。
  // HARNESS_RUNS_FALLBACK：历史会话的正文/trace 是文件不是库行，只读回退到主仓那份。
  // HARNESS_PREVIEW：告诉后端「你是预览」——不启动调度器，不许合并/删 worktree/删分支。
  // HARNESS_LAX_DONE：预览里退回「exit 0 即 done」，理由见下面 MCP 那段。
  // 前四个用 `??` 让外面覆盖得了（`??` 而不是 `||`：空串是「不要播种」这个明确意思）；
  // 后两个是闸不是配置，一律写死——外面能关掉的闸不叫闸。
  const api = spawn("npm", ["-w", "server", "run", "dev"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(apiPort),
      HARNESS_DB: dbFile,
      HARNESS_URL: apiUrl,
      HARNESS_SEED_FROM: process.env.HARNESS_SEED_FROM ?? (firstBoot ? join(mainData, "harness.db") : ""),
      HARNESS_RUNS_FALLBACK: process.env.HARNESS_RUNS_FALLBACK ?? join(mainData, "runs"),
      HARNESS_PREVIEW: "1",
      HARNESS_LAX_DONE: "1",
    },
  });
  forward(api.stdout);
  forward(api.stderr);

  const web = spawn("npm", ["-w", "web-next", "run", "dev"], {
    cwd: REPO,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(webPort),
      HARNESS_PROXY: apiUrl,
      VITE_HARNESS_PREVIEW: "预览实例 · 这个分支的前端 + 后端 · 共享持久测试库（改不到真数据；不能验收/删分支）",
    },
  });

  for (const [name, child] of [["后端", api], ["前端", web]]) {
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

let down = false;
/**
 * 收摊得收干净：npm 不会把信号往下传给它拉起的 `tsx watch` / vite，逐个 `child.kill()`
 * 必留孤儿（一个 dev server 占着端口没人管）。而预览这条路上整棵树都在同一个进程组里
 * （preview.ts 用 `sh -lc` detached 起的那个组），所以直接对**整组**发信号——一发全中，
 * 包括我们自己，正好就是「一个死了整套收」。只在预览分支这么干：你自己开发时那个组是
 * 终端的前台作业组，轰整组会连着把别的东西一起带走。
 */
function teardown() {
  if (down) return;
  down = true;
  try { process.kill(0, "SIGTERM"); } catch { /* 组已经空了 */ }
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
 * `[harness] server on http://localhost:<port>` 多半比 vite 先打出来——照原样转，用户点开
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
