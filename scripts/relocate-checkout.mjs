#!/usr/bin/env node
// 把本机的仓库目录整个搬到新位置（harness → navi），连同所有记着它绝对路径的地方。
//
//   node scripts/relocate-checkout.mjs --from /Users/me/code/harness --to /Users/me/code/navi            # 演练：只列不改
//   node scripts/relocate-checkout.mjs --from … --to … --apply                                            # 真做
//   node scripts/relocate-checkout.mjs --from … --to … --verify                                           # 搬完核对还剩什么
//   node scripts/relocate-checkout.mjs --from … --to … --rollback [账本目录]                               # 照账本退回（启动服务之前）
//   node scripts/relocate-checkout.mjs --from … --to … --unlink                                           # 核对干净后拿掉过渡链接
//   node scripts/relocate-checkout.mjs --from … --to … --set-remote [地址]                                # GitHub 改名之后换远端
//
// 其它选项：--no-link（不留 旧路径 → 新路径 的过渡链接）、--db <库文件>、--home <家目录>（只给回归用）。
// 退出码：0 做完/核对干净；1 演练或核对发现还有要处理的；2 预检拦下，什么都没动；3 做到一半失败（看账本）。
//
// 操作单、做了什么、为什么留链接、哪些覆盖不到：docs/relocate-checkout.md。
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { apply, checkWorktrees, Journal, rollback } from "./relocate-checkout-apply.mjs";
import { mapPath } from "./relocate-checkout-paths.mjs";
import { scan } from "./relocate-checkout-scan.mjs";

function parseArgs(argv) {
  const o = { link: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i += 1;
      return v;
    };
    if (a === "--from") o.from = val();
    else if (a === "--to") o.to = val();
    else if (a === "--db") o.db = val();
    else if (a === "--home") o.home = val();
    else if (a === "--apply") o.mode = "apply";
    else if (a === "--verify") o.mode = "verify";
    else if (a === "--unlink") o.mode = "unlink";
    else if (a === "--rollback") { o.mode = "rollback"; o.journal = val(); }
    else if (a === "--set-remote") { o.mode = "remote"; o.remote = val(); }
    else if (a === "--no-link") o.link = false;
    else if (a === "-h" || a === "--help") o.help = true;
    else { console.error(`认不得的参数：${a}`); process.exit(2); }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.from || !opts.to) {
  console.log("用法：node scripts/relocate-checkout.mjs --from <旧目录> --to <新目录> [--apply|--verify|--rollback [账本]|--unlink|--set-remote [地址]] [--no-link]");
  process.exit(opts.help ? 0 : 2);
}
for (const k of ["from", "to"]) {
  if (!isAbsolute(opts[k])) { console.error(`--${k} 要写绝对路径`); process.exit(2); }
  opts[k] = resolve(opts[k]);
}
if (opts.from === opts.to) { console.error("--from 和 --to 是同一个目录"); process.exit(2); }
const home = resolve(opts.home ?? homedir());
const say = (s = "") => console.log(s);
const list = (items, fmt, max = 12) => {
  for (const it of items.slice(0, max)) say(`    ${fmt(it)}`);
  if (items.length > max) say(`    …… 另有 ${items.length - max} 项`);
};

/** 打印清点，返回 { blockers, todo }：blockers 拦真做，todo 是还要改的项数。 */
function report(plan, { verify = false } = {}) {
  const blockers = [];
  let todo = 0;
  const { where } = plan;
  say(`目录：${plan.from} → ${plan.to}`);
  if (where.state === "pending") { say("  还没搬"); todo += 1; }
  else if (where.state === "moved") say(`  已经搬到新位置；过渡链接：${where.link === "ours" ? `在（${plan.from} → ${readlinkSync(plan.from)}）` : "没有"}`);
  else { say(`  ✗ ${where.why}`); blockers.push(where.why); return { blockers, todo }; }
  if (where.state === "pending" && !plan.sameDevice) blockers.push(`${plan.to} 跟 ${plan.from} 不在同一个文件系统上，一步改名做不到`);

  say("\n服务与任务：");
  say(`  库文件：${plan.dbFile}${plan.db.missing ? "（不存在）" : ""}`);
  if (plan.service.running) { for (const r of plan.service.reasons) say(`  ✗ ${r}`); blockers.push("服务还在运行"); }
  else say("  服务已停");
  if (plan.dbState.running.length) {
    say(`  ✗ ${plan.dbState.running.length} 个任务还在跑或排着：`);
    list(plan.dbState.running, (t) => `${t.id}  ${t.status}  ${t.title ?? ""}`);
    blockers.push("有任务在跑");
  }
  if (plan.dbState.monitors.length) {
    say(`  ✗ ${plan.dbState.monitors.length} 个哨兵还在盯：`);
    list(plan.dbState.monitors, (m) => `${m.id}（任务 ${m.taskId}）`);
    blockers.push("有哨兵在跑");
  }

  say("\n进程：");
  const p = plan.processes;
  if (p.blocking.length) {
    say(`  ✗ ${p.blocking.length} 个进程的工作目录在树里（agent、哨兵、预览、构建……要先结束）：`);
    list(p.blocking, (x) => `${x.pid}  ${x.command}  ${x.cwd}`);
    blockers.push("有进程在树里干活");
  }
  if (p.shells.length) { say(`  ! ${p.shells.length} 个终端停在树里：搬完它们显示的还是旧路径，cd 一下新目录即可`); list(p.shells, (x) => `${x.pid}  ${x.cwd}`, 5); }
  if (p.argvRefs.length) {
    say(`  ! ${p.argvRefs.length} 个进程的命令行里写着树里的路径（多半是别的会话拉起的 navi MCP）：${opts.link ? "留着过渡链接时它们照常工作" : "不留链接的话，它们重启时会找不到文件"}`);
    list(p.argvRefs, (x) => `${x.pid}  ${x.command}`, 6);
  }
  if (!p.blocking.length && !p.shells.length && !p.argvRefs.length) say("  没有");

  say("\ngit 工作区：");
  const wt = plan.worktrees;
  say(`  登记 ${wt.items.length} 个（${wt.items.filter((w) => w.missing).length} 个目录已经不在，git 自己会当可清理的处理，不动）`);
  if (wt.edits.length) { say(`  要改的路径文件 ${wt.edits.length} 份（工作区里的 .git 与仓库里的 gitdir）`); todo += wt.edits.length; }
  if (verify) { const probs = checkWorktrees(plan.where.root); for (const x of probs) say(`  ✗ ${x}`); todo += probs.length; }

  say("\n树里的链接：");
  const sl = plan.symlinks;
  say(`  指向旧位置的绝对链接：${sl.retarget.length} 个${sl.retarget.length ? "（改指新位置）" : ""}`);
  todo += sl.retarget.length;
  if (sl.escaping.length) { say(`  ! ${sl.escaping.length} 个相对链接指到树外，换了上级目录会断（不改，列出来）：`); list(sl.escaping, (x) => `${x.path} → ${x.target}`, 5); }

  say("\nnavi 的库：");
  say(`  旧路径 ${plan.db.total} 处`);
  list(plan.db.refs.sort((a, b) => b.count - a.count), (r) => `${r.table}.${r.column}：${r.count} 处 / ${r.rows} 行`, verify ? 40 : 10);
  todo += plan.db.total;
  for (const f of plan.dataFiles) { say(`  ${f.file}：${f.count} 处`); todo += f.count; }

  say("\n执行器的会话：");
  const c = plan.claude;
  say(`  claude 会话目录要改名：${c.moves.length} 个${c.moves.some((m) => m.merge) ? `（${c.moves.filter((m) => m.merge).length} 个目标已存在，并进去）` : ""}`);
  list(c.moves.filter((m) => !m.from.includes("--worktrees-")), (m) => `${m.from} → ${m.to}`, 4);
  for (const m of [...c.moves, ...plan.grok.moves].filter((x) => x.conflicts.length)) {
    say(`  ✗ ${m.from} 并进 ${m.to} 时有 ${m.conflicts.length} 项内容不同：${m.conflicts.slice(0, 3).join("、")}`);
    blockers.push("会话目录合并有冲突");
  }
  if (c.unclassified.length) { say(`  ! ${c.unclassified.length} 个目录认不出是不是这棵树的，不动：`); list(c.unclassified, (u) => `${u.path}（${u.why}）`, 5); }
  say(`  grok 会话目录要改名：${plan.grok.moves.length} 个`);
  for (const o of plan.grok.odd) say(`  ! ${o.path}：${o.why}`);
  say(`  opencode 会话的工作目录要改：${plan.opencode.rows.length} 条${plan.opencode.missing ? "（没装 opencode）" : ""}`);
  say("  codex：按会话号续跑、用起跑时给的工作目录，实测不用改它的记录");
  todo += c.moves.length + plan.grok.moves.length + plan.opencode.rows.length;

  say("\n配置文件：");
  for (const f of plan.configs.rewrite) {
    say(`  ${f.problems.length ? "✗" : "·"} ${f.file}：${f.count} 处${f.problems.length ? `（${f.problems.join("；")}，不改，要手工处理）` : ""}`);
    todo += f.count;
  }
  if (!plan.configs.rewrite.length) say("  没有要改的");
  for (const f of plan.configs.reportOnly) {
    say(`  ! ${f.file} 里写着旧路径（脚本不改，自己看着改）：`);
    list(f.lines, ([n, l]) => `${n}: ${l.trim().slice(0, 140)}`, 5);
  }

  say("\n远端：");
  say(`  origin = ${plan.remote.url ?? "（没有）"}`);
  if (plan.remote.suggested) say(`  GitHub 上改名之后：node scripts/relocate-checkout.mjs --from ${plan.from} --to ${plan.to} --set-remote ${plan.remote.suggested}`);
  return { blockers, todo };
}

const plan = scan({ from: opts.from, to: opts.to, home, db: opts.db });

if (opts.mode === "rollback") {
  const journal = opts.journal ? new Journal(resolve(opts.journal)) : Journal.latest(home);
  if (!journal) { say("没有找到账本（~/.navi-relocate/*/journal.json）"); process.exit(2); }
  if (journal.data.rolledBackAt) { say(`这份账本已经退回过：${journal.dir}`); process.exit(0); }
  if (!plan.service || plan.service.running) { say(`✗ 退回之前要先停服务：${(plan.service?.reasons ?? [plan.where.why]).join("；")}`); process.exit(2); }
  say(`照账本退回：${journal.dir}`);
  try { rollback(journal, say); } catch (error) { say(`✗ 退回中途失败：${error.message}\n  账本里标了 undone 的已经退回，修好原因再跑一次 --rollback 接着退`); process.exit(3); }
  say("已退回。");
  process.exit(0);
}

if (opts.mode === "remote") {
  const url = opts.remote ?? plan.remote.suggested;
  if (!url) { say("算不出新地址，请写明：--set-remote <地址>"); process.exit(2); }
  try { execFileSync("git", ["ls-remote", "--heads", url], { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 }); }
  catch { say(`✗ ${url} 现在连不上（GitHub 上还没改名？），没改远端`); process.exit(2); }
  execFileSync("git", ["-C", plan.where.root, "remote", "set-url", "origin", url]);
  say(`origin → ${url}`);
  process.exit(0);
}

if (opts.mode === "unlink") {
  if (plan.where.state !== "moved" || plan.where.link !== "ours") { say("没有可拿掉的过渡链接"); process.exit(plan.where.state === "moved" ? 0 : 2); }
  const { todo } = report(plan, { verify: true });
  if (todo || plan.processes.argvRefs.length) { say("\n✗ 还有东西在用旧路径，链接先留着"); process.exit(1); }
  unlinkSync(opts.from);
  say(`\n已拿掉 ${opts.from}`);
  process.exit(0);
}

if (opts.mode === "verify") {
  if (plan.where.state !== "moved") { report(plan); say("\n✗ 还没搬"); process.exit(1); }
  const { todo } = report(plan, { verify: true });
  say(todo ? `\n✗ 还有 ${todo} 处没换完（重跑 --apply 会接着做）` : "\n✓ 记着旧路径的地方都换完了");
  process.exit(todo ? 1 : 0);
}

const { blockers, todo } = report(plan);
if (blockers.length) {
  say(`\n✗ 不能真做：${[...new Set(blockers)].join("；")}`);
  process.exit(opts.mode === "apply" ? 2 : 1);
}
if (opts.mode !== "apply") {
  say(todo ? `\n演练完毕：以上 ${todo} 项会在 --apply 时处理${opts.link ? `，并留一个 ${opts.from} → ${opts.to} 的过渡链接` : ""}。什么都没改。` : "\n演练完毕：没有要做的。");
  process.exit(todo ? 1 : 0);
}

const journal = Journal.create(home, { from: opts.from, to: opts.to });
say(`\n开始真做；账本：${journal.dir}`);
try {
  apply(plan, { journal, link: opts.link, log: say });
} catch (error) {
  journal.data.failedAt = new Date().toISOString();
  journal.data.error = String(error.stack ?? error);
  journal.save();
  say(`\n✗ 做到一半失败：${error.message}`);
  say(`  已经做完的步骤记在 ${journal.dir}/journal.json。两条路：`);
  say(`  · 修好原因后原样再跑一次 --apply（做过的不会再做）`);
  say(`  · 或者退回：node ${existsSync(opts.to) ? opts.to : opts.from}/scripts/relocate-checkout.mjs --from ${opts.from} --to ${opts.to} --rollback ${journal.dir}`);
  process.exit(3);
}
journal.data.finishedAt = new Date().toISOString();
journal.save();

say("\n核对：");
const after = scan({ from: opts.from, to: opts.to, home, db: opts.db && (mapPath(resolve(opts.db), opts.from, opts.to) ?? opts.db) });
const { todo: left } = report(after, { verify: true });
const stillLink = (() => { try { return lstatSync(opts.from).isSymbolicLink(); } catch { return false; } })();
say(left ? `\n✗ 还有 ${left} 处没换完，见上（多半是迁移期间有别的进程把配置写回去了；再跑一次 --apply）` : "\n✓ 搬完了。");
if (stillLink) say(`  过渡链接 ${opts.from} 留着；过几天确认没人再用旧路径后：node ${opts.to}/scripts/relocate-checkout.mjs --from ${opts.from} --to ${opts.to} --unlink`);
say(`  现在 cd ${opts.to}，再按 docs/relocate-checkout.md 往下做（装依赖、构建、启动、核对）。`);
process.exit(left ? 1 : 0);
