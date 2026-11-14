import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODE_DIR, dataRootFor } from "./data-root.js";

export { CODE_DIR };

// 代码根**是 git 检出时**才有值。两处要问「这台 ash 自己的仓库」：preview-access.ts 判断被
// 预览的项目是不是 ash 自己，review/ 目录的默认位置。独立 app 跑在 bundle 里，代码根不是任何
// 人的仓库，这时答「没有」—— 拿 bundle 路径去比项目路径只会永远不等，但语义上是在撒谎。
export const REPO_DIR: string | null = existsSync(join(CODE_DIR, ".git")) ? CODE_DIR : null;

export const DATA_DIR = dataRootFor(process.env);
// 读完就从本进程环境里拿掉：agent、预览、终端、git 子进程都是 `{...process.env}` 起的，
// 留着的话，agent 在某个 ash 检出里起一台验证用的 server，它就会把这份数据目录当成自己的
// （开同一个库、写同一份 runs）。需要它的子进程（回归 worker）由起它的地方显式传。
delete process.env.ASH_DATA_DIR;
// 只给真库测试用：流程测试会写时间线/验证证据，不能污染正式 data/runs。
export const RUNS_DIR = process.env.ASH_RUNS_DIR
  ? resolve(process.env.ASH_RUNS_DIR)
  : join(DATA_DIR, "runs");
// 预览实例专用的**只读**回退目录（`ASH_RUNS_FALLBACK`，指向主仓的 data/runs）。
//
// 为什么需要它：会话正文和 trace 是**文件**，不在库里。预览库是主库的快照，所以任务和
// 会话行都在，点开却是一片空白——而 token 芯片、每回合用时这些恰恰都长在正文里。
//
// 为什么是「回退」而不是把 RUNS_DIR 整个指过去：指过去的话，预览里对着一个历史任务随手
// 发一句话，就会往**主仓**那个任务的 .md 里追加一段——你回到主界面会看到自己没说过的
// 对话。读回退、写照旧落自己的 data/runs，预览就只能看、不能改。
export const RUNS_FALLBACK_DIR = process.env.ASH_RUNS_FALLBACK?.trim() || null;
// Pasted/uploaded images. Agents can't take binary on stdin, so we persist the
// file here and pass its absolute path in the prompt for the agent to Read.
// ASH_UPLOADS_DIR 只给测试用:接力测试的两个实例各需一份隔离的 uploads 目录。
export const UPLOADS_DIR = process.env.ASH_UPLOADS_DIR
  ? resolve(process.env.ASH_UPLOADS_DIR)
  : join(DATA_DIR, "uploads");
// ash 自己给预览备的 node 依赖（见 preview-deps.ts 顶部）。**关键是它在用户项目之外**：
// 依赖装在这儿，任务工作区只挂一条软链，用户的检出一个字节都不会被写。
// ASH_DEPS_DIR 只给测试用。
export const DEPS_DIR = process.env.ASH_DEPS_DIR
  ? resolve(process.env.ASH_DEPS_DIR)
  : join(DATA_DIR, "deps");
