// 「这条命令点名要跑的是什么，**起跑那一刻**它在被测树里解析得出来吗」。
//
// 这一层只回答这一句，而门禁「测试压根没启动」那个结论**只许**由它授权。
//
// 为什么非得在起跑前问、而且事后的任何痕迹都不能替它（第 2 轮审查 F1 实测两条反例）：
//  ① **日志不说是哪一层在喊。** 顶层 `test:accept` 存在、已经打出 `ACCEPTANCE STARTED`，
//     它内部调 `npm --prefix child run test:accept`，子项目没有同名脚本，于是日志里出现
//     `Missing script: "test:accept"` —— 跟顶层缺失长得一模一样。
//  ② **跑完之后看文件在不在也不行。** 一条先打印启动提示、`rm -- "$0"` 删掉自己、再报断言
//     失败的脚本，事后看就是「入口不存在」。
//
// **而光把时机挪到 spawn 前还不够（第 3 轮审查 F1）。** 查的那个对象必须跟 runner 真要查的
// 那个对象**等价**，否则只是换个地方猜。审查实测的三条：
//  · `npm --prefix child run test:accept` —— runner 读的是 `child/package.json`，这一层却读
//    根目录那份，于是把一次真的断言失败说成「一行都没跑」；
//  · `npm run 'test:accept'` —— 引号是 shell 的，runner 拿到的名字没有引号，这一层却带着
//    引号去查；
//  · `npm start` —— 没有 `scripts.start` 时 npm **有默认行为**（有 `server.js` 就跑
//    `node server.js`，实测如此），所以「manifest 里没有」推不出「没东西可跑」。
//
// 所以这一层的规矩是**证明不了就交白卷**：
//  · 命令里有任何我读不准的 shell 语义（多步、变量、命令替换、通配、转义、未闭合引号），
//    返回 null；
//  · 有任何会改变「去哪儿找脚本」的选项而我解析不了（workspace、递归、filter），返回 null；
//  · 只认那些**绝对没有默认行为**的子命令（`npm run X`、`npm test`），`start`/`restart`
//    一律不认；
//  · 查的 manifest 必须是 runner 真会读的那一份（跟着 `--prefix`/`-C`/`--dir`/`--cwd` 走）。
//
// 反方向也要说清：`resolved: true` **只证明它在树里，不证明它跑起来了**（审查实测：一个存在
// 但没有执行权限的脚本退 126，正文一行没跑）。所以 true 这一档的措辞里不许出现「确实跑起来
// 了」—— 那句话这一层给不出来。
//
// 答案在 spawn 之前取一次，连同判据一起落到那一行上（accept_gate_runs.entryProbe），结算时
// 只许读它、不许重算。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";

/** 这条命令点名要跑的东西，分能核实的两种。其余形状一律认不出（见文件头）。 */
export type GateEntryAsk =
  | { kind: "path"; name: string }
  /** `dir` = runner 真会读 manifest 的那个目录（相对被测树，默认 `.`）。 */
  | { kind: "script"; runner: "npm" | "pnpm" | "yarn"; name: string; dir: string };

export type GateEntryProbe = {
  /** 点名要跑的那个东西：脚本名，或相对这份树的路径。 */
  ask: string;
  /**
   * 起跑那一刻它解析得出来没有。
   *  - `false` 是「测试压根没启动」的**唯一**授权来源；
   *  - `true` 只说明它在树里 —— **不**说明它跑起来了（权限、解释器都可能挡在后面）。
   */
  resolved: boolean;
  /** 在哪儿核的，写给人看（也进结论正文）。 */
  by: string;
};

/**
 * 只认**绝对没有默认行为**的子命令。
 *
 * `npm test` 缺脚本就是报错；而 `npm start` 没有 `scripts.start` 时会去跑 `node server.js`、
 * `npm restart` 会退化成 stop+start（审查 F1 实测），所以那几个一律不认 —— 「manifest 里
 * 没有」在它们身上推不出「没东西可跑」。
 */
const NPM_LIFECYCLE = new Set(["test"]);

/** 出现任何一个就交白卷：它们会改变「去哪儿找脚本」，而我解析不了那个结果。 */
const SCOPE_CHANGING = /^(-w|-ws|-r|-i|--workspace|--workspaces|--recursive|--filter|--if-present|--package|workspace|workspaces|exec|dlx)(=|$)/;

/** 告诉 runner 换目录的选项。值可以跟在后面，也可以 `=` 连写。 */
const DIR_FLAGS = new Set(["--prefix", "-C", "--dir", "--cwd"]);

/**
 * 把命令切成词。**读不准就返回 null**，绝不猜。
 *
 * 只处理一件 shell 语义：成对的引号（`npm run 'test:accept'` 里那个名字，runner 拿到的是
 * 不带引号的 —— 审查 F1 实测）。变量、命令替换、通配、转义、未闭合引号、多步一律交白卷。
 */
function tokenize(command: string): string[] | null {
  if (/(\|\||&&|[;\n|])/.test(command)) return null;      // 多步：没有「一个入口」可言
  if (/[`$]/.test(command)) return null;                   // 命令替换 / 变量：入口是算出来的
  if (/[\\*?[\]{}~]/.test(command)) return null;           // 转义 / 通配 / 花括号展开
  const words: string[] = [];
  let at = 0;
  while (at < command.length) {
    if (/\s/.test(command[at]!)) { at++; continue; }
    // 重定向整段跳过：它不是一个步骤，也不是入口。
    const redirect = /^\d*[<>]{1,2}\s*\S+/.exec(command.slice(at));
    if (redirect) { at += redirect[0].length; continue; }
    let word = "";
    while (at < command.length && !/\s/.test(command[at]!)) {
      const quote = command[at]!;
      if (quote === "'" || quote === '"') {
        const close = command.indexOf(quote, at + 1);
        if (close < 0) return null;                        // 引号没闭合：读不了
        word += command.slice(at + 1, close);
        at = close + 1;
      } else { word += quote; at++; }
    }
    // 词中间夹着重定向符（`x>log`）那种，我切不准。
    if (/[<>]/.test(word)) return null;
    words.push(word);
  }
  return words;
}

/** runner 会去哪个目录读 manifest。解析不了那个值就返回 null（交白卷）。 */
function runnerDir(words: string[]): string | null {
  let dir = ".";
  for (let at = 0; at < words.length; at++) {
    const word = words[at]!;
    const eq = word.indexOf("=");
    const flag = eq > 0 ? word.slice(0, eq) : word;
    if (!DIR_FLAGS.has(flag)) continue;
    const value = eq > 0 ? word.slice(eq + 1) : words[at + 1];
    if (!value || value.startsWith("-")) return null;
    dir = value;
  }
  return dir;
}

/**
 * 这条命令点名要跑的是什么。认不出来返回 null。
 *
 * 判据全在文件头：能读准的 shell 语义 + 没有默认行为的子命令 + runner 真会读的那个目录。
 * 任何一条不满足就交白卷 —— 下游拿这个答案去说「测试一行都没跑、不要改代码」。
 */
export function gateEntryAsk(command: string): GateEntryAsk | null {
  const words = tokenize(command);
  if (!words) return null;
  // 前缀的环境变量赋值（`CI=1 npm run x`）不是入口，剥掉；后面出现的 `A=B` 是参数，留着。
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  const head = words[0];
  if (!head) return null;
  if (words.some(word => SCOPE_CHANGING.test(word))) return null;
  const runner = /^(npm|pnpm|yarn)$/.exec(head)?.[1] as "npm" | "pnpm" | "yarn" | undefined;
  if (runner) {
    const dir = runnerDir(words);
    if (dir === null) return null;
    const flagValues = new Set<string>();
    for (let at = 1; at < words.length; at++) {
      if (DIR_FLAGS.has(words[at]!)) flagValues.add(words[at + 1] ?? "");
    }
    const positional = words.slice(1).filter(word => !word.startsWith("-") && !flagValues.has(word));
    const at = positional.indexOf("run") >= 0 ? positional.indexOf("run") : positional.indexOf("run-script");
    if (at >= 0) {
      const name = positional[at + 1];
      return name ? { kind: "script", runner, name, dir } : null;
    }
    // 只认 npm 那几个「缺了就是报错」的子命令;yarn/pnpm 的裸子命令和脚本简写混在一起,
    // 分不清就不猜。
    const sub = positional[0];
    return runner === "npm" && sub && NPM_LIFECYCLE.has(sub) ? { kind: "script", runner, name: sub, dir } : null;
  }
  // 相对路径形式的入口（`./runner.sh`、`scripts/verify.sh`）。绝对路径不算：那是机器上的
  // 东西，缺了跟「任务分支落后了」无关，给合分支的建议只会误导。
  return !isAbsolute(head) && head.includes("/") ? { kind: "path", name: head } : null;
}

/** runner 真会读的那份 manifest 的相对路径。 */
export const askManifest = (ask: GateEntryAsk & { kind: "script" }): string =>
  ask.dir === "." ? "package.json" : `${ask.dir.replace(/\/+$/, "")}/package.json`;

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
  if (isAbsolute(name)) return null;
  const resolved = normalize(join(treeDir, name));
  const inside = relative(normalize(treeDir), resolved);
  return !inside || (!inside.startsWith("..") && !isAbsolute(inside)) ? resolved : null;
}

/**
 * 起跑前核这一次。**调用点只能是 spawn 之前**，否则这份答案就不再是「起跑那一刻」的。
 *
 * 核不出来（命令认不出、manifest 读不动、目录踩出树）一律返回 null：这一层宁可交白卷，
 * 也不能交一个推出来的答案 —— 下游拿它去说「测试一行都没跑、不要改代码」。
 */
export async function probeGateEntry(treeDir: string, command: string): Promise<GateEntryProbe | null> {
  const ask = gateEntryAsk(command);
  if (!ask) return null;
  if (ask.kind === "path") {
    const resolved = insideTree(treeDir, ask.name);
    return resolved ? { ask: ask.name, resolved: existsSync(resolved), by: "被测快照里的文件" } : null;
  }
  const file = askManifest(ask);
  const resolved = insideTree(treeDir, file);
  if (!resolved) return null;
  const manifest = await readFile(resolved, "utf8").catch(() => null);
  if (manifest === null) return null;
  const defined = scriptDefinedIn(manifest, ask.name);
  return defined === null ? null : { ask: ask.name, resolved: defined, by: `被测快照 ${file} 的 scripts` };
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
