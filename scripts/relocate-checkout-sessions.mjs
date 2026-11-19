// 本地目录迁移的清点：各家执行器按工作目录记的会话目录（claude、grok、opencode）。只读。
//
// 两条不变量，判不了就不动、列出来交给人：
//   · 归属：只凭能核实的证据认领，证据按「哪个目录里的哪份文件」记，读不出来的是未知，不当成同意；
//   · 合并：要并进去的目标必须是同一个上级目录下的真目录（不是链接、不是文件），并且每一层被并的目录
//     权限都不比源宽、属主相同 —— 源目录并完会被删掉，它提供的那层保护不能因此消失。
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeSlug, CLAUDE_SLUG_MAX, grokDirName, isUnder, mapPath } from "./relocate-checkout-paths.mjs";
import { isDirNoFollow, isLink, lexists, listDir } from "./relocate-checkout-fs.mjs";
import { afterPath } from "./relocate-checkout-roots.mjs";

const CWD_SCAN_LIMIT = 16 * 1024 * 1024;

/**
 * 一份会话记录里最早出现的 cwd：逐行按 JSON 解析，找到为止（最多读 16 MiB）。读不出来返回 null ——
 * 那是「不知道」，不是「不在树里」。
 */
function sessionCwd(file, errors) {
  let fd;
  try { fd = openSync(file, "r"); } catch (error) { errors.push(`读不了 ${file}（${error.code}）`); return null; }
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let pending = "";
    for (let pos = 0; pos < CWD_SCAN_LIMIT;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const lines = (pending + buf.subarray(0, n).toString("utf8")).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line.includes('"cwd"')) continue;
        try { const v = JSON.parse(line); if (typeof v?.cwd === "string" && v.cwd) return v.cwd; } catch { /* 不是完整的一行 JSON */ }
      }
    }
    try { const v = JSON.parse(pending); if (typeof v?.cwd === "string" && v.cwd) return v.cwd; } catch { /* 没有 */ }
    return null;
  } catch (error) {
    errors.push(`读不了 ${file}（${error.code}）`);
    return null;
  } finally {
    closeSync(fd);
  }
}

const modeOf = (st) => st.mode & 0o777;
const octal = (m) => `0${m.toString(8)}`;

/** 两棵目录树能不能合并：逐层比权限与属主，同名的子项都是目录就往下比，都是文件且内容相同算不冲突。 */
function mergeConflicts(src, dst, errors, rel = ".") {
  const conflicts = [];
  const ss = lstatSync(src);
  const ds = lstatSync(dst);
  if (ss.uid !== ds.uid) conflicts.push(`${rel}：目标属主（uid ${ds.uid}）与源（uid ${ss.uid}）不同`);
  const wider = modeOf(ds) & ~modeOf(ss) & 0o077;
  if (wider) conflicts.push(`${rel}：目标权限 ${octal(modeOf(ds))} 比源 ${octal(modeOf(ss))} 宽，并进去原来受保护的记录别人就能读`);
  for (const name of listDir(src, errors)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (!lexists(d)) continue;
    const cs = lstatSync(s);
    const cd = lstatSync(d);
    const here = rel === "." ? name : join(rel, name);
    if (cs.isDirectory() && cd.isDirectory()) conflicts.push(...mergeConflicts(s, d, errors, here));
    else if (!(cs.isFile() && cd.isFile() && readFileSync(s).equals(readFileSync(d)))) conflicts.push(`${here}：两边内容不同`);
  }
  return conflicts;
}

/**
 * 把会话目录 src 改名成 dst 之前的核查（清点时做，真做时在动手前再做一遍）：
 * { merge, conflicts } 可以做（conflicts 非空就拦下真做），{ problem } 是这对目录本身不能自动处理。
 */
export function planMerge(src, dst, errors) {
  if (!isDirNoFollow(src)) return { problem: `${isLink(src) ? "是链接" : "不是目录"}，不动` };
  if (!lexists(dst)) return { merge: false, conflicts: [] };
  if (!isDirNoFollow(dst)) return { problem: `新名字 ${dst} 已经有了，但它${isLink(dst) ? "是链接" : "不是目录"}，不往里并` };
  if (realpathSync(dirname(src)) !== realpathSync(dirname(dst))) return { problem: `${dst} 和它不在同一个目录下，不往里并` };
  return { merge: true, conflicts: mergeConflicts(src, dst, errors) };
}

/**
 * claude 按工作目录起的会话目录（主仓那个目录里还有长期记忆 memory/）。目录名是有损编码：
 * `/x/harness-old`、`/x/harness/old`、`/x/harness--worktrees-T1`（与 `/x/harness/.worktrees/T1` 同名）
 * 换出来可以是同一个名字，所以**名字什么都证明不了**，只认：
 *   ① 目录里有会话记录，并且**每一份**都读得出 cwd、都在树里（有一份在树外：混着别人的，整目录不动；
 *      有一份读不出：不知道是谁的，整目录不动，可以点名认领）；
 *   ② 目录里没有会话记录，**每一项**都是以会话号命名的子目录（子代理、工作流脚本），而每个会话号对应的
 *      会话记录（可能不止一份：旧名、新名目录里各一份）都读得出 cwd、都在树里；
 *   ③ 用户用 --claude-claim <完整路径> 点名认领（搬前搬后的写法都认；不按名字 —— 同名的目录在别的配置
 *      目录里可能是别人的）。会话全在树外的、混着树外会话的，点名也不认。
 * --claude-skip 点名的（目录名或完整路径）排在最前，什么证据都不看。其余列进 unclassified，不动、
 * 拦着核对与拆过渡链接。
 */
export function scanClaude(configDirs, { from, to, claims = {}, errors }) {
  const pair = { from, to };
  const oldSlug = claudeSlug(from);
  const newSlug = claudeSlug(to);
  const same = (a, b) => afterPath(a, pair) === afterPath(b, pair);
  const ours = (src) => (claims.ours ?? []).some((c) => same(c, src));
  const skipped = (name, src) => (claims.skip ?? []).some((c) => c === name || same(c, src));
  const inTree = (cwd) => isUnder(cwd, from) || isUnder(cwd, to);
  const mine = (n, slug) => n === slug || n.startsWith(`${slug}-`);
  const moves = [];
  const unclassified = [];
  for (const configDir of configDirs) {
    const projects = join(configDir, "projects");
    const names = listDir(projects, errors).filter((n) => mine(n, oldSlug) || mine(n, newSlug));
    // 证据按 (目录, 会话号) 记；同一个会话号可能在几个目录里各有一份，② 要求每一份都对得上。
    const records = new Map(); // 目录名 → [{ id, cwd }]
    const byId = new Map(); // 会话号 → [cwd | null]
    for (const n of names) {
      if (!isDirNoFollow(join(projects, n))) continue;
      const list = listDir(join(projects, n), errors).filter((f) => f.endsWith(".jsonl")).map((f) => {
        const id = f.slice(0, -".jsonl".length);
        const cwd = sessionCwd(join(projects, n, f), errors);
        byId.set(id, [...(byId.get(id) ?? []), cwd]);
        return { id, cwd };
      });
      records.set(n, list);
    }
    for (const name of names) {
      const src = join(projects, name);
      if (!mine(name, oldSlug) || skipped(name, src)) continue;
      const unsure = (why, claimable) => { unclassified.push({ path: src, why, claimable }); };
      if (!isDirNoFollow(src)) { unsure(`${isLink(src) ? "是链接" : "不是目录"}，不动`, false); continue; }
      const list = records.get(name);
      let why = null;
      if (list.length) {
        const known = list.filter((r) => r.cwd !== null);
        const outside = known.filter((r) => !inTree(r.cwd));
        if (outside.length === list.length) continue; // 全是别人的
        if (outside.length) { unsure(`目录里混着树里和树外（${outside[0].cwd}）的会话，要手工分开`, false); continue; }
        if (known.length < list.length) {
          if (!ours(src)) { unsure(`${list.length - known.length} 份会话记录读不出工作目录，分不清是谁的`, true); continue; }
          why = "--claude-claim 认领";
        } else why = `会话记录的工作目录 ${known[0].cwd}`;
      } else {
        const entries = listDir(src, errors);
        const linked = entries.length > 0 && entries.every((e) => {
          const cwds = byId.get(e);
          return isDirNoFollow(join(src, e)) && cwds?.length && cwds.every((c) => c !== null && inTree(c));
        });
        if (linked) why = `会话 ${entries[0]} 的工作目录 ${byId.get(entries[0])[0]}`;
        else if (ours(src)) why = "--claude-claim 认领";
        else { unsure("目录里没有会话记录，也不是每一项都挂在树里的会话下面，分不清是哪个目录的", true); continue; }
      }
      const next = `${newSlug}${name.slice(oldSlug.length)}`;
      if (next.length > CLAUDE_SLUG_MAX || name.length > CLAUDE_SLUG_MAX) { unsure("目录名超过 claude 的长度上限（会截断再拼哈希），没法按前缀换", false); continue; }
      const dst = join(projects, next);
      const plan = planMerge(src, dst, errors);
      if (plan.problem) { unsure(plan.problem, false); continue; }
      moves.push({ configDir, from: src, to: dst, merge: plan.merge, conflicts: plan.conflicts, evidence: why });
    }
  }
  return { moves, unclassified };
}

/** 给定的 claude 会话目录（只给有证据认领过的）里的长期记忆：memory/ 下所有 .md，含子目录。 */
export function memoryFiles(dirs, errors) {
  const out = [];
  for (const dir of new Set(dirs)) {
    const memory = join(dir, "memory");
    for (const f of listDir(memory, errors, { recursive: true })) if (String(f).endsWith(".md")) out.push(join(memory, String(f)));
  }
  return out;
}

/** grok 的会话目录：目录名是 encodeURIComponent(工作目录)，可以精确解回来。 */
export function scanGrok(dir, { from, to, errors }) {
  const moves = [];
  const odd = [];
  for (const name of listDir(dir, errors)) {
    let decoded;
    try { decoded = decodeURIComponent(name); } catch { continue; }
    const next = mapPath(decoded, from, to);
    if (!next) continue;
    const src = join(dir, name);
    if (grokDirName(decoded) !== name) { odd.push({ path: src, why: "目录名不是标准编码，解不回同一个名字" }); continue; }
    const dst = join(dir, grokDirName(next));
    const plan = planMerge(src, dst, errors);
    if (plan.problem) { odd.push({ path: src, why: plan.problem }); continue; }
    moves.push({ from: src, to: dst, merge: plan.merge, conflicts: plan.conflicts });
  }
  return { dir, moves, odd };
}

/** opencode 的库：会话按 directory 认工作目录，目录不在了续跑直接报错（实测），要改它。 */
export function scanOpencode(file, { from, to, errors }) {
  if (!existsSync(file)) return { file, missing: true, rows: [] };
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch (error) { errors.push(`打不开 opencode 的库 ${file}（${error.message}）`); return { file, rows: [] }; }
  try {
    const rows = [];
    for (const table of ["session", "workspace"]) {
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
      if (!cols.includes("id") || !cols.includes("directory")) continue;
      for (const r of db.prepare(`SELECT id, directory FROM "${table}" WHERE instr(directory, ?) = 1`).all(from)) {
        const next = mapPath(r.directory, from, to);
        if (next) rows.push({ table, id: r.id, directory: r.directory, next });
      }
    }
    return { file, rows };
  } catch (error) {
    errors.push(`读不了 opencode 的库 ${file}（${error.message}）`);
    return { file, rows: [] };
  } finally {
    db.close();
  }
}
