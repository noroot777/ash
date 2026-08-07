// 预览日志判读（server/src/preview-log.ts）。
//
// 这条测试钉的不是「能不能认出 EADDRINUSE」，而是**认错的两个方向各有各的坏法**，
// 而且坏得不对称：
//
//   · 漏判（该认出撞车却没认）= 用户干等 120 秒，再收到一句「等了 120 秒还没起来」，
//     真原因埋在日志末尾要他自己翻。烦，但至少他知道这一站失败了。
//   · 误判（把「我自己换个端口」当成撞车）= 一个**本来跑起来了**的预览被我们杀掉并
//     判死。用户看到的是「harness 把好好的服务弄挂了」。
//
// 而漏判还有第三种更坏的下场（不在这份测试里，在 preview.ts 的顺序上）：占着端口的
// 那个进程是活的，连得上、也印着 http://localhost:5173，于是会被误报成「预览已起」，
// 把用户领到**别人的服务**上去验收自己的改动。所以撞车判定排在就绪判定前面。
//
// 跑法：npm -w server run test:preview-log
import { pickPreviewUrl, portConflict, portHint } from "../src/preview-log.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

// —— 认得出来的（真撞车，这一站就该当场失败）——
// 第一条就是 1IopNDH4Int3 那次的原样日志：worktree 里 npm run dev，撞上用户自己那份。
check(
  "vite strictPort 撞车",
  portConflict("[web] error when starting dev server:\n[web] Error: Port 5173 is already in use\n"),
  "端口 5173 已经被别的进程占着",
);
check(
  "harness server 自己的拒绝启动",
  portConflict("[server] [harness] Refusing to start: port 4317 is already in use.\n"),
  "端口 4317 已经被别的进程占着",
);
check(
  "node 原生 EADDRINUSE",
  portConflict("Error: listen EADDRINUSE: address already in use :::3000\n"),
  "端口 3000 已经被别的进程占着",
);
check("没有端口号也得报出来", portConflict("EADDRINUSE\n"), "启动命令要用的端口已经被别的进程占着");
check("撞车那行夹在中间也找得到", portConflict("a\nb\nError: Port 8080 is already in use\nc\n"), "端口 8080 已经被别的进程占着");

// —— 不许认成撞车的 ——
check("干净的启动日志", portConflict("VITE ready in 81 ms\n➜ Local: http://localhost:5174/\n"), null);
// 这条是误判风险最高的一行：vite 默认 strictPort:false 时端口被占**不是错误**，
// 它自己换一个接着跑。判死等于把一个已经起来的预览杀掉。
check("vite 自己换端口", portConflict("Port 5173 is in use, trying another one...\n"), null);
check("说了 already in use 但接着重试", portConflict("Port 5173 already in use, retrying on 5174\n"), null);
check("空日志", portConflict(""), null);

// —— 给用户的下一步必须能直接照抄 ——
const hint = portHint(51234);
check("借到端口时把端口写进提示", hint.includes("PORT=51234"), true);
check("提示带上认 $PORT 的写法", hint.includes("--port $PORT"), true);
check("没借到端口就只说变量名", portHint(null).includes("环境变量 PORT"), true);

// —— 日志里哪个地址才是预览本尊 ——
// 一条 `npm run dev` 并排起好几个服务是常态，谁先把地址打出来纯看运气；挑错了就是把
// 用户领到隔壁那个服务上去验收自己的改动。借出去的那个端口优先。
const both = "[server] API listening on http://localhost:4317\n"
  + "[web] ➜  Local:   http://localhost:54798/\n";
check("借出去的端口优先，哪怕它印得更晚", pickPreviewUrl(both, 54798), {
  url: "http://localhost:54798/", port: 54798, lent: true,
});
check("没借到端口就取第一个", pickPreviewUrl(both, null), {
  url: "http://localhost:4317", port: 4317, lent: false,
});
check("借的端口没出现在日志里也取第一个", pickPreviewUrl(both, 51234), {
  url: "http://localhost:4317", port: 4317, lent: false,
});
check("没有地址", pickPreviewUrl("compiling...\n", 5173), null);
check("地址不带端口就按协议默认", pickPreviewUrl("running at http://localhost/\n", null), {
  url: "http://localhost/", port: 80, lent: false,
});
// 正则带 /g,一不小心就会把 lastIndex 留在模块级变量上——第二次调用从半截开始扫,
// 于是「同一份日志问两次给两个答案」。轮询每秒都要问一次,这条必须钉住。
check("同一份日志问两次答案一样", pickPreviewUrl(both, 54798), pickPreviewUrl(both, 54798));

// —— 撞车 + 自己的地址同时出现：preview.ts 的那个例外 ——
// 后端撞上本机已在跑的那份、前端认了 $PORT 好好地起来了。两个纯函数各自照旧回答，
// 由 preview.ts 组合成「这次不算失败」。这里钉的是它俩的输入。
const mixed = "[server] [harness] Refusing to start: port 4317 is already in use.\n"
  + "[web] ➜  Local:   http://localhost:54798/\n";
check("撞车行照样认得出来", portConflict(mixed), "端口 4317 已经被别的进程占着");
check("但预览本尊落在借来的端口上", pickPreviewUrl(mixed, 54798)?.lent, true);

// —— harness 自己的预览：整套起（scripts/dev.mjs）——
// 预览起的是这个分支的前端 **和** 后端（2026-08-07 改的，理由在 dev.mjs 头部）。于是
// 日志里必然有两个本机地址，而后端那行往往先打出来。dev.mjs 转发后端日志时把 scheme
// 去掉就是为这一条：`lent` 优先只在前端那行**已经打出来**之后才管用，在那之前 `first`
// 会把用户领到 API 上（点开一片 JSON，还以为预览坏了）。所以钉的是更强的一条——
// 后端那行**根本不该成为候选**，连兜底路径都够不着它。
const stack = "[api] [harness] server on localhost:62398\n"
  + "  ➜  Local:   http://127.0.0.1:62396/\n";
check("后端那行进不了候选（scheme 已被 dev.mjs 去掉）", pickPreviewUrl(stack, null), {
  url: "http://127.0.0.1:62396/", port: 62396, lent: false,
});
check("前端那行还没打出来时也不会误挑后端", pickPreviewUrl("[api] [harness] server on localhost:62398\n", 62396), null);

console.log(failures ? `\n${failures} 条没过` : "\n全过");
process.exit(failures ? 1 : 0);
