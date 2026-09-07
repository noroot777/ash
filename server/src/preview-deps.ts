// 「这个工作区缺 node 依赖」时，**可借的那一份到底在不在**。
//
// 起因是一条说了等于没说的建议。预览命令因为 `vite: not found` 退出时，ash 给的下一步是
// 「把主仓已经装好的那份 node_modules 软链进来」——那句话有两个假设，而目标项目
// （a4sms-allinone）两个都不成立：
//   ① 假设用户知道该软链哪两条路径。文案里写的是 `<项目目录>/<子项目>` 这样的占位符。
//   ② **假设主仓那份存在**。实测 `/workspace/a4sms-allinone/a4sms-front/node_modules`
//      根本不存在 —— 于是这条建议指向一个不存在的源目录，照着做只会得到一个断链。
//
// 所以这里不生成文案，只**核对事实**：哪个包目录缺依赖、按锁文件该用哪个包管理器、主仓
// 里对应的那份在不在。措辞交给 preview-log.ts，它据此说真话：能借就把两条真实路径直接
// 写出来（可以整行粘走），借不到就明说「主仓那份也没有」，并指出唯一不写任务工作区的
// 那条路 —— 在**用户自己的主仓**里装一次。
//
// ash 仍然不替他装，理由没变（见 preview-log.ts 的 nodeModulesHint）：install 写进任务
// 工作区会改 lock 文件，而 lock 文件是跟踪文件，会跟着任务 diff 一路走进验收。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 一个缺依赖的包目录，以及它能从哪儿借。 */
export interface NodeDepsAdvice {
  /** 相对工作区的包目录；`.` = 工作区根。 */
  rel: string;
  /** 按锁文件认出来的包管理器 —— 装的时候得用对，不然锁文件对不上。 */
  pm: "npm" | "pnpm" | "yarn";
  /** 该软链到哪（任务工作区里的绝对路径）。 */
  target: string;
  /** 主仓里对应的那个包目录；null = 这个工作区就是主仓本身（没有别处可借）。 */
  sourceDir: string | null;
  /** 主仓那份 node_modules 的绝对路径；null 同上。 */
  source: string | null;
  /** 那份到底在不在。**这条就是这个模块存在的理由。** */
  sourceReady: boolean;
}

/** 扫描时跳过的目录名（跟 preview-command.ts 同一份理由：产物和依赖目录里全是假信号）。 */
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "out", "vendor", "venv", "__pycache__"]);

/**
 * 任务 worktree 对应的主仓。
 *
 * git 的 worktree 里 `.git` 是个**文件**，内容是 `gitdir: <主仓>/.git/worktrees/<名字>`
 * —— 主仓路径就写在那儿，不用调用方一路传下来。`.git` 是目录则说明这本来就是主仓，
 * 没有「别处那一份」可借。
 */
function mainRepoOf(workspace: string): string | null {
  const dotGit = join(workspace, ".git");
  let raw: string;
  try { raw = readFileSync(dotGit, "utf8"); } catch { return null; } // 目录（主仓）或读不到
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(raw)?.[1];
  if (!gitdir) return null;
  const marker = gitdir.replace(/\\/g, "/").indexOf("/.git/worktrees/");
  if (marker < 0) return null;
  const repo = gitdir.slice(0, marker);
  return repo && repo !== workspace ? repo : null;
}

function packageManager(dir: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** 这个目录是个 node 包、而且**没有** node_modules。 */
function needsDeps(dir: string): boolean {
  return existsSync(join(dir, "package.json")) && !existsSync(join(dir, "node_modules"));
}

/**
 * 工作区里缺依赖的包目录，逐个核对「能从主仓借到吗」。
 *
 * 只看根目录和往下一层 —— 跟识别预览候选同一个口径（前后端并排是常态），再深就不是
 * 「点一下预览」该替人想的事了。一个都不缺就返回空数组。
 *
 * `command` 传的是这次跑的预览命令：一个仓库里可以有好几个 node 子项目都没装依赖
 * （a4sms-allinone 有 `a4sms-app` 和 `a4sms-front` 两个），但**这次卡住的只有命令里那个**。
 * 名字在命令里出现过的排到最前面，用户一眼看到的就是他这次要的那条。
 */
export function nodeDepsAdvice(workspace: string, command = ""): NodeDepsAdvice[] {
  const repo = mainRepoOf(workspace);
  const rels: string[] = [];
  if (needsDeps(workspace)) rels.push(".");
  try {
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      if (needsDeps(join(workspace, entry.name))) rels.push(entry.name);
    }
  } catch { /* 工作区读不动就只回根目录那一条 */ }
  const mentioned = (rel: string) => rel !== "." && command.includes(rel);
  rels.sort((a, b) => Number(mentioned(b)) - Number(mentioned(a)));
  return rels.map((rel) => {
    const dir = rel === "." ? workspace : join(workspace, rel);
    const sourceDir = repo === null ? null : (rel === "." ? repo : join(repo, rel));
    const source = sourceDir === null ? null : join(sourceDir, "node_modules");
    return {
      rel,
      pm: packageManager(dir),
      target: join(dir, "node_modules"),
      sourceDir,
      source,
      sourceReady: source !== null && existsSync(source),
    };
  });
}
