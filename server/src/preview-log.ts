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
//
// 「只有正则和字符串」有一个例外的输入：`missingDepsHint` 收一份**核对过文件系统的事实**
// （NodeDepsAdvice，由 preview-deps.ts 产出）。核对本身在那边做，这里仍然只负责措辞 ——
// 否则这条建议就只能继续用占位符，而占位符正是它上一次没有闭环的原因。
import type { NodeDepsAdvice, NodeDepsPrepared, PackageManager } from "./preview-deps.js";
import { previewShell } from "./preview-shell.js";

/**
 * 提示里给出的命令**也是要被粘进 shell 执行的**，所以路径一律按方言引好。
 *
 * 这不是洁癖：`/tmp/ash review path/front app` 这种带空格的合法路径，不引就是
 * `cd: too many arguments`；带 `$`、`&`、`;` 的还会改变命令语义。生成的预览命令早就走
 * preview-shell.ts 引用了（那儿有整段说明），诊断建议是同一类东西 —— 一样是 ash 写给
 * shell 的字 —— 却漏在了外面。
 */
const POSIX = previewShell("linux");
const CMD = previewShell("win32");

/** 「把 source 挂到 target」这一条，按当前平台的写法给一条能整行粘走的命令。 */
function linkCommand(source: string, target: string): string {
  if (process.platform !== "win32") return `\`ln -s ${POSIX.quote(source)} ${POSIX.quote(target)}\``;
  if (CMD.expressible(source) && CMD.expressible(target)) {
    return `\`mklink /J ${CMD.quote(CMD.path(target))} ${CMD.quote(CMD.path(source))}\``;
  }
  // 路径里带 `%`：cmd 命令行没有可靠的转义写法（理由见 preview-shell.ts 的 expressible），
  // 但 PowerShell 的单引号是纯字面量，写得出来 —— 写得出来就该给一条真能跑的。
  return `\`New-Item -ItemType Junction -Path ${psQuote(target)} -Target ${psQuote(source)}\``;
}

/** 「进这个目录装一次」这一条，同样按当前平台的写法。 */
function installCommand(dir: string, pm: PackageManager): string {
  const shell = previewShell();
  if (shell.expressible(dir)) return `\`${shell.cd(dir, `${pm} install`)}\``;
  return `\`Set-Location ${psQuote(dir)}; ${pm} install\``;
}

/** PowerShell 的单引号字符串：里面只有 `'` 需要写成 `''`。 */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

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

/**
 * 「Node 那一挂」还得再分一刀，因为**这两半的下一步是反的**：
 *
 *   · `NODE_BINS` —— 这些东西**由项目的 node_modules/.bin 提供**。任务 worktree 是干净
 *     检出，它们天生不在，所以「把主仓那份软链进来」正是对的做法。
 *   · `NODE_RUNTIMES` —— 运行时和包管理器**本身**。它们装在机器上，不由任何项目的
 *     node_modules 提供：软链一百份 node_modules 也不会让 shell 找到 `pnpm`。而这条不是
 *     假设的路径 —— 自动识别会照锁文件直接写出 `pnpm run dev` / `yarn dev`（a4sms-front
 *     就是 pnpm 项目），换一台没装 pnpm 的机器，给的就是一条不可能修好的建议。
 */
const NODE_RUNTIMES = new Set(["node", "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "corepack"]);

const NODE_BINS = new Set([
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
 * ash **会**替他备依赖，但备在自己的地盘上：`data/deps/<内容哈希>`，只读项目里的
 * package.json 和锁文件，用户的检出一个字节都不会被写（怎么备见 preview-deps.ts 顶部）。
 * 走到这个函数说明那一步没成 —— 没网、私有源没凭据、workspaces 装不出正确的树，或者
 * 用户的命令压根不是这么个跑法。
 *
 * 所以这里只剩「人工那条路怎么走」，而且**不能再甩一句带占位符的模板**。上一版写的是
 * `ln -s <项目目录>/<子项目>/node_modules <任务工作区>/<子项目>/node_modules`，用户得自己
 * 把两条路径填对，而且它假设主仓那份存在 —— 目标项目的 a4sms-front 在主仓里也没有
 * node_modules，照做只会得到一个断链。
 *
 * 现在先核对事实（preview-deps.ts），再按事实分岔：
 *   · 借得到 → 把两条**真实路径**按当前 shell 的规矩引好写出来，整行可以粘走。
 *   · 借不到 → 明说主仓那份也没有/也不全，并给出在**用户自己的主仓**里装一次那条路。
 *     这条要连副作用一起说清楚：node_modules 被 gitignore 不进 diff，**但锁文件是跟踪
 *     文件**，install 有可能改写它 —— 只说前半句就成了一句听着让人放心的错话。
 *   · 连工作区都没扫到（没传 advice / 不是 node 项目）→ 退回原来那句通用说法。
 */
function nodeModulesHint(
  what: string,
  advice: readonly NodeDepsAdvice[] = [],
  tried: readonly NodeDepsPrepared[] = [],
): string {
  const details = tried.map((one) => `· \`${one.rel}\`：${one.detail}`).join("\n")
    || "· 这条命令没找到要备依赖的 node 包目录";
  // 「试了没成」和「压根不会去做」得说成两句话。后者是这个任务**没开 worktree** ——
  // 工作区就是用户自己的检出，ash 一条软链都不会往里挂（见 preview-deps.ts 的 ashWorktree），
  // 那时再说一句「ash 会自己备一份、这次没成」是误导：他会去等一个永远不会发生的自动补救。
  const blocked = tried.length > 0 && tried.every((one) => one.blocked === "workspace");
  const head = blocked
    ? `${what} —— 这个任务直接跑在项目检出里（没有开 worktree）。\n`
      + "ash 只在自己建的任务 worktree 里挂依赖入口，**不往你的项目目录里写任何东西**，"
      + "所以这次没有代备：\n"
      + `${details}\n`
    : `${what} —— 任务 worktree 是一份干净检出，node_modules 不在里面。\n`
      + "起预览之前 ash 会**自己在项目外备一份**再挂进来（装在 ash 的 `data/deps` 下，只读你的"
      + " package.json 和锁文件，你的项目不会被写）。这次没成：\n"
      + `${details}\n`;
  if (!advice.length) {
    return `${head}\n手工的话，把主仓已经装好的那份借过来最省事：在任务工作区里软链一次即可，例如：\n`
      + "`ln -s <项目目录>/<子项目>/node_modules <任务工作区>/<子项目>/node_modules`"
      + "（Windows 用 `mklink /J`）。ash 认得这条软链，不会因此把工作区判成脏。";
  }
  // 一次最多说三条：并排的子项目再多，先解决看得见的这几个。
  const lines = advice.slice(0, 3).map((one) => {
    const link = one.source === null ? "" : linkCommand(one.source, one.target);
    if (one.sourceReady) return `· \`${one.rel}\`：主仓那份能用，软链过来就行 —— ${link}`;
    if (one.sourceDir === null) {
      return `· \`${one.rel}\`：这个目录就是仓库本身，没有「别处那一份」可借，`
        + `得在这儿装一次 —— ${installCommand(one.dir, one.pm)}`;
    }
    return `· \`${one.rel}\`：**主仓那份也不能用**（\`${one.sourceDir}\` 里的 node_modules 不在、`
      + "是空的、或者没有这次要的那个可执行文件），所以现在没有可借的。"
      + `在你自己的主仓里装一次就有了 —— ${installCommand(one.sourceDir, one.pm)}，装完再软链：${link}`;
  });
  return `${head}\n手工要走的话，缺依赖的是这几个：\n${lines.join("\n")}\n`
    + "（软链 ash 认得，不会因此把工作区判成脏。**在主仓里装要留意锁文件**：node_modules 被"
    + " gitignore 不会进 diff，但锁文件是跟踪文件，install 有可能改写它 —— 装完 `git status`"
    + " 看一眼，别让它跟着任务 diff 走进验收。）";
}

/** 找不到的是一门运行时/包管理器/构建工具：跟 node_modules 无关，是 PATH 或者压根没装。 */
function runtimeMissingHint(name: string): string {
  // 最后这句只对认得出「自带装法」的那几个说 —— 对着 dotnet 提 `./mvnw` 是噪音。
  const own = /^mvn/i.test(name) ? "，又或者用项目自带的 `./mvnw`（连版本都不用自己管）"
    : /^gradle/i.test(name) ? "，又或者用项目自带的 `./gradlew`（连版本都不用自己管）"
      : /^(?:pnpm|yarn)$/i.test(name) ? `，又或者 \`corepack enable\`（Node 自带，直接开出 ${name}）`
        : "";
  return `\`${name}\` 这个命令没找到。它不是这个工作区里的依赖，所以软链 node_modules 帮不上忙 —— `
    + "要么这台机器上没装它，要么它不在 ash 起预览时那个 shell 的 PATH 上"
    + "（POSIX 上是 `sh -lc`，`~/.profile` 一类登录时读的配置算数；只在图形界面或 IDE 里"
    + "设过的 PATH 不算）。\n"
    + `装上它并确认新开一个终端 \`${name} --version\` 能跑，`
    + `或者在项目设置 → 预览命令里写它的绝对路径${own}。`;
}

/**
 * 日志像不像「有个东西找不到」；不像就 null。只在进程已经退出的失败路径上追加。
 *
 * 认出来之后按**找不到的是什么**分岔：项目 `.bin` 里的可执行文件和 Node 的模块解析错
 * → 没装依赖那条；运行时、包管理器、别的语言的工具 → PATH 那条（NODE_RUNTIMES 那儿说了
 * 为什么 `pnpm` 属于后者）；名字都捞不出来的少数格式 → 两条都摆出来，让用户自己对号入座，
 * 也好过硬塞一条必然无效的建议。
 */
export function missingDepsHint(
  log: string,
  advice: readonly NodeDepsAdvice[] = [],
  tried: readonly NodeDepsPrepared[] = [],
): string | null {
  const lines = stripAnsi(log).split("\n").map((line) => line.trimEnd());
  if (lines.some((line) => MISSING_MODULE_LINES.some((re) => re.test(line)))) {
    return nodeModulesHint("看着像这个工作区里没装依赖", advice, tried);
  }
  const hit = lines.find((line) => MISSING_CMD_LINES.some((re) => re.test(line)));
  if (hit === undefined) return null;
  const name = missingCommand(hit);
  if (name === null) {
    return "启动命令里有个东西没找到（日志里那句 not found）。两种可能，对号入座：\n"
      + "① 它是这个项目 node 依赖里的可执行文件 —— 任务 worktree 是干净检出，"
      + "node_modules 不在里面。ash 起预览前会自己在项目外备一份挂进来（`data/deps`），"
      + "这次没备成；手工的话把主仓装好的那份软链进来即可"
      + "（`ln -s <项目目录>/<子项目>/node_modules <任务工作区>/<子项目>/node_modules`，"
      + "Windows 用 `mklink /J`）。别把 install 写进预览命令 —— 那会在你的工作区里改写"
      + "锁文件，跟着任务 diff 走进验收。\n"
      + "② 它是一门运行时、包管理器或构建工具（node / pnpm / mvn / dotnet / go / python…）"
      + "—— 那就是没装，或者不在 ash 起预览那个 shell 的 PATH 上，跟 node_modules 无关。";
  }
  const bare = bareName(name);
  if (NODE_RUNTIMES.has(bare)) return runtimeMissingHint(bare);
  return NODE_BINS.has(bare)
    ? nodeModulesHint(`\`${bare}\` 没找到，看着像这个工作区里没装依赖`, advice, tried)
    : runtimeMissingHint(bare);
}

function bareName(name: string): string {
  return (name.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").split(/[\\/]/).pop() ?? name).toLowerCase();
}

/**
 * 日志里那个没找到的东西，**如果它是项目依赖里的可执行文件**，就是它的名字；否则 null。
 *
 * 给 nodeDepsAdvice 当 `want` 用：知道这次缺的是 `vite`，才分得清「node_modules 在那儿」
 * 和「node_modules 里有这次要的东西」—— `--prod` 装出来的树、装了一半的树都属于前者。
 */
export function missingNodeBin(log: string): string | null {
  const lines = stripAnsi(log).split("\n").map((line) => line.trimEnd());
  const hit = lines.find((line) => MISSING_CMD_LINES.some((re) => re.test(line)));
  const name = hit === undefined ? null : missingCommand(hit);
  if (name === null) return null;
  const bare = bareName(name);
  return NODE_BINS.has(bare) ? bare : null;
}

/** 日志里印出来的本机地址。`lent` 为真表示它就落在我们借出去的那个端口上。 */
export interface PreviewUrl {
  url: string;
  port: number;
  lent: boolean;
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?[^\s'"]*/gi;

/**
 * 地址尾巴上粘着的标点。日志是写给人看的散文，`[dev] …，/api 打到 http://127.0.0.1:4317。`
 * 这种「一句话里嵌一个地址」的写法会把句号一并收进来 —— URL_RE 认到「空白或引号为止」，
 * 而句号既不是空白也不是引号，全角的更躲不开。
 *
 * 坏法跟 ANSI 那条不一样，更响：带标点的地址会原样存进 preview.json，用户点开预览时
 * `new URL(service.url)` 当场抛，Hono 兜底成一句 **Internal Server Error** —— 服务好好地
 * 跑着，用户只看到一句英文报错，日志里也没有一行说得清是哪一步坏的。
 *
 * 所以只保留 URL 末尾真正可能出现的字符，其余从尾巴上一路剥掉。
 */
const URL_TAIL_RE = /[^A-Za-z0-9/_~%+=&#$*@-]+$/;

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
 * `excluded` 是「**按定义就不可能是预览本尊**」的那些端口，两类：
 * ① ash 借给**配角**的那几个（`$PORT2…`，见 preview.ts 的 portEnv）——一条同时起前后端的
 *    命令里，后端多半比前端先起来并印一句「Tomcat started on port 35725」，不排除的话预览
 *    就会稳定地指到后端上：前端还在编译，用户已经被领到一个返回 JSON 的地址前面了；
 * ② **ash 自己监听的那个端口**——预览的日志里出现它只有一种可能，就是命令在说「我的 /api
 *    打到 ash 那边」（scripts/dev.mjs 的 frontend 档正是这么印的）。认了它，用户点开预览
 *    看到的是 ash 本尊，而代理还得自己转给自己。
 * 两类都不靠猜：端口是 ash 自己借出去 / 自己绑上的，谁拿了它一清二楚。
 *
 * 日志里一个地址都没有时，退而求其次认「起在某个端口」的自述（见 announcedPort）——
 * 非 Node 的服务常常只说端口不说地址。
 */
export function pickPreviewUrl(
  log: string,
  lent: number | null,
  excluded: readonly number[] = [],
): PreviewUrl | null {
  const skip = new Set(excluded.filter((port) => port !== lent));
  let first: PreviewUrl | null = null;
  // 先剥 ANSI 再扫地址。URL_RE 收到「空白/引号为止」，而着色后的行是
  // `http://localhost:5173/\x1b[39m` —— 控制码不是空白也不是引号，会被原样收进地址，
  // 存进 preview.json、再交给浏览器打开。端口连得上，所以一路判成「起好了」，用户点开
  // 得到的却是 `/%1B[39m` 这条 404 路径：服务是好的、根页面是好的，表现仍然是「预览
  // 打不开」。这一条在这儿修，不在正则里加特例 —— 着色是整段日志的属性，不是 URL 的。
  const clean = stripAnsi(log);
  for (const hit of clean.matchAll(URL_RE)) {
    const url = hit[0].replace(URL_TAIL_RE, "");
    const port = Number(hit[1] ?? (url.startsWith("https") ? 443 : 80));
    if (lent !== null && port === lent) return { url, port, lent: true };
    if (skip.has(port)) continue;
    first ??= { url, port, lent: false };
  }
  if (first) return first;
  const port = announcedPort(clean, skip);
  return port === null ? null : { url: `http://localhost:${port}/`, port, lent: lent === port };
}

