// 「加规则要先经用户同意」的闸。被 .githooks/commit-msg 调用。
//
// 为什么必须是 hook 而不是写在 md 里:md 里那句话是**写给下一个 agent 看的自觉**,
// 而每一次污染都是「某个 agent 认为这条很有必要」才发生的 —— 自觉恰好在最需要它的
// 时刻失效。hook 不看谁认为什么,只看字节。
//
// 判据是**净增长**(和体积闸同一套棘轮口径):
//   净增 ≤ 0 → 放行。改写、压缩、搬走、删除随时可做,不需要任何仪式。
//   净增 > 0 → 拒绝,除非 commit message 里带授权口令。
// 选净增而不是「有没有加行」,是因为后者会把每一次改写也拦下来 —— 那等于让「减法」
// 和「加法」一样贵,而这个文件系统的病根正是奖不对称。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const TOKEN = "[规则已获用户同意]";

const git = (args) => execFileSync("git", args, { encoding: "utf8" });
const tryGit = (args) => {
  try {
    return git(args);
  } catch {
    return null;
  }
};

// 受管的文件:任何目录的 CLAUDE.md / AGENTS.md,加上事故档案。
// docs/incidents.md 必须进来 —— 它不在任何注入链里,却被 20 处指针拉进上下文,
// 是「往哪儿加最不容易被发现」的首选。
const isRuleFile = (p) => {
  const base = p.split("/").pop();
  return base === "CLAUDE.md" || base === "AGENTS.md" || p === "docs/incidents.md";
};

const gitDir = (tryGit(["rev-parse", "--git-dir"]) ?? "").trim();
// 合并提交带进来的增长不是谁写的,不该由合并的人付账(同体积闸的取舍)。
if (gitDir && existsSync(`${gitDir}/MERGE_HEAD`)) process.exit(0);

const staged = (tryGit(["diff", "--cached", "--name-only", "--diff-filter=ACM"]) ?? "")
  .split("\n")
  .filter(Boolean)
  .filter(isRuleFile);
if (!staged.length) process.exit(0);

const size = (spec) => {
  const out = tryGit(["cat-file", "-s", spec]);
  return out === null ? null : Number(out.trim());
};

const addedLines = (f) =>
  (tryGit(["diff", "--cached", "-U0", "--", f]) ?? "")
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);

const msgFile = process.argv[2];
const authorized = msgFile && existsSync(msgFile) ? readFileSync(msgFile, "utf8").includes(TOKEN) : false;

const blocked = [];
for (const f of staged) {
  const now = size(`:${f}`);
  if (now === null) continue;
  const before = size(`HEAD:${f}`) ?? 0;
  const delta = now - before;

  // 对称计账:增也报、减也报。删掉一段也该被看见。
  console.log(`  ${f}: ${delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0"} 字节${delta < 0 ? "，谢谢" : ""}`);
  if (delta <= 0) continue;

  const lines = addedLines(f);
  if (authorized) {
    // 授权放行也要把加了什么摊在终端上 —— 用户能当场看见,事后 git log --grep 查得到。
    console.log(`    ↑ 已声明「用户同意」，本次新增 ${lines.length} 行：`);
    for (const l of lines.slice(0, 12)) console.log(`      ${l.length > 96 ? l.slice(0, 96) + "…" : l}`);
    if (lines.length > 12) console.log(`      …还有 ${lines.length - 12} 行`);
    continue;
  }
  blocked.push({ f, delta, lines });
}

if (!blocked.length) process.exit(0);

console.error("\n  ✗ 规则文件被改大了，而这次提交没有用户授权。\n");
console.error("    未经用户明确同意，不得往约定文件新增内容（根 AGENTS.md「加规则要先经用户同意」）。\n");
for (const b of blocked) {
  console.error(`    ${b.f}  +${b.delta} 字节，新增 ${b.lines.length} 行：`);
  for (const l of b.lines.slice(0, 8)) console.error(`      + ${l.length > 96 ? l.slice(0, 96) + "…" : l}`);
  if (b.lines.length > 8) console.error(`      + …还有 ${b.lines.length - 8} 行`);
  console.error("");
}
console.error("    三条出路，按顺序试：\n");
console.error("      1. 做进系统——编译不过 / 检查脚本 / 回归测试 / 就近的代码注释。");
console.error("         这四档都不占任何 agent 的入场费，且对所有 CLI 品牌一视同仁。");
console.error("      2. 不落盘——把它当本轮的临时判断写进回复正文，说给用户听。");
console.error(`      3. 确实非加不可 → 先问用户，得到同意后在 commit message 里写上 ${TOKEN}。\n`);
console.error("    （改写、压缩、搬走、删除一律放行，不需要口令。净增才拦。）\n");
process.exit(1);
