// 预览日志判读（server/src/preview-log.ts）。
//
// 这条测试钉的不是「能不能认出 EADDRINUSE」，而是**认错的两个方向各有各的坏法**，
// 而且坏得不对称：
//
//   · 漏判（该认出撞车却没认）= 用户干等 120 秒，再收到一句「等了 120 秒还没起来」，
//     真原因埋在日志末尾要他自己翻。烦，但至少他知道这一站失败了。
//   · 误判（把「我自己换个端口」当成撞车）= 一个**本来跑起来了**的预览被我们杀掉并
//     判死。用户看到的是「ash 把好好的服务弄挂了」。
//
// 而漏判还有第三种更坏的下场（不在这份测试里，在 preview.ts 的顺序上）：占着端口的
// 那个进程是活的，连得上、也印着 http://localhost:5173，于是会被误报成「预览已起」，
// 把用户领到**别人的服务**上去验收自己的改动。所以撞车判定排在就绪判定前面。
//
// 跑法：npm -w server run test:preview-log
import { missingDepsHint, pickPreviewUrl, portConflict, portHint } from "../src/preview-log.js";

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
  "ash server 自己的拒绝启动",
  portConflict("[server] [ash] Refusing to start: port 4317 is already in use.\n"),
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

// —— 一条命令同时起前后端：配角的端口不能被当成预览本尊 ——
// 后端几乎总比前端先起来（前端还在编译），它印的那句「Tomcat started on port …」如果被
// 采信，用户点开预览看到的是一个返回 JSON 的地址。这几个端口是 ash 自己借给配角的
// （$PORT2…），谁拿了它一清二楚，所以这里不是猜，是排除。
const pair = "Tomcat started on port 35725 (http) with context path '/'\n";
check("配角自述的端口不算数（前端还没起来时宁可回 null）", pickPreviewUrl(pair, 34233, [35725]), null);
check("不告诉它哪些是配角就会挑错", pickPreviewUrl(pair, 34233)?.port, 35725);
const pairUrl = "backend up at http://localhost:35725/\n  ➜  Local: http://localhost:34233/\n";
check("配角印出整条地址同样排除，最后落在借出去的主端口上", pickPreviewUrl(pairUrl, 34233, [35725]), {
  url: "http://localhost:34233/", port: 34233, lent: true,
});
check("配角有好几个也一样一个不认", pickPreviewUrl(pairUrl, 34233, [35725, 46401]), {
  url: "http://localhost:34233/", port: 34233, lent: true,
});

// —— 撞车 + 自己的地址同时出现：preview.ts 的那个例外 ——
// 后端撞上本机已在跑的那份、前端认了 $PORT 好好地起来了。两个纯函数各自照旧回答，
// 由 preview.ts 组合成「这次不算失败」。这里钉的是它俩的输入。
const mixed = "[server] [ash] Refusing to start: port 4317 is already in use.\n"
  + "[web] ➜  Local:   http://localhost:54798/\n";
check("撞车行照样认得出来", portConflict(mixed), "端口 4317 已经被别的进程占着");
check("但预览本尊落在借来的端口上", pickPreviewUrl(mixed, 54798)?.lent, true);

// —— ash 自己的预览：整套起（scripts/dev.mjs）——
// 预览起的是这个分支的前端 **和** 后端（2026-08-07 改的，理由在 dev.mjs 头部）。于是
// 日志里必然有两个本机地址，而后端那行往往先打出来。dev.mjs 转发后端日志时把 scheme
// 去掉就是为这一条：`lent` 优先只在前端那行**已经打出来**之后才管用，在那之前 `first`
// 会把用户领到 API 上（点开一片 JSON，还以为预览坏了）。所以钉的是更强的一条——
// 后端那行**根本不该成为候选**，连兜底路径都够不着它。
const stack = "[api] [ash] server on localhost:62398\n"
  + "  ➜  Local:   http://127.0.0.1:62396/\n";
check("后端那行进不了候选（scheme 已被 dev.mjs 去掉）", pickPreviewUrl(stack, null), {
  url: "http://127.0.0.1:62396/", port: 62396, lent: false,
});
check("前端那行还没打出来时也不会误挑后端", pickPreviewUrl("[api] [ash] server on localhost:62398\n", 62396), null);

// —— ash 自己的预览：只起前端（scripts/dev.mjs 的 frontend 档）——
// 2026-09-09 真出过：这一档只起前端，/api 直接打到本机那份 ash，开场那行写的是
// 「/api 打到 http://127.0.0.1:4317。」。两处一起坏——
//   ① 它是那几秒里日志中唯一的地址，于是 `first` 认了 4317，预览指到 ash 自己身上；
//   ② 句号被 URL_RE 一起收了进去，存进 preview.json，用户点开预览时 `new URL()` 抛，
//      Hono 兜底成一句 Internal Server Error（表现就是「预览打不开，还是英文的」）。
// dev.mjs 那行现在不印 scheme 了，但这里钉的是判读侧：**哪怕它照旧印，也不许认**。
const frontendOnly = "[dev] 预览：只起前端 37009，/api 打到 http://127.0.0.1:4317。\n";
check("ash 自己监听的端口不进候选", pickPreviewUrl(frontendOnly, 37009, [4317]), null);
check(
  "排除之后照旧等前端那行",
  pickPreviewUrl(`${frontendOnly}  ➜  Local:   http://127.0.0.1:37009/\n`, 37009, [4317]),
  { url: "http://127.0.0.1:37009/", port: 37009, lent: true },
);
// 句号是中文散文里的，跟着色一样属于「日志的属性」，但坏法比着色响得多：着色顶多把
// 用户领到一个 404 路径，标点直接让 `new URL()` 抛。所以单独钉一条。
check(
  "一句话里嵌的地址不许把句号收进去",
  pickPreviewUrl("[dev] /api 打到 http://127.0.0.1:4317。\n", null)?.url,
  "http://127.0.0.1:4317",
);
check(
  "半角标点同理（英文日志里 `at http://localhost:5173.`）",
  pickPreviewUrl("Serving at http://localhost:5173/.\n", null)?.url,
  "http://localhost:5173/",
);
check(
  "括号、逗号、顿号一样剥干净",
  pickPreviewUrl("(见 http://localhost:5173/app)，或者 http://localhost:8080、\n", null)?.url,
  "http://localhost:5173/app",
);
check(
  "剥完仍是一个能解析的 URL",
  new URL(pickPreviewUrl("打到 http://127.0.0.1:4317。\n", null)?.url ?? "http://x/").port,
  "4317",
);
check(
  "该留的尾巴不许剥：查询串和锚点",
  pickPreviewUrl("open http://localhost:5173/?token=a1#top\n", null)?.url,
  "http://localhost:5173/?token=a1#top",
);

// —— 只说端口、不印地址的那一类（项目预览命令可以是任何语言之后才有的）——
// Spring Boot 是最典型的一个：它从头到尾不印一个 URL，只说自己在 8080 上起来了。
// 认不出来的话，一个已经在跑的服务会被干等到 120 秒超时，报一句「还没起来」。
check(
  "Spring Boot 只说端口",
  pickPreviewUrl("Tomcat started on port 8080 (http) with context path ''\n", null),
  { url: "http://localhost:8080/", port: 8080, lent: false },
);
check(
  "Spring Boot 老写法 port(s)",
  pickPreviewUrl("Tomcat started on port(s): 9090 (http)\n", null)?.port,
  9090,
);
check("落在借来的端口上照样标 lent", pickPreviewUrl("Netty started on port 44017\n", 44017)?.lent, true);
check(
  "印了地址就用地址，不走这条兜底",
  pickPreviewUrl("Tomcat started on port 8080\n➜  Local:   http://localhost:5173/\n", null)?.port,
  5173,
);
// 撞车那一行里也有端口号。照着它拼地址 = 把用户领到别人的服务上（PORT_TAKEN_RE 注释里的 ②）。
check("「端口被占」那行不许拿来拼地址", pickPreviewUrl("Error: Port 5173 is already in use\n", null), null);
check("光有个数字不算自述", pickPreviewUrl("build finished in 8080 ms\n", null), null);

// —— 「没装依赖」得当场说破，而不是甩一段日志尾巴 ——
// 任务 worktree 是干净检出，node_modules 天生不在里面。ash 会自己在**项目之外**备一份挂
// 进来（preview-deps.ts），走到这个提示说明那一步没成 —— 于是提示要交代两件事：ash 试过
// 什么、以及人工那条路的两条真实路径。
check("npm/sh 找不到可执行文件", !!missingDepsHint("sh: 1: vite: not found\n"), true);
check("node 找不到模块", !!missingDepsHint("Error: Cannot find module 'vite'\n"), true);
check("ESM 版说法", !!missingDepsHint("code: 'ERR_MODULE_NOT_FOUND'\n"), true);
check("pnpm 没有 lock", !!missingDepsHint("ERR_PNPM_NO_LOCKFILE  Cannot install with frozen-lockfile\n"), true);
check("Windows 的说法", !!missingDepsHint("'vite' is not recognized as an internal or external command\n"), true);
check("提示里交代 ash 自己在项目外备过一份", missingDepsHint("sh: vite: not found\n")?.includes("data/deps"), true);
check(
  "备依赖失败的理由原样带上",
  missingDepsHint("sh: vite: not found\n", [], [{ rel: "front", ok: false, detail: "没网", link: null }])?.includes("没网"),
  true,
);
check("提示里给出软链这条不写你项目的路", missingDepsHint("sh: vite: not found\n")?.includes("ln -s"), true);
// 正常日志不许被认成缺依赖：误报会让用户去装一堆根本不缺的东西。
check("正常启动日志", missingDepsHint("VITE ready in 81 ms\n➜ Local: http://localhost:5174/\n"), null);
check("端口撞车不是缺依赖", missingDepsHint("Error: Port 5173 is already in use\n"), null);
// 「这个文件不在」不是「没装依赖」：`node nope.js` 报的是同一句 Cannot find module，
// 但引号里是一条路径。对着它说「去软链 node_modules」是把人往反方向指。
check("缺的是自己的文件就不提装依赖", missingDepsHint("Error: Cannot find module '/repo/front/nope.js'\n"), null);
check("相对路径同理", missingDepsHint("Error: Cannot find module './missing.js'\n"), null);
check("缺的是包才提", missingDepsHint("Error: Cannot find module 'vite'\n") !== null, true);
check("业务里出现 not found 字样也不算", missingDepsHint("GET /api/users 404 Not Found in 12ms\n"), null);

// —— 找不到的到底是什么，决定了下一步 ——
// 「预览不再是 Node 专属」之后，`dotnet: command not found` 跟 node_modules 一点关系都
// 没有。对着它说「去软链 node_modules」是把人往一条不可能修好的路上指，而且恰恰重演了
// 这一整件事要解决的毛病：拿 Node 的世界观去解释别的语言。
const dotnet = missingDepsHint("sh: line 1: dotnet: command not found\n") ?? "";
check("非 Node 的运行时不再叫人去软链 node_modules", dotnet.includes("ln -s"), false);
check("而是明说那条路帮不上忙", dotnet.includes("帮不上忙"), true);
check("非 Node 的运行时说的是 PATH / 没装", dotnet.includes("PATH"), true);
check("并且把找不到的那个名字带上", dotnet.includes("`dotnet`"), true);
const mvn = missingDepsHint("sh: 1: mvn: not found\n") ?? "";
check("mvn 同理", mvn.includes("ln -s"), false);
check("顺带指出项目自带的 wrapper", mvn.includes("./mvnw"), true);
check("Windows 的说法也分得清", (missingDepsHint("'dotnet' is not recognized as an internal or external command\n") ?? "").includes("ln -s"), false);
check("python3 也不是 Node 的事", (missingDepsHint("sh: 1: python3: not found\n") ?? "").includes("ln -s"), false);
// Node 那一挂照旧走软链那条 —— 这条才是它本来要解决的问题。
check("vite 仍然按没装依赖说", (missingDepsHint("sh: 1: vite: not found\n") ?? "").includes("ln -s"), true);
check("zsh 的写法也认得出名字", (missingDepsHint("zsh: command not found: dotnet\n") ?? "").includes("`dotnet`"), true);
check("绝对路径只看最后一段", (missingDepsHint("sh: 1: /usr/bin/mvn: not found\n") ?? "").includes("`mvn`"), true);
check("模块解析错跟命令名无关，一律算没装依赖", (missingDepsHint("Error: Cannot find module 'vite'\n") ?? "").includes("ln -s"), true);

// —— 「Node 那一挂」还得再分一刀 ——
// 项目 `.bin` 里的可执行文件（vite/next/tsx…）确实由 node_modules 提供，软链是对的；
// 但**运行时和包管理器本身**（node/npm/pnpm/yarn/bun/corepack）装在机器上，软链一百份
// node_modules 也不会让 shell 找到 `pnpm`。而这不是假想路径：自动识别照锁文件直接写出
// `pnpm run dev`（a4sms-front 就是 pnpm 项目），换一台没装 pnpm 的机器就是一条不可能
// 修好的建议 —— 而且又一次把「装依赖」这件事推给了根本不缺依赖的人。
const softlink = (line: string) => (missingDepsHint(line) ?? "").includes("ln -s");
const onPath = (line: string) => (missingDepsHint(line) ?? "").includes("PATH");
for (const runtime of ["node", "npm", "npx", "pnpm", "yarn", "bun", "corepack"]) {
  check(`${runtime} 是运行时/包管理器，不提软链`, softlink(`sh: 1: ${runtime}: not found\n`), false);
  check(`${runtime} 说的是没装 / 不在 PATH 上`, onPath(`sh: 1: ${runtime}: not found\n`), true);
}
for (const bin of ["vite", "next", "tsx", "nodemon", "concurrently"]) {
  check(`${bin} 由项目 .bin 提供，走软链那条`, softlink(`sh: 1: ${bin}: not found\n`), true);
}
check("pnpm 顺带提一句 corepack", (missingDepsHint("sh: 1: pnpm: not found\n") ?? "").includes("corepack enable"), true);
check("yarn 同理", (missingDepsHint("sh: 1: yarn: not found\n") ?? "").includes("corepack enable"), true);
check("但 vite 不该被提 corepack", (missingDepsHint("sh: 1: vite: not found\n") ?? "").includes("corepack"), false);

// —— 终端输出不是纯文本：判读前先剥 ANSI ——
// dev server 基本都给地址着色。不剥的话 URL 会把控制码收进路径（端口连得上，于是判成
// 「起好了」，浏览器打开却是 404），行尾锚定的那几条也会因为末尾多一个重置码而失效。
const ESC = String.fromCharCode(27);
check(
  "着色过的地址不能把控制码收进路径",
  pickPreviewUrl(`  ➜  Local:   ${ESC}[36mhttp://localhost:43435/${ESC}[39m\n`, 43435),
  { url: "http://localhost:43435/", port: 43435, lent: true },
);
check(
  "拼出来的地址能被 URL 解析成根路径",
  new URL(pickPreviewUrl(`${ESC}[32mhttp://localhost:5173/${ESC}[0m\n`, null)?.url ?? "http://x/").pathname,
  "/",
);
check(
  "终端超链接（OSC 8）不会把转义序列当成地址的一部分",
  pickPreviewUrl(`${ESC}]8;;http://localhost:5173/${String.fromCharCode(7)}http://localhost:5173/${ESC}]8;;${String.fromCharCode(7)}\n`, null)?.url,
  "http://localhost:5173/",
);
check(
  "着色的撞车行照样认得出来",
  portConflict(`${ESC}[31mError: Port 5173 is already in use${ESC}[39m\n`),
  "端口 5173 已经被别的进程占着",
);
check(
  "行尾带重置码时 not found 仍然认得出来",
  (missingDepsHint(`${ESC}[31msh: 1: vite: not found${ESC}[0m\n`) ?? "").includes("ln -s"),
  true,
);
check(
  "着色的自述端口也认",
  pickPreviewUrl(`${ESC}[32mTomcat started on port 8080${ESC}[0m\n`, null)?.port,
  8080,
);

console.log(failures ? `\n${failures} 条没过` : "\n全过");
process.exit(failures ? 1 : 0);
