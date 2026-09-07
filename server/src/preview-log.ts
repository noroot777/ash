// 从预览进程的日志里读出「它到底怎么了」。
//
// 单独一个模块是为了能被纯函数测试钉住（preview.ts 一进来就拖着 db 和进程管理）。
// 这里只有正则和字符串，不碰任何副作用。
//
// 判据本身的由来见 PORT_TAKEN_RE 的注释：**端口撞车必须当场认出来**，因为它既不能干等
// 超时，更不能被误判成「起好了」。
//
// 进来的日志是**终端输出**，不是纯文本：dev server 基本都给地址着色（vite 印的是
// `http://localhost:5173/\x1b[39m`）。所以这里每个判据都先剥 ANSI —— 不剥的话两头都坏：
// URL 会把控制码收进路径（`new URL(...).pathname === "/%1B[39m"`，端口连得上，于是被判
// 「起好了」，浏览器打开 404），而行尾锚定的那几条（`: not found$`）会因为末尾多一个
// 重置码而整条匹配不上。

/**
 * ANSI 控制序列。三类都要认：CSI（`\x1b[32m` 这种颜色）、OSC（`\x1b]8;;<url>\x07`，
 * 终端超链接，整段连载荷一起剥掉，可见文本还留着）、以及两字符的转义。
 */
const ANSI_RE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/** 把终端着色剥掉再做判断。显示给用户的原文不经过这里 —— 那边有颜色反而更好读。 */
export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_RE, "");
}

// 「端口被别人占着」必须**当场**认出来，不能等超时。两个理由，都不是省那两分钟：
//   ① 撞车时日志第一行就把话说完了，再干等 120 秒只会让用户收到一句「等了 120 秒还
//      没起来」——真正的原因被埋在末尾 800 字里，得他自己去翻。
//   ② 更糟的是**误报成功**：占着那个端口的进程是活的，`canConnect` 当然连得上，日志里
//      又印着 `http://localhost:5173`，于是我们会兴高采烈地写一句「预览已起」，把用户
//      引到**别人的服务**上去验收自己的改动。所以这道检查排在就绪判定**前面**。
const PORT_TAKEN_RE = /EADDRINUSE|address already in use|port .{0,12}already in use/i;

/** 「占用了但我自己换一个」不算失败 —— vite 非 strictPort 就是这么干的，别把它判死。 */
const PORT_RETRY_RE = /trying another|retry|retrying|instead|falling back|fallback/i;

/** 撞车那一行里的端口号（"Port 5173 is already in use" → 5173）。取不到就只说撞了。 */
export function portConflict(log: string): string | null {
  for (const line of stripAnsi(log).split("\n")) {
    if (!PORT_TAKEN_RE.test(line) || PORT_RETRY_RE.test(line)) continue;
    const port = /\b(\d{2,5})\b/.exec(line)?.[1];
    return port ? `端口 ${port} 已经被别的进程占着` : "启动命令要用的端口已经被别的进程占着";
  }
  return null;
}

/** 撞车时给的下一步。带上这次分到的端口，用户能直接照抄。 */
export function portHint(port: number | null): string {
  const name = port ? `PORT=${port}` : "PORT";
  return "启动命令里的端口多半是写死的，而同一个项目此刻往往已经有一份在跑"
    + "（你自己那份、或者别的任务的预览）。\n"
    + `ash 已经给这次预览借了一个空闲端口，以环境变量 ${name} 传了进去 —— `
    + "把这一站的启动命令改成认它的写法就能错开，例如 `npm run dev -- --port $PORT`。";
}

/**
 * 「命令没跑起来，因为有个东西找不到」——**它是什么东西，决定了下一步完全不一样**。
 *
 * 这套原本只认一种情形：任务 worktree 是一份干净检出，`node_modules` 天生不在里面
 * （被 .gitignore 掉了），于是预览命令一跑就是 `vite: not found`。那时给的建议是「把主仓
 * 装好的那份软链进来」，对 Node 项目是对的。
 *
 * 可预览已经不是 Node 专属了，而 `dotnet: command not found` / `mvn: not found` 跟
 * `node_modules` 一点关系都没有 —— 那是**运行时本身没装或不在 PATH 上**。对着它说「去软链
 * node_modules」，是把人往一条不可能修好的路上指，而且恰恰重演了这一整件事要解决的毛病：
 * 拿 Node 的世界观去解释别的语言。所以先把找不到的那个名字捞出来，再决定说什么。
 */
/** 从「找不到命令」那一行里把命令名捞出来。认不出名字就返回 null（但仍算命中）。 */
function missingCommand(line: string): string | null {
  // zsh：`zsh: command not found: vite`
  const zsh = /command not found:\s*(\S+)/i.exec(line);
  if (zsh) return zsh[1];
  // sh/dash：`sh: 1: vite: not found`；bash：`sh: line 1: dotnet: command not found`
  const posix = /(?:^|:\s*)([^\s:]+):\s*(?:command\s+)?not found\s*$/i.exec(line);
  if (posix) return posix[1];
  // Windows cmd：`'dotnet' is not recognized as an internal or external command`
  const cmd = /'([^']+)'\s+is not recognized as an internal or external command/i.exec(line);
  if (cmd) return cmd[1];
  return null;
}

/** 这个名字是不是 Node 那一挂的（装在 node_modules/.bin 里，或者 Node 自己的工具链）。 */
const NODE_TOOLS = new Set([
  "node", "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "corepack",
  "vite", "next", "nuxt", "ng", "astro", "remix", "svelte-kit", "vue-cli-service", "react-scripts",
  "tsx", "ts-node", "tsc", "nest", "nodemon", "concurrently", "webpack", "rollup", "parcel", "esbuild",
]);

// 一行一行看，而且只认**外壳/运行时自己的报错格式**。宽松地匹配 "not found" 会把
// `GET /api/users 404 Not Found in 12ms` 这种业务日志认成缺依赖 —— 误报的代价是让人
// 去装一堆根本不缺的东西，比不报还差（这条由 test:preview-log 钉住）。
const MISSING_CMD_LINES = [
  /: (?:command )?not found\s*$/i, // sh/dash：`sh: 1: vite: not found`
  /\bcommand not found\b/i, // zsh：`zsh: command not found: vite`
  /is not recognized as an internal or external command/i, // Windows cmd
];

/** 只可能是 Node 的那几种报错：认到就是「没装依赖」，命令名无关。 */
const MISSING_MODULE_LINES = [
  // node 解析不到。**只认包名**：`Cannot find module '/x/nope.js'`（绝对路径、`./` 开头）
  // 说的是「你这个文件不在」，跟装没装依赖无关 —— 对它说「去软链 node_modules」是把人
  // 往反方向指。带引号的看引号里第一个字符，不带引号的（ERR_MODULE_NOT_FOUND 那类）照收。
  /Cannot find (?:module|package) ['"](?![./]|[A-Za-z]:)/i,
  /Cannot find (?:module|package)\s*$|ERR_MODULE_NOT_FOUND/i,
  /ERR_PNPM_NO_LOCKFILE|ERR_PNPM_NO_SCRIPT_OR_SERVER|Missing binary/i, // pnpm/yarn
  /canceled due to missing packages/i, // npx --no-install
];

/**
 * ash 不替他装依赖：install 会写进他的项目 —— 少则在工作区里堆出几百兆，多则改写 lock
 * 文件，而 lock 文件是跟踪文件，会跟着任务 diff 一路走进验收。「点一下预览」不该有这种
 * 副作用。能做也该做的是把话说清楚，并指出不写他项目的那条路：把主仓已经装好的那份软链
 * 进来（agent 干活时本来就是这么借的，`git.ts` 的 workspaceDirty 专门放行了这条软链）。
 */
function nodeModulesHint(what: string): string {
  return `${what} —— 任务 worktree 是一份干净检出，node_modules 不在里面。\n`
    + "ash 不会替你装：install 会写进你的项目（工作区里堆出几百兆，还可能改写 lock 文件，"
    + "而 lock 文件是跟踪文件，会跟着任务 diff 走进验收）。所以也别把 install 写进预览命令。\n"
    + "不写你项目的做法是把主仓已经装好的那份借过来，在任务工作区里软链一次即可，例如：\n"
    + "`ln -s <项目目录>/<子项目>/node_modules <任务工作区>/<子项目>/node_modules`"
    + "（Windows 用 `mklink /J`）。ash 认得这条软链，不会因此把工作区判成脏。";
}

/** 找不到的是一门运行时/构建工具：跟 node_modules 无关，是 PATH 或者压根没装。 */
function runtimeMissingHint(name: string): string {
  // wrapper 那条只对认得出 wrapper 的那两门说 —— 对着 dotnet 提 `./mvnw` 是噪音。
  const wrapper = /^mvn/i.test(name) ? "，又或者用项目自带的 `./mvnw`（连版本都不用自己管）"
    : /^gradle/i.test(name) ? "，又或者用项目自带的 `./gradlew`（连版本都不用自己管）"
      : "";
  return `\`${name}\` 这个命令没找到。它不是这个工作区里的依赖，所以软链 node_modules 帮不上忙 —— `
    + "要么这台机器上没装它，要么它不在 ash 起预览时那个 shell 的 PATH 上"
    + "（POSIX 上是 `sh -lc`，`~/.profile` 一类登录时读的配置算数；只在图形界面或 IDE 里"
    + "设过的 PATH 不算）。\n"
    + `装上它并确认新开一个终端 \`${name} --version\` 能跑，`
    + `或者在项目设置 → 预览命令里写它的绝对路径${wrapper}。`;
}

/**
 * 日志像不像「有个东西找不到」；不像就 null。只在进程已经退出的失败路径上追加。
 *
 * 认出来之后按**找不到的是什么**分岔：Node 的工具链和模块解析错 → 没装依赖那条；别的命令
 * → 运行时/PATH 那条；名字都捞不出来的少数格式 → 两条都摆出来，让用户自己对号入座，
 * 也好过硬塞一条必然无效的建议。
 */
export function missingDepsHint(log: string): string | null {
  const lines = stripAnsi(log).split("\n").map((line) => line.trimEnd());
  if (lines.some((line) => MISSING_MODULE_LINES.some((re) => re.test(line)))) {
    return nodeModulesHint("看着像这个工作区里没装依赖");
  }
  const hit = lines.find((line) => MISSING_CMD_LINES.some((re) => re.test(line)));
  if (hit === undefined) return null;
  const name = missingCommand(hit);
  if (name === null) {
    return "启动命令里有个东西没找到（日志里那句 not found）。两种可能，对号入座：\n"
      + "① 它是这个项目 node 依赖里的可执行文件 —— 任务 worktree 是干净检出，"
      + "node_modules 不在里面，把主仓装好的那份软链进来即可"
      + "（`ln -s <项目目录>/<子项目>/node_modules <任务工作区>/<子项目>/node_modules`，"
      + "Windows 用 `mklink /J`）。ash 不替你装，也别把 install 写进预览命令 —— 它会改写"
      + " lock 文件，跟着任务 diff 走进验收。\n"
      + "② 它是一门运行时或构建工具（mvn / gradle / dotnet / go / python…）—— 那就是没装，"
      + "或者不在 ash 起预览那个 shell 的 PATH 上，跟 node_modules 无关。";
  }
  const bare = name.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").split(/[\\/]/).pop() ?? name;
  return NODE_TOOLS.has(bare.toLowerCase())
    ? nodeModulesHint(`\`${bare}\` 没找到，看着像这个工作区里没装依赖`)
    : runtimeMissingHint(bare);
}

/** 日志里印出来的本机地址。`lent` 为真表示它就落在我们借出去的那个端口上。 */
export interface PreviewUrl {
  url: string;
  port: number;
  lent: boolean;
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?[^\s'"]*/gi;

/**
 * 「我在 8080 上起来了」但**不印地址**的那一类日志。
 *
 * Node 那边的 dev server 无一例外会印一行 `http://localhost:xxxx`，所以一开始只认 URL 就够。
 * 项目预览命令可以是任何语言之后就不够了 —— Spring Boot 印的是
 * `Tomcat started on port 8080 (http) with context path ''`，一个 URL 都没有，于是一个明明
 * 已经在跑的服务会被干等到 120 秒超时。这里把端口捞出来自己拼一个回环地址。
 *
 * 只认「**它自己说自己起来了**」这几种说法（started / listening / running），不认光出现一个
 * 数字的行：日志里的端口号还可能来自「端口被占」那一行，照着它拼地址就会把用户领到别人的
 * 服务上去 —— 那正是 PORT_TAKEN_RE 那段注释里的 ②。撞车行在这里显式排除，preview.ts 那边
 * 的顺序（先判撞车、后判就绪）是第二道。
 */
const PORT_ANNOUNCE_RE = /\b(?:started|starting|listening|running|bound|serving)\b[^\n]{0,40}?\bport\D{0,6}(\d{2,5})\b/i;

/** 日志里「起在哪个端口」的自述；没有就 null。`skip` 里的端口视而不见。 */
function announcedPort(log: string, skip: ReadonlySet<number>): number | null {
  for (const line of stripAnsi(log).split("\n")) {
    if (PORT_TAKEN_RE.test(line)) continue;
    const port = PORT_ANNOUNCE_RE.exec(line)?.[1];
    if (port && !skip.has(Number(port))) return Number(port);
  }
  return null;
}

/**
 * 从日志里挑出「预览本尊」的地址。
 *
 * 不能见到第一个 URL 就当它是：**一条 `npm run dev` 并排起好几个服务是常态**（concurrently
 * 起前端 + 后端、框架顺带印一个 API 地址），谁先把自己的地址打出来纯看运气，挑错了就是把
 * 用户领到隔壁那个服务上去验收。所以借出去的那个端口优先 —— 那是我们刚探出来的空闲端口，
 * 命令认了它，落在上面的地址必然是这一站要看的东西。
 *
 * `lent` 这个标记还兼着第二个用处，见 preview.ts 里撞车判定的那个例外。
 *
 * `sidekicks` 是 ash 借给**配角**的那几个端口（`$PORT2…`，见 preview.ts 的 portEnv）。它们
 * 按定义就不是要看的那个，所以一律排除：一条同时起前后端的命令里，后端多半比前端先起来
 * 并印一句「Tomcat started on port 35725」，不排除的话预览就会稳定地指到后端上 —— 前端还在
 * 编译，用户已经被领到一个返回 JSON 的地址前面了。这条不靠猜：那几个端口是 ash 自己借出去
 * 的，谁拿了它一清二楚。
 *
 * 日志里一个地址都没有时，退而求其次认「起在某个端口」的自述（见 announcedPort）——
 * 非 Node 的服务常常只说端口不说地址。
 */
export function pickPreviewUrl(
  log: string,
  lent: number | null,
  sidekicks: readonly number[] = [],
): PreviewUrl | null {
  const skip = new Set(sidekicks.filter((port) => port !== lent));
  let first: PreviewUrl | null = null;
  // 先剥 ANSI 再扫地址。URL_RE 收到「空白/引号为止」，而着色后的行是
  // `http://localhost:5173/\x1b[39m` —— 控制码不是空白也不是引号，会被原样收进地址，
  // 存进 preview.json、再交给浏览器打开。端口连得上，所以一路判成「起好了」，用户点开
  // 得到的却是 `/%1B[39m` 这条 404 路径：服务是好的、根页面是好的，表现仍然是「预览
  // 打不开」。这一条在这儿修，不在正则里加特例 —— 着色是整段日志的属性，不是 URL 的。
  const clean = stripAnsi(log);
  for (const hit of clean.matchAll(URL_RE)) {
    const url = hit[0];
    const port = Number(hit[1] ?? (url.startsWith("https") ? 443 : 80));
    if (lent !== null && port === lent) return { url, port, lent: true };
    if (skip.has(port)) continue;
    first ??= { url, port, lent: false };
  }
  if (first) return first;
  const port = announcedPort(clean, skip);
  return port === null ? null : { url: `http://localhost:${port}/`, port, lent: lent === port };
}

