// 根级 agent 约定文件的体积闸。被 .githooks/pre-commit 调用。
//
// 两件事，都是「做进系统」而不是靠自觉：
// ① 当场付账——超预算的增长直接拒掉提交（棘轮式：只拦增长，不拦存量，所以瘦身
//    过渡期和解冲突的 merge 不会被自己的闸挡死）。
// ② 对称计账——每次提交都报净变化，**增也报、减也报**。原来的元规则只写了
//    「值得就补一条」，全文没有一句奖励「搬走一条」，于是加的人得表扬、减的人
//    没人看见。奖不对称，文件就只会往一个方向长。
//
// 被拒时不能只说「你去搬走一条」——那样「搬」比「加」贵，人自然选加。所以直接
// 把当前最占地方的几节列出来，让「搬」和「加」一样省力。
import { execFileSync } from "node:child_process";

const BUDGET = 8192;
const FILES = ["CLAUDE.md", "AGENTS.md"];

const git = (args) => execFileSync("git", args, { encoding: "utf8" });
const tryGit = (args) => {
  try {
    return git(args);
  } catch {
    return null;
  }
};

const size = (spec) => {
  const out = tryGit(["cat-file", "-s", spec]);
  return out === null ? null : Number(out.trim());
};

// 按 `## ` 小节切开，算每节字节，用来回答「搬哪条最划算」。
function fattestSections(text, n) {
  const parts = text.split(/^## /m).slice(1);
  return parts
    .map((p) => ({ title: p.split("\n")[0].trim(), bytes: Buffer.byteLength("## " + p, "utf8") }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, n);
}

const stagedFiles = new Set((tryGit(["diff", "--cached", "--name-only", "--diff-filter=ACM"]) ?? "").split("\n"));
let failed = false;

for (const f of FILES) {
  if (!stagedFiles.has(f)) continue;

  const now = size(`:${f}`);
  if (now === null) continue; // 被删了，不管
  const before = size(`HEAD:${f}`) ?? 0;
  const delta = now - before;
  const pct = Math.round((now / BUDGET) * 100);

  // 对称计账：增减都报，不挑好消息说。
  const sign = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0";
  const note = delta < 0 ? "，谢谢" : "";
  console.log(`  ${f}: ${before} → ${now} 字节（${sign}，水位 ${pct}% / ${BUDGET}）${note}`);

  if (delta <= 0 || now <= BUDGET) continue;

  failed = true;
  const text = tryGit(["cat-file", "-p", `:${f}`]) ?? "";
  const fat = fattestSections(text, 3);

  console.error(`\n  ✗ ${f} 被改大了 ${delta} 字节，超出预算 ${BUDGET}。\n`);
  console.error("    先问一句：这条约定能不能不写在这里？按升级顺序往下找，走到最后一步才回到根文件——\n");
  console.error("      1. 让它编译不过（类型 / API 形状）");
  console.error("      2. 让检查脚本拦住（scripts/check-conventions.mjs）");
  console.error("      3. 用回归测试钉住（server/scripts/test-*.ts）");
  console.error("      4. 写成就近的代码注释（改这块代码的人一定会看到）");
  console.error("      5. 写进目录级约定文件（server/CLAUDE.md、web/CLAUDE.md、mobile/AGENTS.md）");
  console.error("      6. 都不行，才写根文件——那就先搬走一条\n");
  if (fat.length) {
    console.error("    真要加就先腾地方。当前最占地方的几节（搬走任意一条都够）：\n");
    for (const s of fat) console.error(`      ${String(s.bytes).padStart(5)} 字节  「${s.title}」`);
    console.error("");
  }
  console.error("    事故叙事搬 docs/incidents.md，根文件只留规则本体 + 一个指针。\n");
}

process.exit(failed ? 1 : 0);
