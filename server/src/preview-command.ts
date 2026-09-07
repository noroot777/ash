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
// 端口在 preview.ts 那边注入（PORT / SERVER_PORT，同样是每种语言各自的惯例），这里生成
// 的命令能带上 $PORT 的就带上。
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
}

const has = (dir: string, name: string) => existsSync(join(dir, name));

function read(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** 进子目录的前缀。`.` 表示就在工作区根上，不加 cd。 */
function prefixed(rel: string, command: string): string {
  return rel === "." ? command : `cd ${rel} && ${command}`;
}

function relJoin(rel: string, name: string): string {
  return rel === "." ? name : `${rel}/${name}`;
}

// ── 各语言的探子 ────────────────────────────────────────────────────────────
// 每个探子只回答「这个目录里有没有一个能起服务的东西」。它们互不知情，顺序不代表优先级
// —— 只有恰好一个候选时才会被自动采用，多个一律回去问用户。

/** Node：dev / start 脚本 + 按锁文件选包管理器。 */
function nodeCandidates(dir: string, rel: string): PreviewCandidate[] {
  const raw = read(join(dir, "package.json"));
  if (raw === null) return [];
  let scripts: Record<string, unknown> = {};
  try { scripts = (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts ?? {}; }
  catch { return []; }
  const script = typeof scripts.dev === "string" ? "dev" : typeof scripts.start === "string" ? "start" : null;
  if (!script) return [];
  const pm = has(dir, "pnpm-lock.yaml") ? "pnpm" : has(dir, "yarn.lock") ? "yarn" : "npm";
  const command = pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`;
  return [{ label: `${rel === "." ? "这个项目" : rel}（Node · ${pm} ${script}）`, command: prefixed(rel, command) }];
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
      ? [{ label: `${rel === "." ? "这个项目" : rel}（Maven · Spring Boot）`, command: prefixed(rel, `${runner} spring-boot:run`) }]
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
    found.push({
      label: `${relJoin(rel, name)}（Maven 模块 · Spring Boot）`,
      // `-pl <模块>` 从聚合目录跑；依赖模块没装进本地仓库时要自己补 `-am`，这条写在
      // 报错文案里，不替用户塞进命令 —— `-am` 会把 spring-boot:run 也带到库模块上。
      command: prefixed(rel, `${runner} -pl ${name} spring-boot:run`),
    });
  }
  return found;
}

/** Gradle：同样先看 wrapper 在不在。 */
function gradleCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, "build.gradle") && !has(dir, "build.gradle.kts")) return [];
  const runner = has(dir, "gradlew") ? "./gradlew" : "gradle";
  return [{ label: `${rel === "." ? "这个项目" : rel}（Gradle · bootRun）`, command: prefixed(rel, `${runner} bootRun`) }];
}

/** Python：Django 的 manage.py 是最没有歧义的一个信号。 */
function pythonCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, "manage.py")) return [];
  return [{
    label: `${rel === "." ? "这个项目" : rel}（Django）`,
    command: prefixed(rel, "python manage.py runserver 0.0.0.0:$PORT"),
  }];
}

function goCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, "go.mod") || !has(dir, "main.go")) return [];
  return [{ label: `${rel === "." ? "这个项目" : rel}（Go）`, command: prefixed(rel, "go run .") }];
}

function rustCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, "Cargo.toml")) return [];
  return [{ label: `${rel === "." ? "这个项目" : rel}（Rust · cargo run）`, command: prefixed(rel, "cargo run") }];
}

function dotnetCandidates(dir: string, rel: string): PreviewCandidate[] {
  let hit = false;
  try { hit = readdirSync(dir).some((name) => name.endsWith(".csproj") || name.endsWith(".fsproj")); }
  catch { return []; }
  if (!hit) return [];
  return [{ label: `${rel === "." ? "这个项目" : rel}（.NET）`, command: prefixed(rel, "dotnet run") }];
}

function phpCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, "artisan")) return [];
  return [{ label: `${rel === "." ? "这个项目" : rel}（Laravel）`, command: prefixed(rel, "php artisan serve --port=$PORT") }];
}

function rubyCandidates(dir: string, rel: string): PreviewCandidate[] {
  if (!has(dir, join("bin", "rails"))) return [];
  return [{ label: `${rel === "." ? "这个项目" : rel}（Rails）`, command: prefixed(rel, "bin/rails server -p $PORT") }];
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

/** 认出不止一个（或一个都没有）时说的那段话：一句为什么，一份清单，一个去处。 */
export function ambiguousMessage(candidates: PreviewCandidate[]): string {
  if (!candidates.length) {
    return "没认出这个项目该怎么起服务（Node 的 dev/start、Maven 的 spring-boot:run、"
      + "Gradle 的 bootRun、Django 的 runserver、go run、cargo run、dotnet run 都找过了）。\n"
      + "请在「设置 → 项目设置 → 预览命令」里填一条启动命令 —— 任何语言都行，"
      + "它在任务工作区根目录用你自己的 shell 执行，可以带 cd。";
  }
  const list = candidates.map((c) => `  · ${c.label}\n    ${c.command}`).join("\n");
  return `这个工作区里认出了 ${candidates.length} 个能起服务的东西，ash 不替你挑`
    + "（挑错的话你会对着另一个服务验收自己的改动）：\n"
    + `${list}\n`
    + "把要看的那一条填进「设置 → 项目设置 → 预览命令」，之后这个项目就一直用它。\n"
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
