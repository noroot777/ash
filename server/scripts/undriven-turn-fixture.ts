// `test-undriven-turn.ts` 用的假 codex app-server。
//
// 两个假进程,各管一件事:
//   · `codex`(PATH 上那个垫片)—— 走**真实 CodexExecutor 生产路径**的那一端。按 mode 文件
//     分两种行为:`accept` 照协议把回合跑完,`refuse` 一个应答都不给当场退出(于是
//     `ready` 以「连接已关闭」拒掉 —— 这就是「输入一个字都没进去」的可控现场)。
//   · `idle-app-server.mjs` —— **接管**那一端。照常应答 `initialize` / `thread/resume`,
//     然后再不主动说话:旧服务端死在「恢复线程 → 送出回合输入」空当时留下的就是它。
//
// mode 走文件而不是 env:垫片是真被 `spawnForRun` 起的,测试进程改不了它那一次的环境。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS } from "../src/platform.js";

const MODE_FILE = "mode";

/** 下一次起跑的假 codex 按哪种行为走。 */
export function codexMode(binDir: string, mode: "accept" | "refuse"): void {
  writeFileSync(join(binDir, MODE_FILE), mode);
}

export function installFakeCodexAppServer(root: string): string {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const appServer = join(binDir, "app-server.mjs");
  const idle = join(binDir, "idle-app-server.mjs");
  const modePath = join(binDir, MODE_FILE);

  // 一条共用的 JSONL 读行器:两个假进程都靠它按行吃 stdin。
  const reader = `
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  for (;;) {
    const nl = buf.indexOf("\\n");
    if (nl < 0) return;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) { try { receive(JSON.parse(line)); } catch { /* 不是 JSON 就跳过 */ } }
  }
});
setInterval(() => {}, 1000);
`;

  writeFileSync(appServer, `
import { readFileSync } from "node:fs";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let mode = "accept";
try { mode = readFileSync(${JSON.stringify(modePath)}, "utf8").trim(); } catch { /* 缺省 accept */ }
// refuse:一个应答都不给,当场退出。连接一关,ash 侧那条 \`initialize\` 以
// 「Codex App Server 连接已关闭」被拒 —— 回合输入一个字都没出去。
if (mode === "refuse") process.exit(0);
const THREAD = "th-accept";
const TURN = "t-accept";
function receive(message) {
  if (message.id === undefined) return; // 通知(initialized 之类)不用答
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: THREAD }, model: "fake-codex" } });
    send({ method: "thread/started", params: { thread: { id: THREAD } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: TURN } } });
    send({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
    setTimeout(() => {
      send({ method: "item/completed", params: { threadId: THREAD, turnId: TURN,
        item: { type: "agentMessage", id: "m-1", text: "收到，继续。" } } });
      send({ method: "turn/completed", params: { threadId: THREAD,
        turn: { id: TURN, status: "completed", error: null } } });
    }, 20);
    return;
  }
  if (message.method === "thread/goal/get") { send({ id: message.id, result: { goal: null } }); return; }
  send({ id: message.id, result: {} }); // initialize / thread/archive / 其余一律空结果
}
${reader}
`);

  writeFileSync(idle, `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
function receive(message) {
  if (message.id === undefined) return;
  if (message.method === "thread/resume" || message.method === "thread/start") {
    // **只答到这里**:线程恢复了,回合从未启动 —— 事故现场那两行就是这个形状。
    send({ id: message.id, result: { thread: { id: "th-undriven" } } });
    return;
  }
  if (message.method === "initialize") { send({ id: message.id, result: {} }); return; }
  // 其余(turn/interrupt、thread/archive…)一律不答:它已经不说话了。
}
${reader}
`);

  // Windows 上没有 shebang 这一档,等价物是 `.cmd` 垫片(`%*` 原样转发参数) —— `resolveLaunch`
  // 认得它、会按 cmd.exe 的规则起,跟真 CLI 装出来的垫片同一条路(同 test-reattach.ts)。
  writeFileSync(
    join(binDir, IS_WINDOWS ? "codex.cmd" : "codex"),
    IS_WINDOWS
      ? `@echo off\r\n"${process.execPath}" "${appServer}" %*\r\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(appServer)} "$@"\n`,
    { mode: 0o755 },
  );
  codexMode(binDir, "accept");
  // 读一次确认装好了(写不下去的话后面每一段都会红在一个跟产品无关的理由上)。
  readFileSync(join(binDir, MODE_FILE), "utf8");
  return binDir;
}
