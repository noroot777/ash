// ash 的**在线登记**：一个活着的实例在它会写的**每一个资源键**上留一份记录。
//
// 为什么单例锁不够用来回答「这套资源现在有没有人在线写」（第 3 轮审查 F2）：
// ① 单例锁按**库文件**命名。共享同一份 `runs` 的另一个库路径（副本、别名）看不见它，
//    而回填真正要改的 trace 文件就在那份 runs 里；
// ② `ASH_ALLOW_MULTI=1` 起的实例**压根不写单例锁**（那是它的语义：放弃排他）。于是离线
//    迁移探不到它，两边同时写同一条线程的账，谁都不知道最后落下的是什么。
//
// 所以登记和单例锁是两件事：**登记是存在证明，不是排他锁**。允许同时有多份（ALLOW_MULTI
// 就会有），所以一个实例一份文件（名字带 pid），读的时候扫同目录。
//
// 判「还活着」只认两条硬事实：pid 还在 + 进程启动时刻对得上（pid 被复用就不算）。读不懂
// 或者主人已死的记录顺手清掉 —— 留着只会让下一次迁移永远被一份残骸挡在外面。
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isPidAlive } from "./platform.js";
import { inspectProcess } from "./proc.js";
import { atomicCreateWithContent, canonicalResourceKey } from "./resource-claim.js";

const PREFIX = ".ash-online.";
const SUFFIX = ".json";
/** 进程启动时刻的比较余量：ps 的精度到秒。 */
const START_TIME_TOLERANCE_MS = 10_000;

export type AshPresence = {
  pid: number;
  startedAt: string | null;
  processStartedAtMs: number | null;
  port: number | null;
  command: string | null;
  /** 这份登记落在哪个资源键上。 */
  key: string;
  /** `exclusive` = 同时也拿着单例锁；`shared` = ASH_ALLOW_MULTI 起的实例。 */
  mode: "exclusive" | "shared";
};

export const presenceFileFor = (key: string, pid = process.pid): string =>
  `${key}${PREFIX}${pid}${SUFFIX}`;

function readPresence(file: string): AshPresence | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AshPresence>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return parsed as AshPresence;
  } catch {
    return null;
  }
}

function alive(record: AshPresence): boolean {
  if (!isPidAlive(record.pid)) return false;
  if (typeof record.processStartedAtMs !== "number") return true;
  const info = inspectProcess(record.pid);
  if (info?.startedAtMs === null || info?.startedAtMs === undefined) return true;
  return Math.abs(info.startedAtMs - record.processStartedAtMs) <= START_TIME_TOLERANCE_MS;
}

/** 这个资源键上现在有没有活着的 ash。顺手清掉已经没主的记录。 */
export function liveAshPresenceFor(key: string): AshPresence | null {
  const canonical = canonicalResourceKey(key);
  const dir = dirname(canonical);
  const head = `${basename(canonical)}${PREFIX}`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith(head) || !name.endsWith(SUFFIX)) continue;
    const file = join(dir, name);
    const record = readPresence(file);
    if (record && alive(record)) return record;
    try {
      unlinkSync(file); // 没主的残骸
    } catch { /* 别人同时清了 */ }
  }
  return null;
}

/** 这一组资源键里，第一个有活着的 ash 的键。 */
export function liveAshPresenceForAny(keys: readonly string[]):
{ key: string; presence: AshPresence } | null {
  for (const key of keys) {
    const presence = liveAshPresenceFor(key);
    if (presence) return { key, presence };
  }
  return null;
}

export type AshPresenceRegistration = { files: string[]; release: () => void };

/**
 * 把自己登记到这一组资源键上。**调用点必须在共同占有锁（`withResourceClaim`）里面** ——
 * 「查对方 + 登记自己」要是分成两段，两边各自都能通过检查（那正是 F2 的交错）。
 */
export function registerAshPresence(
  keys: readonly string[],
  info: { port: number | null; mode: AshPresence["mode"] },
): AshPresenceRegistration {
  const processStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);
  const files: string[] = [];
  for (const key of [...new Set(keys.map(canonicalResourceKey))]) {
    const file = presenceFileFor(key);
    const record: AshPresence = {
      pid: process.pid,
      startedAt: new Date(processStartedAtMs).toISOString(),
      processStartedAtMs,
      port: info.port,
      command: process.argv.join(" "),
      key,
      mode: info.mode,
    };
    mkdirSync(dirname(file), { recursive: true });
    if (!atomicCreateWithContent(file, JSON.stringify(record, null, 2))) {
      // 同一个 pid 的旧记录（上一个同号进程留下的残骸）：清掉再登记。
      try {
        unlinkSync(file);
      } catch { /* 别人清了 */ }
      atomicCreateWithContent(file, JSON.stringify(record, null, 2));
    }
    files.push(file);
  }
  return {
    files,
    release: () => {
      for (const file of files) {
        if (readPresence(file)?.pid !== process.pid) continue; // 不是自己那份就别删
        try {
          unlinkSync(file);
        } catch { /* 已经没了 */ }
      }
    },
  };
}

/** 给人看的一句话。 */
export const describeAshPresence = (found: { key: string; presence: AshPresence }): string =>
  `PID ${found.presence.pid}（${found.presence.mode === "shared" ? "ASH_ALLOW_MULTI 实例" : "持单例锁"}`
  + `${found.presence.port === null ? "" : `，端口 ${found.presence.port}`}，起于 ${found.presence.startedAt ?? "不详"}）`
  + ` 正在线占用 ${found.key}`;

export const presenceExists = (key: string, pid: number): boolean => existsSync(presenceFileFor(key, pid));
