import { fileURLToPath } from "node:url";

// 仓库根。`data/` 之外还有一处要用它：判断某个 `node …/mcp/dist/index.js` 子进程
// 是不是**本仓库这份** harness MCP（mcp-holders.ts）。
export const REPO_DIR = fileURLToPath(new URL("../..", import.meta.url));

// Anchor data to <repo>/data regardless of launch cwd, so the DB and run
// artifacts live in one place whether started via `npm start`, `npm -w server`,
// or `tsx` in dev (fixes the cwd-dependent data location).
export const DATA_DIR = fileURLToPath(new URL("../../data", import.meta.url));
export const RUNS_DIR = fileURLToPath(new URL("../../data/runs", import.meta.url));
// 预览实例专用的**只读**回退目录（`HARNESS_RUNS_FALLBACK`，指向主仓的 data/runs）。
//
// 为什么需要它：会话正文和 trace 是**文件**，不在库里。预览库是主库的快照，所以任务和
// 会话行都在，点开却是一片空白——而 token 芯片、每回合用时这些恰恰都长在正文里。
//
// 为什么是「回退」而不是把 RUNS_DIR 整个指过去：指过去的话，预览里对着一个历史任务随手
// 发一句话，就会往**主仓**那个任务的 .md 里追加一段——你回到主界面会看到自己没说过的
// 对话。读回退、写照旧落自己的 data/runs，预览就只能看、不能改。
export const RUNS_FALLBACK_DIR = process.env.HARNESS_RUNS_FALLBACK?.trim() || null;
// Pasted/uploaded images. Agents can't take binary on stdin, so we persist the
// file here and pass its absolute path in the prompt for the agent to Read.
export const UPLOADS_DIR = fileURLToPath(new URL("../../data/uploads", import.meta.url));
