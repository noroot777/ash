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
// 判「还活着」只认两条硬事实：pid 还在 + 进程启动时刻对得上（pid 被复用就不算）。主人已死的记录
// 顺手清掉 —— 留着只会让下一次迁移永远被一份残骸挡在外面。
//
// **「读不出来」不等于「没人在线」**（第 3 轮复核 F2 的同类出口）：枚举目录失败、某份登记读不动或
// 解析不了，都只说明这一问没答上来。那时既不许清掉它、也不许回「没人」—— 这一问的下游是「要不要
// 开始改别人正在写的历史」，答不上来还放行就是两个写入者同时落账。所以这种情况抛
// `AshPresenceUnknownError`，由调用方按拒绝处理。
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

/** 这套资源上「有没有人在线」没答上来。调用方必须按「可能有」处理。 */
export class AshPresenceUnknownError extends Error {
  constructor(public readonly target: string, reason: string) {
    super(`无法确认 ${target} 上还有没有活着的 ash（${reason}）：`
      + "不能据此认定没人在线，请恢复该路径可读取（或删掉读不懂的那份登记）后重试");
    this.name = "AshPresenceUnknownError";
  }
}

type PresenceRead =
  | { kind: "record"; record: AshPresence }
  /** 文件确实没了（ENOENT/ENOTDIR）—— 这是正常形态。 */
  | { kind: "absent" }
  /** 读不动或解析不了：**不是**「没人」。 */
  | { kind: "unreadable"; reason: string };

function readPresence(file: string): PresenceRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable", reason: `读取失败（${code}）` };
  }
  try {
    const parsed = JSON.parse(text) as Partial<AshPresence>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return { kind: "unreadable", reason: "登记里没有可用的 pid" };
    }
    return { kind: "record", record: parsed as AshPresence };
  } catch {
    return { kind: "unreadable", reason: "登记内容不是可解析的 JSON" };
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
  return liveAshPresenceIn(key, null);
}

/**
 * 这个资源键上**除了我之外**还有没有活着的 ash。
 *
 * 跟上面那一问分开给:拿着单例锁只证明「没有别的**守锁的**实例」,`ASH_ALLOW_MULTI=1` 起的
 * 那种压根不写锁、只留在线登记 —— 所以「这台机器上就我一个」必须连这一问一起答
 * (checkpoint-ownership.ts:接管一张滞留凭证之前要拿它当证据)。答不出来照旧抛
 * AshPresenceUnknownError,调用方按「可能有」处理。
 */
export function otherLiveAshPresenceForAny(keys: readonly string[]):
{ key: string; presence: AshPresence } | null {
  for (const key of keys) {
    const presence = liveAshPresenceIn(key, process.pid);
    if (presence) return { key, presence };
  }
  return null;
}

function liveAshPresenceIn(key: string, skipPid: number | null): AshPresence | null {
  const canonical = canonicalResourceKey(key);
  const dir = dirname(canonical);
  const head = `${basename(canonical)}${PREFIX}`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 目录不在 = 这套资源压根没建起来过，没人在线是**证明得了**的。其余（权限、I/O）没答上来。
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new AshPresenceUnknownError(dir, `枚举目录失败（${code}）`);
  }
  for (const name of names) {
    if (!name.startsWith(head) || !name.endsWith(SUFFIX)) continue;
    const file = join(dir, name);
    const read = readPresence(file);
    // 读不懂的那份**既不清也不放过**:清掉它等于把一个可能活着的写入者抹成不存在。
    if (read.kind === "unreadable") throw new AshPresenceUnknownError(file, read.reason);
    if (read.kind === "absent") continue;
    // 自己那一份:既不算「别人」,也不许被当成残骸清掉。
    if (skipPid !== null && read.record.pid === skipPid) continue;
    if (alive(read.record)) return read.record;
    try {
      unlinkSync(file); // 主人已死，是残骸
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
  const drop = (): void => {
    for (const file of [...files].reverse()) {
      const read = readPresence(file);
      if (read.kind !== "record" || read.record.pid !== process.pid) continue; // 不是自己那份就别删
      try {
        unlinkSync(file);
      } catch { /* 已经没了 */ }
    }
  };
  // **一组键要么全登记上、要么一个都不留**（第 3 轮复核 N1）：第二个键的 mkdir/写入/link 因权限或
  // 配额抛出来时，第一份登记留在盘上就会按活 PID 一直把离线回填挡在外面 —— 而这个进程多半压根没
  // 起来。部分登记不算成功占用。
  try {
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
        if (!atomicCreateWithContent(file, JSON.stringify(record, null, 2))) {
          throw new Error(`在线登记写不下去：${file} 这个名字反复被占`);
        }
      }
      files.push(file);
    }
  } catch (error) {
    drop();
    throw error;
  }
  return { files, release: drop };
}

/** 给人看的一句话。 */
export const describeAshPresence = (found: { key: string; presence: AshPresence }): string =>
  `PID ${found.presence.pid}（${found.presence.mode === "shared" ? "ASH_ALLOW_MULTI 实例" : "持单例锁"}`
  + `${found.presence.port === null ? "" : `，端口 ${found.presence.port}`}，起于 ${found.presence.startedAt ?? "不详"}）`
  + ` 正在线占用 ${found.key}`;

export const presenceExists = (key: string, pid: number): boolean => existsSync(presenceFileFor(key, pid));
