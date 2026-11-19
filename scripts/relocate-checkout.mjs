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
// 其它选项：--no-link（不留 旧路径 → 新路径 的过渡链接）、--claude-claim <目录名> / --claude-skip <目录名>
// （认不出归属的 claude 会话目录，点名算这棵树的 / 不是，可重复）、--db <库文件>、--home <家目录>（只给回归用）。
// 退出码：0 做完/核对干净；1 演练或核对发现还有要处理的；2 预检拦下，什么都没动；3 做到一半失败（看账本）。
//
// 操作单、做了什么、为什么留链接、哪些覆盖不到：docs/relocate-checkout.md。
import { execFileSync } from "node:child_process";
import { readlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { apply } from "./relocate-checkout-apply.mjs";
import { isLink, lexists } from "./relocate-checkout-fs.mjs";
import { Journal, rollback } from "./relocate-checkout-journal.mjs";
import { acquire, release } from "./relocate-checkout-lock.mjs";
import { checkWorktrees, dbFileIn, locateTree, scan } from "./relocate-checkout-scan.mjs";

function parseArgs(argv) {
  const o = { link: true, claims: { ours: [], skip: [] } };
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
    else if (a === "--claude-claim" || a === "--claude-skip") {
      const v = val();
      if (!v) { console.error(`${a} 后面要写目录名`); process.exit(2); }
      o.claims[a === "--claude-claim" ? "ours" : "skip"].push(v);
    } else if (a === "-h" || a === "--help") o.help = true;
    else { console.error(`认不得的参数：${a}`); process.exit(2); }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.from || !opts.to) {
  console.log("用法：node scripts/relocate-checkout.mjs --from <旧目录> --to <新目录> [--apply|--verify|--rollback [账本]|--unlink|--set-remote [地址]] [--no-link] [--claude-claim <名>] [--claude-skip <名>]");
  process.exit(opts.help ? 0 : 2);
}
for (const k of ["from", "to"]) {
  if (!isAbsolute(opts[k])) { console.error(`--${k} 要写绝对路径`); process.exit(2); }
  opts[k] = resolve(opts[k]);
}
if (opts.from === opts.to) { console.error("--from 和 --to 是同一个目录"); process.exit(2); }
const home = resolve(opts.home ?? homedir());
const { from, to } = opts;
const env = process.env;
const say = (s = "") => console.log(s);
const list = (items, fmt, max = 12) => {
  for (const it of items.slice(0, max)) say(`    ${fmt(it)}`);
  if (items.length > max) say(`    …… 另有 ${items.length - max} 项`);
};
const scanNow = () => scan({ from, to, home, env, claims: opts.claims, db: opts.db });

/**
 * 打印清点，返回三类数：blockers 拦真做；todo 是还要改的项数；unresolved 是脚本自己定不了、要人处理的
 * （认不出归属的会话目录、只报不改的 shell 配置……）。读不到的东西（plan.errors）同时算 blockers 和
 * unresolved —— 不知道就不能说干净。
 */
function report(plan, { verify = false } = {}) {
  const blockers = [];
  const unresolved = [];
  let todo = 0;
  const { where } = plan;
  say(`目录：${plan.from} → ${plan.to}`);
  if (where.state === "pending") { say("  还没搬"); todo += 1; }
  else if (where.state === "moved") say(`  已经搬到新位置；过渡链接：${where.link === "ours" ? `在（${plan.from} → ${readlinkSync(plan.from)}）` : "没有"}`);
  else { say(`  ✗ ${where.why}`); blockers.push(where.why); return { blockers, todo, unresolved: [where.why] }; }
  if (where.state === "pending" && !plan.sameDevice) blockers.push(`${plan.to} 跟 ${plan.from} 不在同一个文件系统上，一步改名做不到`);

  if (plan.errors.length) {
    say(`\n✗ 有 ${plan.errors.length} 处读不到（清点不完整，不能据此判断可以搬 / 已经搬干净）：`);
    list(plan.errors, (e) => e, 20);
    blockers.push("清点不完整");
    unresolved.push(`${plan.errors.length} 处读不到`);
  }

  say("\n服务与任务：");
  say(`  库文件：${plan.dbFile}${plan.db.missing ? "（不存在）" : ""}`);
  if (plan.service.running) { for (const r of plan.service.reasons) say(`  ${verify ? "·" : "✗"} ${r}`); blockers.push("服务还在运行"); }
  else say("  服务已停");
  if (plan.dbState.running.length) {
    say(`  ${verify ? "·" : "✗"} ${plan.dbState.running.length} 个任务还在跑或排着：`);
    list(plan.dbState.running, (t) => `${t.id}  ${t.status}  ${t.title ?? ""}`);
    blockers.push("有任务在跑");
  }
  if (plan.dbState.monitors.length) {
    say(`  ${verify ? "·" : "✗"} ${plan.dbState.monitors.length} 个哨兵还在盯：`);
    list(plan.dbState.monitors, (m) => `${m.id}（任务 ${m.taskId}）`);
    blockers.push("有哨兵在跑");
  }

  say("\n进程：");
  const p = plan.processes;
  if (p.blocking.length) {
    say(`  ${verify ? "·" : "✗"} ${p.blocking.length} 个进程的工作目录在树里（agent、哨兵、预览、构建……要先结束）：`);
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
  const gone = wt.items.filter((w) => w.missing);
  say(`  登记 ${wt.items.length} 个${gone.length ? `（${gone.length} 个目录已经不在，git 自己会当可清理的处理，不动）` : ""}`);
  if (verify) list(gone, (w) => `已不在：${w.worktree}`, 5);
  if (wt.edits.length) { say(`  要改的路径文件 ${wt.edits.length} 份（工作区里的 .git 与仓库里的 gitdir）`); todo += wt.edits.length; }
  if (verify) { const probs = checkWorktrees(wt.items); for (const x of probs) say(`  ✗ ${x}`); todo += probs.length; }

  say("\n树里的链接：");
  const sl = plan.symlinks;
  say(`  指向旧位置的绝对链接：${sl.retarget.length} 个${sl.retarget.length ? "（改指新位置）" : ""}`);
  todo += sl.retarget.length;
  if (sl.escaping.length) {
    say(`  ! ${sl.escaping.length} 个相对链接指到树外，换了上级目录会断（不改，要手工处理）：`);
    list(sl.escaping, (x) => `${x.path} → ${x.target}`, 5);
    unresolved.push(`${sl.escaping.length} 个指到树外的相对链接`);
  }

  say("\nnavi 的库：");
  say(`  旧路径 ${plan.db.total} 处`);
  list(plan.db.refs.sort((a, b) => b.count - a.count), (r) => `${r.table}.${r.column}：${r.count} 处 / ${r.rows} 行`, verify ? 40 : 10);
  todo += plan.db.total;
  if (plan.db.ambiguous) say(`  · 另有 ${plan.db.ambiguous} 处旧路径后面紧跟着文字（${plan.db.ambiguousSamples.join("、")}），分不清是正文还是别的目录，不改`);
  for (const f of plan.dataFiles) {
    say(`  ${f.problems.length ? "✗" : "·"} ${f.file}：${f.count} 处${f.problems.length ? `（${f.problems.join("；")}）` : ""}`);
    todo += f.count;
    if (f.problems.length) blockers.push("数据文件改完会撞名");
  }

  say("\n执行器的会话：");
  const c = plan.claude;
  say(`  claude 会话目录要改名：${c.moves.length} 个${c.moves.some((m) => m.merge) ? `（${c.moves.filter((m) => m.merge).length} 个目标已存在，并进去）` : ""}`);
  list(c.moves.filter((m) => !m.from.includes("--worktrees-")), (m) => `${m.from} → ${m.to}（${m.evidence}）`, 4);
  for (const m of [...c.moves, ...plan.grok.moves].filter((x) => x.conflicts.length)) {
    say(`  ✗ ${m.from} 并进 ${m.to} 时有 ${m.conflicts.length} 项内容不同：${m.conflicts.slice(0, 3).join("、")}`);
    blockers.push("会话目录合并有冲突");
  }
  if (c.unclassified.length) {
    say(`  ! ${c.unclassified.length} 个目录认不出是不是这棵树的，不动（确认是的话加 --claude-claim <目录名>，不是的话加 --claude-skip <目录名>）：`);
    list(c.unclassified, (u) => `${u.path}（${u.why}）`, 8);
    unresolved.push(`${c.unclassified.length} 个认不出归属的 claude 会话目录`);
  }
  if (plan.memory.length) { say(`  claude 长期记忆里的旧路径：${plan.memory.length} 份`); todo += plan.memory.length; }
  say(`  grok 会话目录要改名：${plan.grok.moves.length} 个`);
  for (const o of plan.grok.odd) say(`  ! ${o.path}：${o.why}`);
  if (plan.grok.odd.length) unresolved.push(`${plan.grok.odd.length} 个编码不标准的 grok 会话目录`);
  say(`  opencode 会话的工作目录要改：${plan.opencode.rows.length} 条${plan.opencode.missing ? "（没装 opencode）" : ""}`);
  say("  codex：按会话号续跑、用起跑时给的工作目录，实测不用改它的记录");
  todo += c.moves.length + plan.grok.moves.length + plan.opencode.rows.length;

  say("\n配置文件：");
  for (const r of plan.configs.relink) { say(`  · ${r.path} 是指进树里的链接：改指 ${r.next}`); todo += 1; }
  for (const f of plan.configs.rewrite) {
    say(`  ${f.problems.length ? "✗" : "·"} ${f.file}${f.real !== f.file ? `（链接，改它指着的 ${f.real}）` : ""}：${f.count} 处${f.problems.length ? `（${f.problems.join("；")}）` : ""}`);
    todo += f.count;
    if (f.problems.length) blockers.push("有配置改完会撞名，要先手工处理");
  }
  if (!plan.configs.rewrite.length && !plan.configs.relink.length) say("  没有要改的");
  for (const f of plan.configs.reportOnly) {
    say(`  ! ${f.file} 里写着旧路径（脚本不改，自己改掉）：`);
    list(f.lines, ([n, l]) => `${n}: ${l.trim().slice(0, 140)}`, 5);
    unresolved.push(`${f.file} 里的旧路径`);
  }

  say("\n远端：");
  say(`  origin = ${plan.remote.url ?? "（没有）"}`);
  if (plan.remote.suggested) say(`  GitHub 上改名之后：node scripts/relocate-checkout.mjs --from ${plan.from} --to ${plan.to} --set-remote ${plan.remote.suggested}`);
  return { blockers: [...new Set(blockers)], todo, unresolved };
}

/** 库此刻在哪（树搬了没搬都算得出），用来拿维护锁。 */
function currentDb() {
  const where = locateTree({ from, to });
  const root = where.root ?? (lexists(join(to, "data")) ? to : from);
  return opts.db ? resolve(opts.db) : dbFileIn(root);
}

/** 在维护锁里跑 fn：迁移 / 退回期间 navi 起不来，另一次迁移也进不来。 */
function locked(note, fn) {
  let lock;
  try { lock = acquire(currentDb(), note); }
  catch (error) { say(`✗ 拿不到维护锁，什么都没动：${error.message}`); process.exit(2); }
  try { return fn(); } finally { release(lock, { from, to }); }
}

if (opts.mode === "rollback") {
  const journals = opts.journal ? [new Journal(resolve(opts.journal))] : Journal.pending(home, { from, to });
  if (!journals.length) { say("没有要退回的账本（~/.navi-relocate/*/journal.json）"); process.exit(0); }
  locked(`relocate-checkout --rollback ${from} ${to}`, () => {
    for (const journal of journals) {
      if (!journal.data.steps.some((s) => !s.undone)) { say(`这份账本已经退回过：${journal.dir}`); continue; }
      say(`照账本退回：${journal.dir}`);
      try { rollback(journal, say); }
      catch (error) { say(`✗ 退回中途失败：${error.message}\n  账本里标了 undone 的已经退回；修好原因再跑一次 --rollback 接着退（每一步都按盘上此刻的样子判断，重复跑是安全的）`); process.exit(3); }
    }
  });
  say("已退回。");
  process.exit(0);
}

if (opts.mode === "remote") {
  const plan = scanNow();
  const url = opts.remote ?? plan.remote?.suggested;
  if (!url) { say("算不出新地址，请写明：--set-remote <地址>"); process.exit(2); }
  try { execFileSync("git", ["ls-remote", "--heads", url], { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 }); }
  catch { say(`✗ ${url} 现在连不上（GitHub 上还没改名？），没改远端`); process.exit(2); }
  execFileSync("git", ["-C", plan.where.root, "remote", "set-url", "origin", url]);
  say(`origin → ${url}`);
  process.exit(0);
}

/** 核对的结论：没有要改的、没有要人处理的、没有读不到的，才算干净。 */
function verdict(plan) {
  const r = report(plan, { verify: true });
  const left = [...(r.todo ? [`还有 ${r.todo} 处没换完（重跑 --apply 会接着做）`] : []), ...r.unresolved];
  return left;
}

if (opts.mode === "unlink") {
  const plan = scanNow();
  if (plan.where.state !== "moved" || plan.where.link !== "ours") { say("没有可拿掉的过渡链接"); process.exit(plan.where.state === "moved" ? 0 : 2); }
  const left = verdict(plan);
  if (plan.processes.argvRefs.length) left.push(`${plan.processes.argvRefs.length} 个进程的命令行里还写着旧路径`);
  if (left.length) { say(`\n✗ 链接先留着：${left.join("；")}`); process.exit(1); }
  unlinkSync(from);
  say(`\n✓ 已拿掉 ${from}`);
  process.exit(0);
}

if (opts.mode === "verify") {
  const plan = scanNow();
  if (plan.where.state !== "moved") { report(plan); say("\n✗ 还没搬"); process.exit(1); }
  const left = verdict(plan);
  say(left.length ? `\n✗ 还没完：${left.join("；")}` : "\n✓ 记着旧路径的地方都换完了");
  process.exit(left.length ? 1 : 0);
}

if (opts.mode !== "apply") {
  const { blockers, todo } = report(scanNow());
  if (blockers.length) { say(`\n✗ 不能真做：${blockers.join("；")}`); process.exit(1); }
  say(todo ? `\n演练完毕：以上 ${todo} 项会在 --apply 时处理${opts.link ? `，并留一个 ${from} → ${to} 的过渡链接` : ""}。什么都没改。` : "\n演练完毕：没有要做的。");
  process.exit(todo ? 1 : 0);
}

// 真做：先拿维护锁（锁里复查过服务不在线），再在锁里清点一遍，这一遍过了预检才动手。
const code = locked(`relocate-checkout --apply ${from} ${to}`, () => {
  const plan = scanNow();
  const { blockers } = report(plan);
  if (blockers.length) { say(`\n✗ 不能真做：${blockers.join("；")}`); return 2; }
  const journal = Journal.create(home, { from, to });
  say(`\n开始真做；账本：${journal.dir}`);
  try {
    apply(plan, { journal, link: opts.link, log: say, home, env, claims: opts.claims, db: opts.db && resolve(opts.db) });
  } catch (error) {
    journal.data.failedAt = new Date().toISOString();
    journal.data.error = String(error.stack ?? error);
    try { journal.save(); } catch { /* 账本落不了盘：已经做的每一步在动手前都记过意图，退回照样找得到 */ }
    say(`\n✗ 做到一半失败：${error.message}`);
    say(`  做到哪一步记在 ${journal.dir}/journal.json。两条路：`);
    say("  · 修好原因后原样再跑一次 --apply（做过的不会再做）");
    say(`  · 或者退回：node ${lexists(to) ? to : from}/scripts/relocate-checkout.mjs --from ${from} --to ${to} --rollback`);
    return 3;
  }
  journal.data.finishedAt = new Date().toISOString();
  journal.save();
  return 0;
});
if (code) process.exit(code);

say("\n核对：");
const left = verdict(scanNow());
if (isLink(from)) say(`\n过渡链接 ${from} 留着；处理完上面的、过几天确认没人再用旧路径后：node ${to}/scripts/relocate-checkout.mjs --from ${from} --to ${to} --unlink`);
say(`下一步：cd ${to}，按 docs/relocate-checkout.md 往下做（装依赖、构建、启动、核对）。`);
say(left.length ? `\n✗ 搬完了，但还没完：${left.join("；")}` : "\n✓ 搬完了，记着旧路径的地方都换完了。");
process.exit(left.length ? 1 : 0);
