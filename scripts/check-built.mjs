#!/usr/bin/env node
// `npm start` 之前先看一眼:构建产物到底在不在。
//
// 没有这道闸的话,没构建就起服务会得到这么一坨:
//
//   node:internal/modules/cjs/loader:1386
//     throw err;
//   Error: Cannot find module 'D:\ai_workspace\ash\server\dist\index.js'
//       at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)
//       ... 六行 Node 内部栈帧 ...
//   npm error Lifecycle script `start` failed with error:
//
// 里面没有一个字说得出「你还没构建」。2026-08-20 那台 Windows 机器上,用户的 `npm run setup`
// 在装依赖那步就停了(workspace 缺目录),接着去跑 `npm start`,于是撞上这第二条同样看不懂的
// 报错 —— 同一个病因,两副面孔。装机脚本已经会把第一副翻译成人话了,这里补第二副。
//
// 只挂在 server 的 prestart 上,拦的是 `npm start` / `npm -w server run start` 这条前台路径。
// `npm run restart` 自己会先构建、而且直接 `node server/dist/index.js` 起进程,不经过这里。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const say = (line = "") => process.stderr.write(`${line}\n`);

const serverEntry = join(REPO, "server", "dist", "index.js");
if (existsSync(serverEntry)) {
  // 界面是从磁盘现读的,缺了服务照样起得来 —— 只提醒,不拦。
  if (!existsSync(join(REPO, "web-next", "dist", "index.html"))) {
    say("  ⚠ web-next/dist 还没构建:服务能起,但浏览器打开会是一片空白。补一句 npm run build 就好。");
  }
  process.exit(0);
}

// 依赖都没装 和 装了没构建,是两种不同的下一步。
const installed = existsSync(join(REPO, "node_modules"));

say("");
say("  ✕ server/dist/index.js 不存在 —— 服务端还没构建过,起不来。");
say("");
if (installed) {
  say("     依赖是装好的,缺的只是构建这一步:");
  say("       npm run build");
} else {
  say("     连 node_modules 都还没有,说明装机没走完(多半停在 npm install 那步)。");
  say("     回去把装机跑完,它会连着构建一起做掉:");
  say("       npm run setup");
  say("     那一步报的错才是真正要解决的问题 —— 别绕过它直接 npm start。");
}
say("");
process.exit(1);
