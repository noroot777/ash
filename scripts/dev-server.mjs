// `PORT=4317 npm -w server run dev` 的跨平台版本。
//
// 前置的 `KEY=VAL command` 是 POSIX shell 语法,Windows 的 cmd.exe 不认(它会把
// `PORT=4317` 当成命令名)。用 .mjs 起一层,env 由 Node 显式传,两边行为一致。
import { spawn } from "node:child_process";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";

const child = spawn(NPM, ["-w", "server", "run", "dev"], {
  stdio: "inherit",
  // 写死 4317:这个脚本的语义就是「起本机那台」,不跟外面的 PORT 走
  // (预览借端口那条路是 scripts/dev.mjs,不经过这里)。
  env: { ...process.env, PORT: "4317" },
  ...NPM_SPAWN_OPTS,
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on("error", (error) => {
  console.error(`[dev:server] 起不来：${error.message}`);
  process.exit(1);
});
