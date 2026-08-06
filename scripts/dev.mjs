// `npm run dev` 有两个调用方，要的东西不一样：
//
//   · 你自己开发 —— 后端（4317）+ 前端一起起。原来的行为，一点没变。
//   · harness 的预览站（`server/src/preview.ts`）—— 它在任务自己的 worktree 里跑这条
//     命令，并借一个空闲端口用环境变量 `PORT` 递进来。这种时候**只该起前端**：
//       ① 后端端口写死 4317、同一个库还只允许一个实例，本机那份正跑着，再起一份必然
//          撞车；撞车那行日志（`Refusing to start: port 4317 is already in use`）又正好
//          命中 harness 的撞车判据，于是前端明明起来了，整个预览还是被判死；
//       ② 预览本来就是看前端，它的 `/api` 会 proxy 到本机那份 4317，数据是真的
//          （见 `web-next/vite.config.ts`）。
//
// 判据用 `PORT` 而不是另开一个变量：借端口这件事本身就是「有人在替我起预览」的信号，
// 而 `PORT` 是 harness 唯一注入的那一个（来由见 preview.ts 里 freePort 的注释）。
import { spawn } from "node:child_process";

const lent = process.env.PORT;
if (lent) {
  console.log(`[dev] 有人借了 PORT=${lent} 进来，按预览处理：只起前端，后端用本机已经在跑的那份。`);
}

const child = spawn("npm", ["run", lent ? "dev:web" : "dev:all"], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
