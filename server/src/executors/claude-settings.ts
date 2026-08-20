import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

// claude 自己的配置分层(高 → 低),2026-08-13 用真 CLI 逐条黑盒实测(2.1.220):
//   企业策略 managed-settings.json > `--settings` > 项目 .claude/settings.local.json
//   > 项目 .claude/settings.json > 用户配置目录 settings.json > 继承来的环境变量
// 每一层的 `env` 对象在 CLI 初始化时会被**写回它自己的 process.env**,所以文件里的
// 同名变量压过 harness 注入的环境变量(第 1 轮审查 finding 1 的根因)。
//
// 「项目」和「用户配置目录」各有一条反直觉的实测事实,而且**两条都正打在 harness 的
// 主路径上**(第 3 轮审查 finding 3):
//
//   ① linked worktree 不是一个独立项目。测法:主仓 /tmp/probe/repo、linked worktree
//      /tmp/probe/wt(两者只有 git 关系,目录树上互不包含),各放各的 .claude ——
//        主仓 local=8000  vs worktree local=5000   → 8000(主仓赢)
//        主仓 local=8000,worktree 没有             → 8000(照样读得到)
//        主仓没有,       worktree local=5000       → 5000(兜底才轮到它)
//        主仓 settings=8888 vs worktree settings=5000 → 5000(这一档反过来,就近赢)
//        主仓 local=8000  vs worktree settings=5000   → 8000(local 整体高于 settings)
//      数值对调重测结论不变。即 `settings.local.json` 认 canonical repo、
//      `settings.json` 认当前目录,两档各自成对。harness 默认在 worktree 里干活,
//      只读 cwd 直下的话,主仓那份 `settings.local.json` 完全看不见 —— 而那正是
//      「本机私有配置」最常写的地方。
//   ② `CLAUDE_CONFIG_DIR` 设了就**整个取代** `~/.claude`,不回落:
//        HOME=12000, CLAUDE_CONFIG_DIR=7000        → 7000
//        CLAUDE_CONFIG_DIR 指向空目录               → 读不到值(不会退回 HOME 的那份)
//
// 这里只解一件事:`CLAUDE_CODE_MAX_OUTPUT_TOKENS` 最终是多少。它是自动压缩换算的分母
// (有效窗口 = 声明窗口 − min(它, 20000)),harness 必须按 CLI 真正会用的那个值换算,
// 否则设置页写的触发点跟实际差一截 —— 用户 settings.json 里写 10000 时,填 80% 实际
// 会在 ~84% 才压(第 2 轮审查 finding 3)。
//
// 解出来的值调用方会原样钉进我们自己的 `--settings.env`:那不是改用户的配置,而是把
// **他自己那份赢家值**固定住,免得算完之后又被下面某层换掉。读不到就不钉。
//
// 上面这套顺序**不是照抄文档、是实测出来的**,CLI 换版本就可能漂。所以
// `server/scripts/test-claude-settings-live.ts` 把同一组场景交给真 claude 跑一遍对答案
// (本机装了 claude 才跑),漂了会当场红,不必等审查者再抓一次。而**没装 claude 的机器**
// 由 `test:cli-overrides` 的 ⑦c 兜底:同一组场景只钉这边的解析 —— live 那条管「假设还对
// 不对」,⑦c 管「代码有没有照假设做」,少哪条都会留出一段没人看的路。
function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // 不存在 / 不是合法 JSON:当这一层没写过
  }
}

/** 一层 settings 里 `env.<name>` 的值(没写过 = undefined)。 */
function envValue(path: string, name: string): string | undefined {
  const env = readJsonFile(path)?.env;
  if (!env || typeof env !== "object") return undefined;
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function managedSettingsPath(): string {
  return platform() === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : "/etc/claude-code/managed-settings.json";
}

/** 用户那一层的目录:`CLAUDE_CONFIG_DIR` 设了就是它,**不回落** `~/.claude`(实测②)。 */
function userConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".claude");
}

/** 从 cwd 往上找到的第一个含 `.git` 的目录(找不到 = 不在仓库里)。 */
function projectRootOf(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * linked worktree 背后的**主仓目录**(自己就是主仓 / 不是仓库 = null)。
 *
 * 认的是 worktree 里那个 `.git` **文件**:内容形如 `gitdir: /主仓/.git/worktrees/<名>`,
 * 砍掉 `/worktrees/<名>` 再退一层就是主仓。不起 `git` 子进程 —— 这个函数每次装配
 * 参数都会走到,读一个几十字节的文件比 fork 一个进程便宜得多。
 */
function canonicalRepoOf(projectRoot: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(projectRoot, ".git"), "utf8"); // 主仓那份是目录,这里会抛
  } catch {
    return null;
  }
  const gitdir = /^gitdir:\s*(.+)$/m.exec(raw)?.[1]?.trim();
  if (!gitdir) return null;
  const absolute = resolve(projectRoot, gitdir);
  const at = absolute.lastIndexOf(`${sep}worktrees${sep}`);
  if (at < 0) return null;
  return dirname(absolute.slice(0, at)); // …/主仓/.git → …/主仓
}

/** 项目那两档的文件,按实测优先级从高到低排开。 */
function projectLayers(cwd: string): string[] {
  const root = projectRootOf(cwd) ?? resolve(cwd);
  const canonical = canonicalRepoOf(root);
  const local = (dir: string) => join(dir, ".claude", "settings.local.json");
  const shared = (dir: string) => join(dir, ".claude", "settings.json");
  // local 档 canonical 优先、shared 档就近优先,两档各自成对(实测①)。
  return canonical
    ? [local(canonical), local(root), shared(root), shared(canonical)]
    : [local(root), shared(root)];
}

/**
 * 本机 claude 最终会看到的 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`(没有任何一层写过 = null)。
 * 给了 cwd 才读得到项目那几层 —— 设置页那条只读接口没有项目概念,读用户层就够。
 */
export function claudeMaxOutputTokens(cwd?: string): number | null {
  const name = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";
  const layers = [
    managedSettingsPath(),
    ...(cwd ? projectLayers(cwd) : []),
    join(userConfigDir(), "settings.json"),
  ];
  for (const path of layers) {
    const found = envValue(path, name);
    if (found !== undefined) return toPositiveInt(found);
  }
  return toPositiveInt(process.env[name]);
}

function toPositiveInt(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
