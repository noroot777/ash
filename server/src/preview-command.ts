// 「这个任务的预览该跑哪条命令」——自由工作流预览的命令来源，单独一个模块因为它是
// **纯的**（只读文件系统、不起进程、不进库），回归测试 test:preview-command 直接钉它。
//
// 两个来源，优先级写死：
//   ① 项目设置里填的那条（projects.preview_command）——用户说了算，一个字不改地跑。
//   ② 没填才自动推导。推导**只认 Node**：根目录 package.json 的 dev/start 脚本。
//
// 为什么不给 Java/Python/Go 也来一套自动推导：那些语言的「起个能看的服务」不是一条
// 命令能猜准的（Maven 多模块要挑 -pl 哪个模块、Spring 要选 profile、Django 要先迁移），
// 猜错的代价是用户等两分钟拿到一句看不懂的报错。所以对它们只做一件事：**在报错里把
// 认出来的项目类型和一条可以照抄的示例命令说清楚**，然后请他去项目设置里填一次。
// 填完之后所有语言一视同仁 —— 命令是在任务工作区根目录用用户自己的 shell 跑的，
// `cd a4sms-front && pnpm run dev`、`./mvnw spring-boot:run` 都成立。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 命令从哪儿来的。时间线/报错文案要分得开「你填的」和「我猜的」。 */
export type PreviewCommandSource = "configured" | "derived";

export interface PreviewCommandResolution {
  command: string;
  source: PreviewCommandSource;
}

/** 单个目录里的 Node 预览命令；不是 Node 项目 / 没有 dev|start 脚本回 null。 */
function nodeCommandIn(dir: string): string | null {
  const packageJson = join(dir, "package.json");
  if (!existsSync(packageJson)) return null;
  let scripts: Record<string, unknown> = {};
  try { scripts = JSON.parse(readFileSync(packageJson, "utf8")).scripts ?? {}; }
  catch { return null; }
  const script = typeof scripts.dev === "string" ? "dev" : typeof scripts.start === "string" ? "start" : null;
  if (!script) return null;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return `pnpm run ${script}`;
  if (existsSync(join(dir, "yarn.lock"))) return `yarn ${script}`;
  return `npm run ${script}`;
}

/** 根目录不行时，往下看一层：多项目仓库（front/back/app 并排）的常态。 */
function subdirCandidates(cwd: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries) {
    const command = nodeCommandIn(join(cwd, name));
    if (command) found.push(`cd ${name} && ${command}`);
  }
  return found;
}

/**
 * 认得出来的非 Node 项目 → 一条可以照抄的示例命令。**只用于报错文案**，不会被拿去跑：
 * 这些命令十有八九还要用户自己补模块名/profile/端口，替他做主只会把「起不来」换成
 * 「起来了但不是他要的那个」。
 */
function foreignHints(cwd: string): string[] {
  const has = (name: string) => existsSync(join(cwd, name));
  const hints: string[] = [];
  if (has("pom.xml")) hints.push("Maven 项目：./mvnw spring-boot:run（多模块仓库要指定模块，如 ./mvnw -pl <模块目录> spring-boot:run）");
  if (has("build.gradle") || has("build.gradle.kts")) hints.push("Gradle 项目：./gradlew bootRun");
  if (has("manage.py")) hints.push("Django 项目：python manage.py runserver");
  if (has("pyproject.toml") || has("requirements.txt")) hints.push("Python 项目：如 uvicorn app.main:app --reload --port $PORT");
  if (has("go.mod")) hints.push("Go 项目：go run .");
  if (has("Cargo.toml")) hints.push("Rust 项目：cargo run");
  if (has("Gemfile")) hints.push("Ruby 项目：bundle exec rails server");
  if (has("composer.json")) hints.push("PHP 项目：php artisan serve");
  return hints;
}

/** 推导失败时说的那段话：为什么不行、这个仓库里认出了什么、下一步去哪儿填。 */
export function derivationFailure(cwd: string, why: string): string {
  const lines = [`${why}（自动推导只认 Node 项目根目录 package.json 里的 dev / start 脚本）。`];
  const subdirs = subdirCandidates(cwd);
  const foreign = foreignHints(cwd);
  if (subdirs.length) {
    lines.push(`这个仓库的子目录里有可以直接跑的：${subdirs.map((s) => `\`${s}\``).join("、")}。`);
  }
  for (const hint of foreign) lines.push(hint);
  lines.push("请在「设置 → 项目设置 → 预览命令」里填一条，填了之后这个项目的预览就一直用它。命令在任务工作区根目录执行，用你自己的 shell，可以带 cd。");
  return lines.join("\n");
}

/**
 * 定下这次预览跑什么。填过的原样用；没填才推导，推导不出来就抛出一段能照着做的话。
 * cwd 是**任务自己的工作区**（worktree），不是项目仓库根 —— 子目录判断必须跟着它走。
 */
export function resolvePreviewCommand(cwd: string, configured: string | null | undefined): PreviewCommandResolution {
  const chosen = (configured ?? "").trim();
  if (chosen) return { command: chosen, source: "configured" };
  const command = nodeCommandIn(cwd);
  if (command) return { command, source: "derived" };
  throw new Error(derivationFailure(cwd, whyNoNodeCommand(cwd)));
}

/** 推导不出来的三种原因分开说：用户要照着这句话决定下一步做什么。 */
function whyNoNodeCommand(cwd: string): string {
  const packageJson = join(cwd, "package.json");
  if (!existsSync(packageJson)) return "工作区根目录没有 package.json";
  try { JSON.parse(readFileSync(packageJson, "utf8")); }
  catch { return "工作区根目录的 package.json 读不出来"; }
  return "工作区根目录的 package.json 里没有 dev 或 start 脚本";
}
