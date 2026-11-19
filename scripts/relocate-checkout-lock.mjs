// 迁移期间跟 navi 服务互斥：按服务端离线维护锁的文件格式落锁，服务起手时看得见它、起不来。
//
// 口径照抄 server/src/maintenance-lock.ts、resource-claim.ts、navi-presence.ts（各条「为什么」都写在
// 那几份里，这里不复述）。脚本要在没有构建产物、没有 node_modules 的检出里裸跑，导不了那几份 .ts，
// 所以同一套格式在这里再写一遍：
//   · 资源键 = 库文件 + 同目录的 runs/，各取 realpath；
//   · 「查对方 + 建自己」整段放在占有锁 `<键>.navi-claim.lock` / `.ash-claim.lock` 里（按文件名排序取）；
//   · 长命锁 `<键>.maintenance.lock`，内容带 pid 与进程启动时刻 —— 服务起手的 liveMaintenanceHolderForAny
//     只认这两条，脚本死了锁自动失效；
//   · 查在线：单例锁 `<库>.navi.lock` / `.ash.lock`、在线登记 `<键>.navi-online.<pid>.json` / `.ash-online.`，
//     新旧两代名字都认（改名之前起的服务只写旧名）。
// 锁文件在 data/ 里，跟着目录树一起搬走；放锁时按搬前、搬后两个位置找自己那份。
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LEGACY_PRESENCE_PREFIX, LEGACY_RESOURCE_CLAIM_SUFFIX, LEGACY_SINGLETON_LOCK_SUFFIX } from "./legacy-names.mjs";
import { mapPath } from "./relocate-checkout-paths.mjs";
import { isDirNoFollow, listDir, readTextOr } from "./relocate-checkout-fs.mjs";

const CLAIM_SUFFIXES = [".navi-claim.lock", LEGACY_RESOURCE_CLAIM_SUFFIX];
const MAINTENANCE_SUFFIX = ".maintenance.lock";
const SINGLETON_SUFFIXES = [".navi.lock", LEGACY_SINGLETON_LOCK_SUFFIX];
const PRESENCE_PREFIXES = [".navi-online.", LEGACY_PRESENCE_PREFIX];
const START_TOLERANCE_MS = 10_000;
const CLAIM_BUDGET_MS = 3_000;
const selfStartedAtMs = () => Date.now() - Math.round(process.uptime() * 1000);

function canonicalKey(p) {
  try { return realpathSync(p); } catch { /* 还不存在 */ }
  try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; }
}

/** 一套资源的全部键：库文件与它的 runs 目录（与服务端 resourceKeysFor 同口径）。 */
export const resourceKeys = (dbFile) => [...new Set([canonicalKey(dbFile), canonicalKey(join(dirname(dbFile), "runs"))])].sort();

/** 进程启动时刻（毫秒）；查不到返回 null。ps 的 lstart 跟随 locale，所以固定成 C。 */
function processStartMs(pid) {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  const ms = r.status === 0 ? Date.parse(r.stdout.trim()) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** pid 还活着、而且（记了启动时刻的话）是同一个进程 —— pid 被复用的不算。 */
function alive(pid, startedAtMs) {
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
function atomicCreate(path, text) {
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
    const held = readJson(file, []);
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
export function liveHolders(dbFile) {
  const reasons = [];
  const errors = [];
  for (const suffix of SINGLETON_SUFFIXES) {
    const lock = `${dbFile}${suffix}`;
    const r = readJson(lock, errors);
    if (r.absent) continue;
    if (r.unreadable || !Number.isInteger(r.body?.pid)) { reasons.push(`单例锁 ${lock} 读不懂，按服务仍在运行处理`); continue; }
    if (alive(r.body.pid, r.body.processStartedAtMs)) reasons.push(`单例锁 ${lock} 的持有进程 ${r.body.pid} 还活着`);
  }
  for (const key of resourceKeys(dbFile)) {
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
    if (m.body && Number.isInteger(m.body.pid) && m.body.pid !== process.pid && alive(m.body.pid, m.body.processStartedAtMs)) {
      reasons.push(`维护锁 ${key}${MAINTENANCE_SUFFIX}：进程 ${m.body.pid} 正在维护这份数据（${m.body.note ?? ""}）`);
    }
  }
  return { reasons, errors };
}

/**
 * 在占有锁里复查一遍在线，再落下维护锁；有人在线或没答上来就抛错，什么都不留。
 * 库所在目录都不存在（检出里压根没有数据）时没有可锁的东西，返回 null。
 */
export function acquire(dbFile, note) {
  if (!isDirNoFollow(dirname(dbFile))) return null;
  const keys = resourceKeys(dbFile);
  const claims = [...new Set(keys.flatMap((k) => CLAIM_SUFFIXES.map((s) => `${k}${s}`)))].sort();
  const releases = [];
  try {
    for (const file of claims) releases.push(takeClaim(file, note));
    const live = liveHolders(dbFile);
    if (live.reasons.length || live.errors.length) throw new Error([...live.reasons, ...live.errors].join("；"));
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
}
