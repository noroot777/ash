// 「这条命令点名要跑的是什么，**起跑那一刻**它在被测树里解析得出来吗」。
//
// 这一层只回答这一句，而门禁「测试压根没启动」那个结论**只许**由它授权。
//
// 为什么非得在起跑前问、而且事后的任何痕迹都不能替它（第 2 轮审查 F1 实测两条反例）：
//
//  ① **日志不说是哪一层在喊。** 审查用真实 npm 复现：顶层 `test:accept` 存在、已经打出
//     `ACCEPTANCE STARTED`，它内部调 `npm --prefix child run test:accept`，子项目没有同名
//     脚本，于是日志里出现 `Missing script: "test:accept"`。名字跟命令点名的那个一模一样，
//     所以「这个名字是不是命令自己点名的那个词」这条判据必然判错 —— 上一轮就是栽在这儿。
//
//  ② **跑完之后看文件在不在也不行。** 审查那条 `./verify.sh` 先打印启动提示、`rm -- "$0"`
//     删掉自己、再报断言失败退出 1。事后 existsSync 为假，推出来的却是「它一行都没跑」——
//     恰好把一次真的断言失败说成「跟你的改动无关，不要修」。
//
// 结论：答案在 spawn 之前取一次，连同判据一起落到那一行上（accept_gate_runs.entryProbe），
// 结算时只许读它、不许重算。解析不了的命令一律返回 null —— 那时这一层就该说「不知道」。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";

/** 这条命令点名要跑的东西，分能核实的两种。其余形状一律认不出（见文件头）。 */
export type GateEntryAsk =
  | { kind: "path"; name: string }
  | { kind: "script"; runner: "npm" | "pnpm" | "yarn"; name: string };

export type GateEntryProbe = {
  /** 点名要跑的那个东西：脚本名，或相对这份树的路径。 */
  ask: string;
  /** 起跑那一刻它解析得出来没有。**这是唯一能授权「测试没启动」的事实。** */
  resolved: boolean;
  /** 在哪儿核的，写给人看（也进结论正文）。 */
  by: string;
};

/** npm 把这几个子命令直接当同名脚本跑，缺了同样报 `Missing script`。 */
const NPM_LIFECYCLE = new Set(["test", "start", "stop", "restart"]);

/**
 * 把命令里的重定向整段抹掉：`2>/dev/null`、`> log`、`>>out 2>&1` 都不是一个步骤，
 * 但会混进词表里。抹掉比逐词过滤稳 —— `> log` 带空格那种过滤不掉。
 */
const withoutRedirects = (command: string) => command.replace(/\d*[<>]{1,2}\s*[^\s;&|]+/g, " ");

/**
 * 这条命令点名要跑的是什么。认不出来返回 null。
 *
 * **多步一律认不出**：`npm ci && npm run test:accept` 没有「一个入口」可言，第一个词是
 * `npm ci`，可能缺的却是第二步的脚本名。宁可说不知道，也不要挑一个来当那个入口。
 * 命令替换（`` ` ``、`$(…)`）同理：第一个词是算出来的，起跑前核不了。
 */
export function gateEntryAsk(command: string): GateEntryAsk | null {
  if (/(\|\||&&|[;\n|])/.test(command)) return null;
  if (/[`]|\$\(/.test(command)) return null;
  const words = withoutRedirects(command).split(/\s+/).filter(Boolean);
  // 前缀的环境变量赋值（`CI=1 npm run x`）不是入口，剥掉；后面出现的 `A=B` 是参数，留着。
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  const head = words[0];
  if (!head) return null;
  const runner = /^(npm|pnpm|yarn)$/.exec(head)?.[1] as "npm" | "pnpm" | "yarn" | undefined;
  if (runner) {
    const at = words.findIndex(word => word === "run" || word === "run-script");
    if (at > 0) {
      const name = words.slice(at + 1).find(word => !word.startsWith("-"));
      return name ? { kind: "script", runner, name } : null;
    }
    // `npm test` 这种:npm 自己把它当同名脚本跑。只认 npm —— yarn/pnpm 的裸子命令
    // 和脚本简写混在一起,分不清就不猜。
    const sub = words[1];
    return runner === "npm" && sub && NPM_LIFECYCLE.has(sub) ? { kind: "script", runner, name: sub } : null;
  }
  // 相对路径形式的入口（`./runner.sh`、`scripts/verify.sh`）。绝对路径不算：那是机器上的
  // 东西，缺了跟「任务分支落后了」无关，给合分支的建议只会误导。
  return !isAbsolute(head) && head.includes("/") ? { kind: "path", name: head } : null;
}

/** package.json 的文本里，`scripts` 定义了这个名字没有。读不动/解析不了返回 null。 */
export function scriptDefinedIn(packageJson: string, name: string): boolean | null {
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts;
    if (scripts === undefined) return false;
    if (scripts === null || typeof scripts !== "object") return null;
    return typeof scripts[name] === "string";
  } catch { return null; }
}

/** 这个相对路径有没有踩出这份树（`../` 那种一律不判，它本来就不在树里）。 */
export function insideTree(treeDir: string, name: string): string | null {
  const resolved = normalize(join(treeDir, name));
  const inside = relative(normalize(treeDir), resolved);
  return !inside || (!inside.startsWith("..") && !isAbsolute(inside)) ? resolved : null;
}

/**
 * 起跑前核这一次。**调用点只能是 spawn 之前**，否则这份答案就不再是「起跑那一刻」的。
 *
 * 核不出来（命令认不出、package.json 读不动）一律返回 null：这一层宁可交白卷，也不能交
 * 一个推出来的答案 —— 下游拿它去说「测试一行都没跑、不要改代码」。
 */
export async function probeGateEntry(treeDir: string, command: string): Promise<GateEntryProbe | null> {
  const ask = gateEntryAsk(command);
  if (!ask) return null;
  if (ask.kind === "path") {
    const resolved = insideTree(treeDir, ask.name);
    return resolved ? { ask: ask.name, resolved: existsSync(resolved), by: "被测快照里的文件" } : null;
  }
  const manifest = await readFile(join(treeDir, "package.json"), "utf8").catch(() => null);
  if (manifest === null) return null;
  const defined = scriptDefinedIn(manifest, ask.name);
  return defined === null ? null : { ask: ask.name, resolved: defined, by: "被测快照 package.json 的 scripts" };
}

/** 落盘与读回。字段形状变了就当没核过 —— 跨机接力和旧行都可能带着老形状。 */
export const encodeGateEntryProbe = (probe: GateEntryProbe | null): string | null =>
  probe ? JSON.stringify(probe) : null;

export function decodeGateEntryProbe(raw: string | null | undefined): GateEntryProbe | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GateEntryProbe>;
    return typeof value.ask === "string" && typeof value.resolved === "boolean" && typeof value.by === "string"
      ? { ask: value.ask, resolved: value.resolved, by: value.by } : null;
  } catch { return null; }
}
