// 「活干了、就是忘了交卷」的探针，在**真 git 仓库**上钉住。
//
// 病根（2026-08-07 现场）：agent 干完活、提交也打了，唯独回合最后一步没调 complete_task
// （回合的最后一件事是「输出一段文字」而不是「执行一个动作」时最容易漏）。协议照章记
// failed 没错，可通知里是一段通用文案「可能没调用;也可能被 409 拒了」—— 用户得自己去翻
// git log 才知道产物其实都在。这个探针负责把那句话指到病灶。
//
// 三条是它的全部要害，改动任何一条都必须让这里先红：
//   ① 有产出（新提交 / 新的未提交改动）→ 必须说出**具体数字**，含糊的「可能有产出」等于没说；
//   ② 没产出 → **一个字都不许加**。误报「你有 3 个提交」会把用户支使去翻一个空的 git log，
//      比不提示更坏；
//   ③ 探测不到（非 git 目录、目录没了、根本没记起点）→ 同样闭嘴，绝不能抛 —— 这是个
//      提示性功能，不许把一次正常结算带下水。
// Run: npm -w server run test:turn-output
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-turn-output-"));
process.env.ASH_DB = join(root, "ash.db");
const repo = join(root, "repo");
execFileSync("git", ["init", "-q", repo]);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(repo, "seed.txt"), "seed\n");
git("add", "-A");
git("commit", "-qm", "seed");

const { RUNS_DIR } = await import("../src/paths.js");
const { recordTurnStart, turnOutputHint, clearTurnStart } = await import("../src/turn-output.js");

const IDS = ["to-commits", "to-dirty", "to-quiet", "to-nogit", "to-cleared", "to-missing"];

try {
  // ── ① 提交了但没交卷 → 说出提交数 ────────────────────────────────────────
  await recordTurnStart("to-commits", repo);
  writeFileSync(join(repo, "feature.txt"), "done\n");
  git("add", "-A");
  git("commit", "-qm", "feat: 干完了");
  writeFileSync(join(repo, "feature2.txt"), "more\n");
  git("add", "-A");
  git("commit", "-qm", "feat: 又干完一件");
  const committed = await turnOutputHint("to-commits");
  assert.match(committed, /2 个新提交/, "有几个提交就说几个 —— 含糊的「可能有产出」等于没说");
  assert.match(committed, /改成已完成/, "话要落到用户下一步该做什么上,不是只报个数");

  // ── ② 只改了没提交 → 也算产出,数文件数 ──────────────────────────────────
  await recordTurnStart("to-dirty", repo);
  writeFileSync(join(repo, "seed.txt"), "seed\nedited by agent\n"); // 改已跟踪的
  writeFileSync(join(repo, "scratch.txt"), "new file\n"); // 加没跟踪的
  const dirty = await turnOutputHint("to-dirty");
  assert.match(dirty, /2 个文件的未提交改动/, "改了没提交同样是产出,漏交卷的现场经常长这样");
  assert.doesNotMatch(dirty, /新提交/, "这一轮一个提交都没打,别无中生有");
  git("checkout", "--", "seed.txt");
  rmSync(join(repo, "scratch.txt"));

  // ── ③ 一个字节没动 → 一个字都不加 ───────────────────────────────────────
  await recordTurnStart("to-quiet", repo);
  assert.equal(await turnOutputHint("to-quiet"), "", "没产出就闭嘴:误报会把用户支使去翻一个空的 git log");

  // ── ④ 非 git 目录 → 闭嘴,且不许抛 ──────────────────────────────────────
  const plain = join(root, "plain");
  execFileSync("mkdir", ["-p", plain]);
  await recordTurnStart("to-nogit", plain);
  writeFileSync(join(plain, "whatever.txt"), "x\n");
  assert.equal(await turnOutputHint("to-nogit"), "", "取不到 git 信息时「不知道」不等于「有产出」");

  // ── ⑤ 起点被别的支路清掉 / 压根没记过 → 闭嘴 ────────────────────────────
  await recordTurnStart("to-cleared", repo);
  clearTurnStart("to-cleared");
  writeFileSync(join(repo, "after-clear.txt"), "x\n");
  assert.equal(await turnOutputHint("to-cleared"), "", "起点没了就没法比,别拿「当前有脏文件」硬报成本轮产出");
  rmSync(join(repo, "after-clear.txt"));
  assert.equal(await turnOutputHint("to-missing"), "", "从没记过起点的老任务/老回合,行为要跟改动前一样");

  // ── ⑥ 读一次就删:同一份起点不许服务两个回合 ────────────────────────────
  await recordTurnStart("to-commits", repo);
  writeFileSync(join(repo, "again.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "feat: 第三件");
  assert.match(await turnOutputHint("to-commits"), /1 个新提交/, "前置条件:这一轮确实又提交了一个");
  assert.equal(await turnOutputHint("to-commits"), "", "起点读完就该没了,否则下一轮会拿旧照片比出一堆假产出");
  assert.equal(existsSync(join(RUNS_DIR, "to-commits", "turn-start.json")), false, "残页必须落地删掉");

  console.log("turn output: 提交数 / 未提交改动数 / 没产出闭嘴 / 非 git 闭嘴 / 无起点闭嘴 / 读一次就删,六条通过");
} finally {
  for (const id of IDS) rmSync(join(RUNS_DIR, id), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
