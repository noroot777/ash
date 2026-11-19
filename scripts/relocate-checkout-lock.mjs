// 迁移期间跟 navi 服务互斥：按服务端离线维护锁的文件格式落锁，服务起手时看得见它、起不来。
//
// 口径照抄 server/src/maintenance-lock.ts、resource-claim.ts、navi-presence.ts（各条「为什么」都写在
// 那几份里，这里不复述）。脚本要在没有构建产物、没有 node_modules 的检出里裸跑，导不了那几份 .ts，
// 所以同一套格式在这里再写一遍：
//   · 资源键 = 库文件 + runs 目录，各取 realpath（还不存在的退一步解析父目录；**解析失败**——权限、I/O、
//     链接成环——直接抛，不拿一个没证明过的名字去锁，与 canonicalResourceKey 同口径）；
//   · 「查对方 + 建自己」整段放在占有锁 `<键>.navi-claim.lock` / `.ash-claim.lock` 里（按文件名排序取）；
//   · 长命锁 `<键>.maintenance.lock`，内容带 pid 与进程启动时刻 —— 服务起手的 liveMaintenanceHolderForAny
//     只认这两条，脚本死了锁自动失效；
//   · 查在线：单例锁 `<库>.navi.lock` / `.ash.lock`、在线登记 `<键>.navi-online.<pid>.json` / `.ash-online.`，
//     新旧两代名字都认（改名之前起的服务只写旧名）。
// 锁文件落在库与 runs 的真实位置（data/ 是链接就落在它指着的地方）；在树里的跟着目录树一起搬走，
// 放锁时按搬前、搬后两个位置找自己那份。
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { LEGACY_PRESENCE_PREFIX, LEGACY_RESOURCE_CLAIM_SUFFIX, LEGACY_SINGLETON_LOCK_SUFFIX } from "./legacy-names.mjs";
import { mapPath } from "./relocate-checkout-paths.mjs";
import { absent, listDir, readTextOr } from "./relocate-checkout-fs.mjs";

const CLAIM_SUFFIXES = [".navi-claim.lock", LEGACY_RESOURCE_CLAIM_SUFFIX];
const MAINTENANCE_SUFFIX = ".maintenance.lock";
const SINGLETON_SUFFIXES = [".navi.lock", LEGACY_SINGLETON_LOCK_SUFFIX];
const PRESENCE_PREFIXES = [".navi-online.", LEGACY_PRESENCE_PREFIX];
const START_TOLERANCE_MS = 10_000;
const CLAIM_BUDGET_MS = 3_000;
export const selfStartedAtMs = () => Date.now() - Math.round(process.uptime() * 1000);

function realpathOrAbsent(p) {
  try { return realpathSync(p); }
  catch (error) {
    if (absent(error)) return null;
    throw new Error(`无法解析 ${p} 的真实落点（${error.code ?? error.message}），不能据此认定锁的是哪套资源`);
  }
}

function canonicalKey(p) {
  const abs = resolve(p);
  const direct = realpathOrAbsent(abs);
  if (direct !== null) return direct;
  const parent = realpathOrAbsent(dirname(abs));
  return parent === null ? abs : join(parent, basename(abs));
}

/** 一套资源的全部键：库文件与 runs 目录（与服务端 resourceKeysFor 同口径；runs 可以不止一处候选）。 */
export const resourceKeys = (dbFile, runsDirs = [join(dirname(dbFile), "runs")]) =>
  [...new Set([dbFile, ...runsDirs].map(canonicalKey))].sort();

/** 进程启动时刻（毫秒）；查不到返回 null。ps 的 lstart 跟随 locale，所以固定成 C。 */
function processStartMs(pid) {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  const ms = r.status === 0 ? Date.parse(r.stdout.trim()) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** pid 还活着、而且（记了启动时刻的话）是同一个进程 —— pid 被复用的不算。 */
export function alive(pid, startedAtMs) {
  try { process.kill(pid, 0); } catch (error) { if (error.code !== "EPERM") return false; }
  if (typeof startedAtMs !== "number") return true;
  const now = processStartMs(pid);
  return now === null || Math.abs(now - startedAtMs) <= START_TOLERANCE_MS;
}

const readJson = (file, errors) => {
  const text = readTextOr(file, errors);
  if (text === null) return { absent: true };
  try { return { body: JSON.parse(text) }; } catch { return { unreadable: true }; }
};

/** 带着内容原子出现（link 一份写好的临时文件）；已经存在返回 false。 */
export function atomicCreate(path, text) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    try { unlinkSync(tmp); } catch { /* 已经 link 走或没建起来 */ }
  }
}

function takeClaim(file, note) {
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, note, token, at: new Date().toISOString(), startedAtMs: selfStartedAtMs() });
  const deadline = Date.now() + CLAIM_BUDGET_MS;
  for (;;) {
    if (atomicCreate(file, body)) return () => { try { if (JSON.parse(readFileSync(file, "utf8")).token === token) unlinkSync(file); } catch { /* 已经没了 */ } };
    const readErrors = [];
    const held = readJson(file, readErrors);
    if (readErrors.length) throw new Error(`${readErrors[0]}：分不清它的持有者还在不在`);
    if (held.absent) continue;
    const stale = held.body && typeof held.body.pid === "number" ? !alive(held.body.pid, held.body.startedAtMs)
      : (() => { try { return Date.now() - statSync(file).mtimeMs > 30_000; } catch { return true; } })();
    if (stale) { try { unlinkSync(file); } catch { /* 别人同时清了 */ } continue; }
    if (Date.now() >= deadline) throw new Error(`${file} 一直被别的进程占着（${held.body ? `PID ${held.body.pid}，${held.body.note}` : "内容读不出来"}）`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

/**
 * 这套资源上还有谁活着：navi 服务（单例锁、在线登记）、别的维护进程（含另一次迁移）。
 * 返回 { reasons, errors }：reasons 是确认在线的，errors 是没答上来的 —— 两者都要拦。
 */
export function liveHolders(dbFile, runsDirs) {
  const reasons = [];
  const errors = [];
  for (const suffix of SINGLETON_SUFFIXES) {
    const lock = `${dbFile}${suffix}`;
    const r = readJson(lock, errors);
    if (r.absent) continue;
    if (r.unreadable || !Number.isInteger(r.body?.pid)) { reasons.push(`单例锁 ${lock} 读不懂，按服务仍在运行处理`); continue; }
    if (alive(r.body.pid, r.body.processStartedAtMs)) reasons.push(`单例锁 ${lock} 的持有进程 ${r.body.pid} 还活着`);
  }
  let keys;
  try { keys = resourceKeys(dbFile, runsDirs); } catch (error) { errors.push(error.message); return { reasons, errors }; }
  for (const key of keys) {
    const dir = dirname(key);
    const heads = PRESENCE_PREFIXES.map((p) => `${basename(key)}${p}`);
    for (const name of listDir(dir, errors)) {
      if (!heads.some((h) => name.startsWith(h)) || !name.endsWith(".json")) continue;
      const r = readJson(join(dir, name), errors);
      if (r.absent) continue;
      if (r.unreadable || !Number.isInteger(r.body?.pid)) { errors.push(`在线登记 ${join(dir, name)} 读不懂，分不清那个 navi 还在不在`); continue; }
      if (alive(r.body.pid, r.body.processStartedAtMs)) reasons.push(`在线登记 ${join(dir, name)}：navi 进程 ${r.body.pid}${r.body.port ? `（端口 ${r.body.port}）` : ""}还活着`);
    }
    const m = readJson(`${key}${MAINTENANCE_SUFFIX}`, errors);
    // 读不懂的维护锁证明不了持有者已经不在（正常协议是带内容原子建的，不会有半份）：按「不知道」拦下，交给人删。
    if (m.unreadable || (m.body && !Number.isInteger(m.body.pid))) errors.push(`维护锁 ${key}${MAINTENANCE_SUFFIX} 读不懂，分不清持有者还在不在；确认没有别的维护在跑之后删掉它`);
    else if (m.body && m.body.pid !== process.pid && alive(m.body.pid, m.body.processStartedAtMs)) {
      reasons.push(`维护锁 ${key}${MAINTENANCE_SUFFIX}：进程 ${m.body.pid} 正在维护这份数据（${m.body.note ?? ""}）`);
    }
  }
  return { reasons, errors };
}

/** 把 dir 及缺的上级都建出来，返回新建的那些（从深到浅），放锁时空着就删掉。 */
function ensureDir(dir) {
  const created = [];
  for (let d = resolve(dir); !existsSync(d); d = dirname(d)) created.push(d);
  for (const d of [...created].reverse()) mkdirSync(d);
  return created;
}

/**
 * 在占有锁里复查一遍在线，再落下维护锁；有人在线或没答上来就抛错，什么都不留。dbFiles 给几份库就把几份都锁上、
 * 都查（库改名时新旧两个名字是同一份数据）。**一定返回一把锁**：
 * 库所在目录（跟着链接走）还不存在时先把它建出来再锁 —— 不然迁移进行中有人起服务，服务会在这里
 * 建一份新库开始写；放锁时这些新建的目录还空着就删掉。
 */
export function acquire({ dbFile, dbFiles = [dbFile], runsDirs }, note) {
  const created = [...new Set(dbFiles.map(dirname))].flatMap(ensureDir);
  try {
    const keys = [...new Set(dbFiles.flatMap((db) => resourceKeys(db, runsDirs)))].sort();
    return { ...lockKeys(keys, dbFiles, runsDirs, note), created };
  } catch (error) { removeCreated(created); throw error; }
}

function removeCreated(created) {
  for (const d of created) { try { if (!readdirSync(d).length) rmdirSync(d); } catch { /* 已被别的东西用上 */ } }
}

function lockKeys(keys, dbFiles, runsDirs, note) {
  const claims = [...new Set(keys.flatMap((k) => CLAIM_SUFFIXES.map((s) => `${k}${s}`)))].sort();
  const releases = [];
  try {
    for (const file of claims) releases.push(takeClaim(file, note));
    const live = dbFiles.map((db) => liveHolders(db, runsDirs)).flatMap((r) => [...r.reasons, ...r.errors]);
    if (live.length) throw new Error([...new Set(live)].join("；"));
    const held = [];
    try {
      for (const key of keys) {
        const token = randomUUID();
        const file = `${key}${MAINTENANCE_SUFFIX}`;
        const startedAtMs = selfStartedAtMs();
        const body = { pid: process.pid, processStartedAt: new Date(startedAtMs).toISOString(), processStartedAtMs: startedAtMs, acquiredAt: new Date().toISOString(), note, token, key };
        if (!atomicCreate(file, JSON.stringify(body, null, 2))) {
          // liveHolders 刚确认过没有活着的持有者，所以这是一份陈旧锁
          unlinkSync(file);
          if (!atomicCreate(file, JSON.stringify(body, null, 2))) throw new Error(`${file} 被别人抢先建了`);
        }
        held.push({ file, token });
      }
    } catch (error) {
      release({ held });
      throw error;
    }
    return { held };
  } finally {
    for (const r of releases.reverse()) r();
  }
}

/** 放锁：只删内容里是自己 token 的那份，搬前、搬后两个位置都找。 */
export function release(lock, { from, to } = {}) {
  for (const { file, token } of lock?.held ?? []) {
    for (const p of new Set([file, from && mapPath(file, from, to), from && mapPath(file, to, from)].filter(Boolean))) {
      try { if (JSON.parse(readFileSync(p, "utf8")).token === token) unlinkSync(p); } catch { /* 不在这儿 */ }
    }
  }
  const created = lock?.created ?? [];
  removeCreated([...new Set(created.flatMap((d) => [d, from && mapPath(d, from, to)].filter(Boolean)))]);
}
