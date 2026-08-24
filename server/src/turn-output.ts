// 「活干了，就是忘了交卷」—— 给 failed 通知补上那句指到病灶的话。
//
// 病：agent 把活干完、代码也提交了，唯独回合最后一步没调 `complete_task`（最容易发生在
// 「回合的最后一件事是输出一段文字、而不是执行一个动作」的时候）。严格完成协议照章记
// failed 是对的，可通知里给的是一段通用文案（「可能是没调用;也可能调了被 409 拒了」），
// 用户得自己去 git log 翻一遍才知道产物其实都在。
//
// 做法：回合起跑时看一眼工作目录（HEAD + 未提交改动的指纹），结算走到「未确认 failed」
// 那一支时再看一眼，把差值说成人话追加进通知。三条边界，一条都不能松：
//   ① **不参与任何结算判断** —— 落位仍旧是 failed，这里只改通知的措辞；
//   ② 非 git 目录 / 命令失败 / 目录没了 → 一个字都不加。宁可少说，也不能误报「你有 3 个
//      提交」把用户支使去翻一个空的 git log；
//   ③ 全程不抛 —— 探测挂了不许把一次正常结算带下水。
//
// 与 `turn-baseline.ts` 的分工（两边都拍工作目录的照，但不是一回事，别合并）：
//   那边是**严格判据**（变没变；取不到一律按「变了」处理；结论拿去清验收账本），
//     并且**只给真人续聊拍照**；
//   这边是**给人看的提示**（干了多少；取不到就闭嘴），必须覆盖 fresh run —— 漏交卷最常
//     发生在 fresh run，而那一路 turn-baseline 根本不拍照。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";
import { now } from "./util.js";
import { execFileText as exec } from "./exec.js";

interface TurnStart {
  cwd: string;
  /** 起跑时的 HEAD。null = 非 git 目录 / 空仓库 / 取不到。 */
  head: string | null;
  /** 起跑时未提交改动（已跟踪的 diff + 未跟踪文件名单）的指纹。null = 取不到。 */
  dirty: string | null;
  at: string;
}

const startPath = (taskId: string) => join(RUNS_DIR, taskId, "turn-start.json");

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    // diff 可以很大：默认 1MB 的 maxBuffer 会直接抛，那样这个探测在大改动的回合上
    // 永远取不到值 —— 而大改动的回合恰恰是最该提示「你有产出」的那些。
    const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

async function headOf(cwd: string): Promise<string | null> {
  return (await git(cwd, ["rev-parse", "HEAD"]))?.trim() || null;
}

/** 未提交改动的指纹。两段各自先写长度再写内容，免得「换个位置切开能拼出同样字节流」。 */
async function dirtyOf(cwd: string): Promise<string | null> {
  const diff = await git(cwd, ["diff", "HEAD"]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (diff === null || untracked === null) return null;
  const hash = createHash("sha256");
  for (const part of [diff, untracked]) {
    hash.update(String(part.length));
    hash.update("\n");
    hash.update(part);
  }
  return hash.digest("hex");
}

async function dirtyFileCount(cwd: string): Promise<number> {
  const out = await git(cwd, ["status", "--porcelain"]);
  if (out === null) return 0;
  return out.split("\n").filter((line) => line.trim()).length;
}

/**
 * 起跑前记一眼。落磁盘（`data/runs/<taskId>/turn-start.json`）而不是内存：活得过 server
 * 重启，重启后接管（reattach）那一路结算时照样比得上。
 */
export async function recordTurnStart(taskId: string, cwd: string): Promise<void> {
  try {
    if (!cwd || !existsSync(cwd)) return;
    const snapshot: TurnStart = { cwd, head: await headOf(cwd), dirty: await dirtyOf(cwd), at: now() };
    mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
    writeFileSync(startPath(taskId), JSON.stringify(snapshot));
  } catch (error) {
    // 记不下来 = 这一轮不提示，退回改动前的行为。绝不该拖垮起跑。
    console.warn(`[ash] failed to record turn start for ${taskId}:`, error);
  }
}

/** 一份起点只服务一个回合：读一次就删，留着会让下一轮拿旧的比。 */
function takeTurnStart(taskId: string): TurnStart | null {
  const path = startPath(taskId);
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as TurnStart;
    rmSync(path, { force: true });
    return typeof raw?.cwd === "string" ? raw : null;
  } catch {
    rmSync(path, { force: true });
    return null;
  }
}

/** 回合收尾时无条件扔掉起点（只有「未确认 failed」那一支会去读它，别的支路不能留残页）。 */
export function clearTurnStart(taskId: string): void {
  try {
    rmSync(startPath(taskId), { force: true });
  } catch {
    /* 清不掉也无所谓：下一轮起跑会覆盖 */
  }
}

/**
 * 结算时的那一句。有产出 → 返回一句可直接拼在 failed 通知后面的中文；
 * 没产出、或探测不到（非 git、目录没了、git 挂了）→ 空串，一个字都不加。
 */
export async function turnOutputHint(taskId: string): Promise<string> {
  try {
    const start = takeTurnStart(taskId);
    if (!start || !existsSync(start.cwd)) return "";
    const [head, dirty] = await Promise.all([headOf(start.cwd), dirtyOf(start.cwd)]);
    // HEAD 动了才去数：数出 0 也可能是 reset/换分支，那就当没提交（宁可少说）。
    const commits =
      start.head && head && head !== start.head
        ? Number(((await git(start.cwd, ["rev-list", "--count", `${start.head}..${head}`])) ?? "").trim()) || 0
        : 0;
    // 指纹缺一头就没法比 —— 「不知道」不是「变了」，这里一律按没变处理。
    const dirtyChanged = !!start.dirty && !!dirty && dirty !== start.dirty;
    if (!commits && !dirtyChanged) return "";
    const parts: string[] = [];
    if (commits) parts.push(`${commits} 个新提交`);
    if (dirtyChanged) {
      const files = await dirtyFileCount(start.cwd);
      parts.push(files ? `${files} 个文件的未提交改动` : "工作目录的改动变化");
    }
    return `另外:本回合在工作目录里留下了${parts.join("、")} —— 活看着是干了的,多半只差交卷这一步。核对产物后可直接把状态改成已完成,不必从头重跑。`;
  } catch {
    return ""; // 提示性功能,探测挂了就闭嘴
  }
}
