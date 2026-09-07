// 「这个项目怎么起一个能看的服务」——**跟语言无关**的单点。
//
// 这个模块存在的理由就是一次判断失误：预览最早只会一件事 —— 读根目录 package.json 的
// dev/start。于是一个 Java 项目点「打开预览」，收到的是「工作区没有 package.json」，
// 而唯一的出路是让人家往 Java 仓库里加一个 Node 的文件。**那不是给 Java 项目做预览，
// 那是要求它先变成 Node 项目。**
//
// 现在的判据只有两条，两条都不提任何一种语言：
//   ① 项目设置里填了命令 → 一个字不改地跑（这条永远优先，任何语言、任何私有启动方式）。
//   ② 没填 → 按各语言**自己的**惯例找「能起服务的东西」：Maven 的 spring-boot:run、
//      Gradle 的 bootRun、Django 的 runserver、go run、cargo run、dotnet run…… Node 的
//      package.json 只是这张表里的一行，不再是这件事的定义。
//
// 找出来的候选 **只有恰好一个时才自动用**。多于一个（前后端并排、Maven 多模块各带一个
// 可启动应用）就不猜：把认出来的东西按它自己的说法列出来，每条都是可以直接粘进
// 「预览命令」的整行，让用户指一个。猜错的代价不是「少省一次事」，是他对着别的服务
// 验收自己的改动。
//
// 端口同理：**没有一个通用写法**。有的运行时读环境变量（各家变量名还不一样），有的压根
// 不读、只认命令行参数。所以每个候选都得自己说清楚「端口怎么进来」——那件事由下面的
// PortDelivery 表达，主角那一份的环境变量名单由 PORT_ENV_ALIASES 导出给 preview.ts 注入。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 命令从哪儿来的。时间线与报错文案要分得开「你填的」和「我认出来的」。 */
export type PreviewCommandSource = "configured" | "detected";

export interface PreviewCommandResolution {
  command: string;
  source: PreviewCommandSource;
}

/** 认出来的一个「可以起起来的东西」。label 用它自己那门语言的说法。 */
export interface PreviewCandidate {
  label: string;
  /** 整行命令，可以直接粘进「预览命令」；需要进子目录的自带 cd。 */
  command: string;
  /**
   * 这东西是「拿来看的」还是「给别人当后台的」。只影响一件事：一份前后端并排的仓库里，
   * 组合示例该把谁放在最后（ash 打开的是 `$PORT` 上那个，也就是最后那个）。
   */
  kind: "web" | "service";
  /**
   * 当**配角**跑在第 n 个借来的端口上时的写法（n 从 2 起，对应 `$PORTn` / `$URLn`）。
   * 用 `( … &)` 丢后台：一条预览命令里前后端一起起时，前面那些不能把 shell 占住。
   */
  sidekick(n: number): string;
}

const has = (dir: string, name: string) => existsSync(join(dir, name));

function read(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/**
 * 端口怎么进到这门运行时里。**每种运行时的答案都不一样**，而且不问清楚就没法把同一个
 * 东西改写成「跑在另一个端口上的配角」：
 *
 *   · `env` —— 它认某个环境变量。名字各叫各的（Node 的 `PORT`、Spring Boot 的
 *     `SERVER_PORT`、ASP.NET Core 的 `ASPNETCORE_URLS`），值也不一定就是个数字，
 *     所以带一个模板（`$PORT` / `http://localhost:$PORT`）。
 *   · `inline` —— 它根本不读环境变量，端口写在命令行参数里（Django 的 `runserver`、
 *     Laravel 的 `--port=`、vite 的 `--port`）。换端口就是把命令里的 `$PORT` 换掉。
 *
 * 「随便挑一种、剩下的听天由命」是不行的：给 vite 塞 `PORT` 它照样起在配置里那个端口上
 * （vite 6 实测），给一个只认 `PORT` 的程序塞 `--port` 则直接报未知参数。两种错法都是
 * 「ash 借了端口、命令没吃」——用户看到的是预览起在一个谁也没约定的端口上。
 */
type PortDelivery =
  | { via: "env"; name: string; template: string }
  | { via: "inline" };

const envPort = (name: string, template = "$PORT"): PortDelivery => ({ via: "env", name, template });
const INLINE: PortDelivery = { via: "inline" };

/**
 * 「主角端口」要以哪些名字递进去（`$PORT` 换成真端口后由 preview.ts 注入环境）。
 *
 * 一个端口、一串名字，因为**每种运行时读的变量名都不一样**，而 ash 事先并不知道这条命令
 * 是哪门语言 —— 填过「预览命令」的项目根本不走下面的识别，那条命令可以是任何东西。多注
 * 几个名字的代价只是日志头长一点；漏注一个的代价是那门语言的预览一律起在写死的端口上。
 *
 * 名字都在各家自己的命名空间里（`ASPNETCORE_` / `QUARKUS_` / `FLASK_RUN_`），不会误伤
 * 别人的程序；`PORT` / `SERVER_PORT` 这两个泛用名本来就是「给我一个端口」的意思。
 */
export const PORT_ENV_ALIASES: ReadonlyArray<{ name: string; template: string }> = [
  { name: "PORT", template: "$PORT" }, // Node（Next/CRA/Nest/Express/Nuxt）、Go、Rust、一票 PaaS
  { name: "SERVER_PORT", template: "$PORT" }, // Spring Boot 宽松绑定 → server.port
  { name: "ASPNETCORE_URLS", template: "http://localhost:$PORT" }, // ASP.NET Core（它不读 PORT）
  { name: "QUARKUS_HTTP_PORT", template: "$PORT" }, // Quarkus
  { name: "FLASK_RUN_PORT", template: "$PORT" }, // Flask 的 CLI
];

/** 进子目录的前缀。`.` 表示就在工作区根上，不加 cd。 */
function prefixed(rel: string, command: string): string {
  return rel === "." ? command : `cd ${rel} && ${command}`;
}

/**
 * 把「在哪个目录、跑什么、端口怎么进去」组装成一个候选。
 *
 * `port` 说的是**这门运行时从哪儿拿端口**（见 PortDelivery）。分清这件事才谈得上「同一个
 * 东西当配角时怎么写」—— 而那正是前后端一起起时唯一麻烦的地方：环境变量那一类换变量名
 * 后面的值，命令行参数那一类换命令里的 `$PORT`。
 */
function candidate(
  label: string,
  rel: string,
  bare: string,
  port: PortDelivery,
  kind: "web" | "service",
): PreviewCandidate {
  return {
    label,
    kind,
    command: prefixed(rel, bare),
    sidekick(n: number): string {
      const ref = `$PORT${n}`;
      const body = port.via === "inline"
        ? bare.replaceAll("$PORT", ref)
        : `${port.name}=${port.template.replaceAll("$PORT", ref)} ${bare}`;
      return rel === "." ? `(${body} &)` : `(cd ${rel} && ${body} &)`;
    },
  };
}

function relJoin(rel: string, name: string): string {
  return rel === "." ? name : `${rel}/${name}`;
}

/** 候选名里的「哪个目录」。根目录没有目录名可说，就说「这个项目」。 */
function where(rel: string): string {
  return rel === "." ? "这个项目" : rel;
}

// ── 各语言的探子 ────────────────────────────────────────────────────────────
// 每个探子只回答「这个目录里有没有一个能起服务的东西」。它们互不知情，顺序不代表优先级
// —— 只有恰好一个候选时才会被自动采用，多个一律回去问用户。

/**
 * 前端 dev server 里有一大半**根本不读 PORT**，端口只认命令行参数。
 *
 * 这条不是推测，是实测（vite 6）：`PORT=41111 vite` 起在配置里写的 3000 上，`vite --port
 * 41111` 才落到 41111 —— 而 `port: Number(env.VITE_APP_PORT || 3000)` 正是 vite 项目最常见的
 * 写法。也就是说，只给环境变量的话，ash 借的端口对**整个 vite 生态**都是白借的：命令起在
 * 一个谁也没约定的端口上，「借出去的端口连得上就是它」这条就绪判据（preview.ts）当场失效。
 *
 * 反过来也不能一律加 `--port`：Next / CRA / Nest / Nuxt / Express 认 `PORT`，多给一个未知
 * 参数有的直接报错退出。所以这张表只放**确认吃 `--port` 且不吃 `PORT`** 的那几个，其余
 * 一律走环境变量。
 */
const PORT_ARG_TOOLS = new Set(["vite", "astro", "ng"]);

/** 脚本正文的第一条命令是不是那几个「端口只认参数」的工具。 */
function portArgTool(body: string): boolean {
  // 复合命令不动它：`&&` 串起来的、管道、concurrently 起一排 —— 追加的 `--port` 会落到
  // 最后一条命令或者干脆落给 concurrently 自己，写出来的是一条**看着像对的坏命令**。
  if (/[&|;<>]/.test(body) || /\b(?:concurrently|npm-run-all|run-[ps])\b/.test(body)) return false;
  const tokens = body.trim().split(/\s+/);
  let i = 0;
  // `cross-env NODE_ENV=dev vite` / `FOO=1 vite` 这种前缀跳过去再看真正的命令。
  while (i < tokens.length && (tokens[i] === "cross-env" || /^[A-Za-z_]\w*=/.test(tokens[i]))) i += 1;
  return PORT_ARG_TOOLS.has(tokens[i] ?? "");
}

/** Node：dev / start 脚本 + 按锁文件选包管理器；端口按脚本里跑的是谁来定怎么给。 */
function nodeCandidates(dir: string, rel: string): PreviewCandidate[] {
  const raw = read(join(dir, "package.json"));
  if (raw === null) return [];
  let scripts: Record<string, unknown> = {};
  try { scripts = (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts ?? {}; }
  catch { return []; }
  const script = typeof scripts.dev === "string" ? "dev" : typeof scripts.start === "string" ? "start" : null;
  if (!script) return [];
  const body = String(scripts[script]);
  const pm = has(dir, "pnpm-lock.yaml") ? "pnpm" : has(dir, "yarn.lock") ? "yarn" : "npm";
  const base = pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`;
  const label = `${where(rel)}（Node · ${pm} ${script}）`;
  // npm / pnpm 要一个 `--` 才把后面的参数交给脚本本身；yarn 1 直接透传。
  if (portArgTool(body)) {
    const command = pm === "yarn" ? `${base} --port $PORT` : `${base} -- --port $PORT`;
    return [candidate(label, rel, command, INLINE, "web")];
  }
  return [candidate(label, rel, base, envPort("PORT"), "web")];
}

/** pom.xml 里声明的子模块（`<modules>` 段）。不是聚合 pom 就返回空。 */
function mavenModules(pom: string): string[] {
  const block = /<modules>([\s\S]*?)<\/modules>/i.exec(pom)?.[1];
  if (!block) return [];
  return [...block.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/gi)].map((m) => m[1]);
}

/** 这个 pom 自己能不能起来（挂了 spring-boot-maven-plugin）。 */
function mavenRunnable(pom: string): boolean {
  return /spring-boot-maven-plugin/i.test(pom);
}

/**
 * Maven。三件事分开：
 *  · **wrapper 有没有**决定命令是 `./mvnw` 还是 `mvn` —— 写死 `./mvnw` 在没有 wrapper 的
 *    仓库里是一条必然失败的命令（a4sms 就没有 wrapper，这是实测踩到的）。
 *  · **聚合 pom 不是应用**：它带 `<modules>`，自己起不来，得下探到子模块。
 *  · 多模块里**每个能起来的模块都是一个候选**，各自给出 `-pl <模块>` 的整行命令。
 */
function mavenCandidates(dir: string, rel: string, depth = 0): PreviewCandidate[] {
  const pom = read(join(dir, "pom.xml"));
  if (pom === null) return [];
  const runner = has(dir, "mvnw") ? "./mvnw" : "mvn";
  const modules = mavenModules(pom);
  if (!modules.length) {
    return mavenRunnable(pom)
      ? [candidate(`${where(rel)}（Maven · Spring Boot）`, rel, `${runner} spring-boot:run`, envPort("SERVER_PORT"), "service")]
      : [];
  }
  if (depth >= 2) return []; // 嵌套聚合到此为止，再深就该用户自己填了
  const found: PreviewCandidate[] = [];
  for (const name of modules) {
    const child = join(dir, name);
    const childPom = read(join(child, "pom.xml"));
    if (childPom === null) continue;
    if (mavenModules(childPom).length) {
      found.push(...mavenCandidates(child, relJoin(rel, name), depth + 1));
      continue;
    }
    if (!mavenRunnable(childPom)) continue;
    // `-pl <模块>` 从聚合目录跑；依赖模块没装进本地仓库时要自己补 `-am`，这条写在
    // 报错文案里，不替用户塞进命令 —— `-am` 会把 spring-boot:run 也带到库模块上。
    found.push(candidate(
      `${relJoin(rel, name)}（Maven 模块 · Spring Boot）`,
      rel,
      `${runner} -pl ${name} spring-boot:run`,
      envPort("SERVER_PORT"),
      "service",
    ));
  }
  return found;
}

/** Gradle：同样先看 wrapper 在不在。 */
function gradleCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, "build.gradle") && !has(dir, "build.gradle.kts")) return [];
  const runner = has(dir, "gradlew") ? "./gradlew" : "gradle";
  return [candidate(`${where(rel)}（Gradle · bootRun）`, rel, `${runner} bootRun`, envPort("SERVER_PORT"), "service")];
}

/**
 * POSIX 上 `python` 常常根本不存在（Debian、Ubuntu、macOS 都只给 `python3`），把它写进
 * 命令就是一条必然失败的命令；Windows 反过来，官方安装包给的就是 `python`。
 */
const PY = process.platform === "win32" ? "python" : "python3";

/** 源码里 `app = FastAPI()` / `app = Flask(__name__)` 那一行 —— 起命令要的就是这个名字。 */
const ASGI_RE = /^\s*([A-Za-z_]\w*)\s*=\s*FastAPI\s*\(/m;
const WSGI_RE = /^\s*([A-Za-z_]\w*)\s*=\s*Flask\s*\(/m;
/** 入口文件的惯用名先看，剩下的 .py 再看几个 —— 不做全仓扫描，这只是认个门牌。 */
const PY_ENTRIES = ["main.py", "app.py", "asgi.py", "wsgi.py", "server.py", "api.py"];

/**
 * Django 之外的 Python web 应用。
 *
 * 跟别的语言不一样，Python 这边**没有一个「项目文件」能说明它是个 web 服务**：
 * `pyproject.toml` / `requirements.txt` 满仓都是，脚本、库、notebook 也长这样。真正没有
 * 歧义的信号只有源码里那句 `app = FastAPI()` —— 而且顺带把起命令要的 `模块:变量` 也说了。
 */
function pythonWebApp(dir: string): { framework: "fastapi" | "flask"; target: string } | null {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".py")); } catch { return null; }
  const ordered = [
    ...PY_ENTRIES.filter((name) => names.includes(name)),
    ...names.filter((name) => !PY_ENTRIES.includes(name)).sort(),
  ];
  for (const name of ordered.slice(0, 12)) {
    const src = read(join(dir, name));
    if (src === null) continue;
    const module = name.slice(0, -3);
    const asgi = ASGI_RE.exec(src);
    if (asgi) return { framework: "fastapi", target: `${module}:${asgi[1]}` };
    const wsgi = WSGI_RE.exec(src);
    if (wsgi) return { framework: "flask", target: module };
  }
  return null;
}

/** Python：Django 的 manage.py 最没有歧义；没有它就去源码里找 FastAPI / Flask。 */
function pythonCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (has(dir, "manage.py")) {
    return [candidate(`${where(rel)}（Django）`, rel, `${PY} manage.py runserver 0.0.0.0:$PORT`, INLINE, "web")];
  }
  const app = pythonWebApp(dir);
  if (!app) return [];
  // 一律 `python3 -m`：uvicorn / flask 装在虚拟环境里时未必在 PATH 上，但模块一定在。
  return app.framework === "fastapi"
    ? [candidate(`${where(rel)}（FastAPI · uvicorn）`, rel, `${PY} -m uvicorn ${app.target} --host 0.0.0.0 --port $PORT`, INLINE, "service")]
    : [candidate(`${where(rel)}（Flask）`, rel, `${PY} -m flask --app ${app.target} run --host 0.0.0.0 --port $PORT`, INLINE, "service")];
}

/** Go：根上的 main.go，或者 `cmd/<名字>/main.go` 这种最常见的多入口布局。 */
function goCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, "go.mod")) return [];
  if (has(dir, "main.go")) return [candidate(`${where(rel)}（Go）`, rel, "go run .", envPort("PORT"), "service")];
  let entries: string[] = [];
  try {
    entries = readdirSync(join(dir, "cmd"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && has(join(dir, "cmd", e.name), "main.go"))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
  return entries.map((name) => candidate(
    `${relJoin(rel, `cmd/${name}`)}（Go）`,
    rel,
    `go run ./cmd/${name}`,
    envPort("PORT"),
    "service",
  ));
}

function rustCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, "Cargo.toml")) return [];
  return [candidate(`${where(rel)}（Rust · cargo run）`, rel, "cargo run", envPort("PORT"), "service")];
}

/** .NET：ASP.NET Core **不读 PORT**，它认 `ASPNETCORE_URLS`（要的还是整条地址，不是端口）。 */
function dotnetCandidates(dir: string, rel: string): PreviewCandidate[] {
  let hit = false;
  try { hit = readdirSync(dir).some((name) => name.endsWith(".csproj") || name.endsWith(".fsproj")); }
  catch { return []; }
  if (!hit) return [];
  return [candidate(
    `${where(rel)}（.NET）`,
    rel,
    "dotnet run",
    envPort("ASPNETCORE_URLS", "http://localhost:$PORT"),
    "service",
  )];
}

function phpCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, "artisan")) return [];
  return [candidate(`${where(rel)}（Laravel）`, rel, "php artisan serve --port=$PORT", INLINE, "web")];
}

function rubyCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, join("bin", "rails"))) return [];
  return [candidate(`${where(rel)}（Rails）`, rel, "bin/rails server -p $PORT", INLINE, "web")];
}

function probeDir(dir: string, rel: string): PreviewCandidate[] {
  return [
    ...nodeCandidates(dir, rel),
    ...mavenCandidates(dir, rel),
    ...gradleCandidates(dir, rel),
    ...pythonCandidates(dir, rel),
    ...goCandidates(dir, rel),
    ...rustCandidates(dir, rel),
    ...dotnetCandidates(dir, rel),
    ...phpCandidates(dir, rel),
    ...rubyCandidates(dir, rel),
  ];
}

/** 扫描时跳过的目录名：产物和依赖目录里全是假信号（node_modules 里每个包都有 package.json）。 */
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "out", "vendor", "venv", "__pycache__"]);

/**
 * 工作区里所有「能起服务的东西」。根目录 + 往下一层 —— 前后端并排的多项目仓库是常态，
 * 只看根目录等于对这类仓库一无所知（Maven 的子模块由 mavenCandidates 自己按 pom 下探，
 * 不受这一层限制）。
 */
export function detectPreviewCandidates(root: string): PreviewCandidate[] {
  const found = [...probeDir(root, ".")];
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return found;
  }
  for (const name of entries) found.push(...probeDir(join(root, name), name));
  return found;
}

/**
 * 前后端并排的仓库里，「一条命令同时起几个」该怎么写。
 *
 * 这是多模块项目真正卡住的地方，而且卡的不是命令怎么写，是**端口**：ash 借的端口是随机的
 * （不随机就会跟用户自己那份、跟另一个任务的预览撞车），可前端要在启动那一刻就知道后端
 * 落在哪儿。谁也猜不到谁，只有借端口的那个人能同时告诉两边 —— 所以 ash 一次借一串，
 * `$PORT` 给要看的那个，`$PORT2…` / `$URL2…` 给配角（见 preview.ts 的 portEnv）。
 *
 * 生成的示例把配角丢后台、要看的那个放最后（ash 打开的是 `$PORT` 上那个）。前端拿什么
 * 变量名去认后端地址是它自己的事（vite 项目多半是 `VITE_*_URL`），这里只能把 `$URL2`
 * 递到手边并说清楚 —— 替他猜变量名只会写出一条看着像对的假命令。
 */
function combinedExample(candidates: PreviewCandidate[]): string | null {
  const web = candidates.filter((c) => c.kind === "web");
  const services = candidates.filter((c) => c.kind === "service");
  if (web.length !== 1 || !services.length) return null;
  const sidekicks = services.slice(0, 3).map((c, index) => c.sidekick(index + 2));
  // 分隔符是 `;` 而不是空格：`( … &)` 是一个复合命令，POSIX shell 要求它后面跟分隔符，
  // 少一个分号整条命令连语法都过不了（`syntax error near unexpected token`）—— 而这条是
  // 直接给用户粘走的，粘过去起不来比不给还糟。
  return `${[...sidekicks, web[0].command].join(" ; ")}`;
}

/** 认出不止一个（或一个都没有）时说的那段话：一句为什么，一份清单，一个去处。 */
export function ambiguousMessage(candidates: PreviewCandidate[]): string {
  if (!candidates.length) {
    return "没认出这个项目该怎么起服务（Node 的 dev/start、Maven 的 spring-boot:run、"
      + "Gradle 的 bootRun、Django 的 runserver、FastAPI/Flask、go run、cargo run、"
      + "dotnet run、Laravel 的 artisan、Rails 的 bin/rails 都找过了）。\n"
      + "请在「设置 → 项目设置 → 预览命令」里填一条启动命令 —— 任何语言都行，"
      + "它在任务工作区根目录用你自己的 shell 执行，可以带 cd。\n"
      + `端口从 ash 借的那个来：命令里写 \`$PORT\`，或者让它读这些环境变量之一（${PORT_ENV_ALIASES.map((a) => a.name).join(" / ")}）。`;
  }
  const list = candidates.map((c) => `  · ${c.label}\n    ${c.command}`).join("\n");
  const combined = combinedExample(candidates);
  return `这个工作区里认出了 ${candidates.length} 个能起服务的东西，ash 不替你挑`
    + "（挑错的话你会对着另一个服务验收自己的改动）：\n"
    + `${list}\n`
    + "把要看的那一条填进「设置 → 项目设置 → 预览命令」，之后这个项目就一直用它。\n"
    + (combined
      ? "要**前后端一起起**就写成一条：配角丢后台、用 `$PORT2`/`$PORT3`…，要看的那个放最后用 `$PORT`。\n"
        + `    ${combined}\n`
        + "前端得知道后端地址的话，把 `$URL2`（= `http://localhost:$PORT2`）递给它自己认的那个变量，"
        + "例如 `VITE_APP_API_URL=$URL2 pnpm run dev` —— 变量名看你前端读的是哪个，ash 不替你猜。\n"
      : "")
    + "上面的命令是各自最常见的写法，你的项目另有讲究就照着改"
    + "（例如 Maven 多模块首次跑要先把依赖模块装进本地仓库：`mvn -pl <模块> -am install -DskipTests`）。";
}

/**
 * 定下这次预览跑什么。
 *
 * 填过的原样用；没填就看认出几个 —— **恰好一个才自动用**，其余情况抛出上面那段话。
 * cwd 是任务自己的工作区（worktree），不是项目仓库根：子目录、子模块都得跟着它算。
 */
export function resolvePreviewCommand(cwd: string, configured: string | null | undefined): PreviewCommandResolution {
  const chosen = (configured ?? "").trim();
  if (chosen) return { command: chosen, source: "configured" };
  const candidates = detectPreviewCandidates(cwd);
  if (candidates.length === 1) return { command: candidates[0].command, source: "detected" };
  throw new Error(ambiguousMessage(candidates));
}
