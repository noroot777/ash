// 重启接管:把上一个 ash 进程已经消费掉的那段 claude 输出重新走一遍解析,让接回来的这一代
// 和「从没中断过」处在同一个状态上(claude-stream.ts 的 `consumed`)。
//
// 不变量:**接回后的状态 = 把整条输出从头到尾不间断读一遍的状态。** 所以重放走的是直播
// 那一份逐行处理(同一个函数,只把对外的产出静音),而不是另写一套「挑几样账本补回来」——
// 两套判据迟早分叉:上一版只补了后台账本,回合识别、忙闲、打断标志全是空的,于是通知回合
// 的结果被当成孤儿回执吞掉、请求中途接回的插话不打断(自由审查 KqmEd8oQLV5_ 第 2 轮)。
//
// 输出流里**看不见**的是 ash 自己写进 stdin 的那一侧:哪个回合结尾是我们打断出来的、插话正文送
// 没送进去、空档里直接送进去的消息(它开的回合可能还一个字都没吐)。它们在写 stdin 之前就落在输出文件旁的 steer journal 里(`loadSteerJournal`,由
// ClaudeControlBridge 记),重放按它认。上一版拿输出里的回执先后去猜(回执可以晚到、前面可以
// 插进后台进度),猜错就把被打断的结尾当成自然结束、提前收台(自由审查 i8RAcPM3zvgD R1)。
//
// 读不出来(文件没了、权限、水位没落在换行上)= 状态未知,**不是**「什么都没有」:调用方按
// 未知处理,不能拿空账本去判「没有后台工作」。
import { closeSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import type { ConsumedOutput } from "./types.js";

const CHUNK = 64 * 1024;

/**
 * 水位之前的那段输出,逐行解析成事件。只读到水位为止、按块读按行吐,不把整份文件读进内存
 * (停机期间文件可能长了很多)。不是 JSON 的行跳过 —— 直播那一路同样跳过它们。读不出来就抛。
 */
export function* consumedEvents(consumed: ConsumedOutput): Generator<unknown> {
  const fd = openSync(consumed.outPath, "r");
  try {
    const chunk = Buffer.alloc(CHUNK);
    let position = 0;
    let rest = Buffer.alloc(0);
    while (position < consumed.offset) {
      const n = readSync(fd, chunk, 0, Math.min(CHUNK, consumed.offset - position), position);
      if (n <= 0) throw new Error(`输出文件只有 ${position} 字节，不到已消费水位 ${consumed.offset}`);
      position += n;
      let buffer = Buffer.concat([rest, chunk.subarray(0, n)]);
      for (let nl = buffer.indexOf(10); nl >= 0; nl = buffer.indexOf(10)) {
        const line = buffer.subarray(0, nl).toString("utf8").trim();
        buffer = buffer.subarray(nl + 1);
        if (!line) continue;
        let ev: unknown;
        try { ev = JSON.parse(line); } catch { continue; }
        yield ev;
      }
      rest = buffer;
    }
    // 水位永远落在换行边界(single-run.ts 的 offsetTimer)。不在 = 这份契约坏了,剩下那半行
    // 是什么说不准。
    if (rest.length) throw new Error(`已消费水位 ${consumed.offset} 没有落在换行边界上`);
  } finally {
    closeSync(fd);
  }
}

/** 主智能体这边开始(或正在)干活的迹象:一个回合在进行。直播与重放共用这一条判据。 */
export function startsTurn(ev: any): boolean {
  return !ev?.parent_tool_use_id && (ev?.type === "assistant" || ev?.type === "stream_event"
    || (ev?.type === "system" && (ev.subtype === "init" || ev.subtype === "status")));
}

/**
 * 一条 ash 发出的打断:它认领第 `result` 个回合结尾(孤儿回执不算)。插话那种带 `sent`,正文写进
 * stdin 之前置 true;纯打断不带。
 */
export interface SteerEntry {
  id: string;
  result: number;
  sent?: boolean;
}

const journalOf = (outPath: string) => `${outPath}.steer.json`;

/**
 * 写进 stdin 的那一侧:`entries` 是发过的打断;`sentAfter` 是最近一次空档里直接送消息时已经有
 * 几个回合结尾 —— 重放完结尾数还是它,那条消息开的回合就还没结尾(哪怕一个字都还没吐)。
 */
export interface SteerJournal {
  entries: SteerEntry[];
  sentAfter?: number;
}

/** 读回打断记录。还没记过 = 没发过打断;别的读不出来一律抛(身份未知,不能当成没有)。 */
export function loadSteerJournal(outPath: string): SteerJournal {
  let raw: string;
  try {
    raw = readFileSync(journalOf(outPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw error;
  }
  const saved = JSON.parse(raw);
  const entries = Array.isArray(saved?.entries) ? saved.entries : null;
  const valid = (entry: any): entry is SteerEntry => typeof entry?.id === "string" && Number.isInteger(entry.result)
    && (entry.sent === undefined || typeof entry.sent === "boolean");
  const sentAfter = saved?.sentAfter;
  if (!entries || !entries.every(valid) || (sentAfter !== undefined && !Number.isInteger(sentAfter))) {
    throw new Error(`打断记录 ${journalOf(outPath)} 格式不对`);
  }
  return {
    entries: entries.map(({ id, result, sent }: SteerEntry) => ({ id, result, ...(sent === undefined ? {} : { sent }) })),
    ...(sentAfter === undefined ? {} : { sentAfter }),
  };
}

/** 整份重写(先写临时文件再改名,断电也不会留下半份)。写不进去就抛。 */
export function saveSteerJournal(outPath: string, journal: SteerJournal): void {
  const path = journalOf(outPath);
  writeFileSync(`${path}.tmp`, JSON.stringify(journal));
  renameSync(`${path}.tmp`, path);
}

/**
 * 「等后台」从哪一刻开始算。期限不能随重启重新起算(重启几次就多给几个满额),而输出里没有
 * 时间戳,所以开始等的那一刻落在输出文件旁边一份小文件里,按「第几个回合结尾」认:同一个
 * 结尾第一次记下的时刻为准,换了一个结尾才覆盖。没有落盘位置(非 detached)或读写失败就用
 * 现在 —— 最坏是这一次期限从接回时重新起算,不影响等不等。
 */
export function holdSince(outPath: string | undefined, turn: number): string {
  const now = new Date().toISOString();
  if (!outPath) return now;
  const path = `${outPath}.hold.json`;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved?.turn === turn && typeof saved.since === "string" && Number.isFinite(Date.parse(saved.since))) return saved.since;
  } catch { /* 还没记过 */ }
  try {
    writeFileSync(path, JSON.stringify({ turn, since: now }));
  } catch (error) {
    console.warn(`[ash] 记不下等后台的起点（${path}），重启接管后期限会从接回时重新起算:`, error);
  }
  return now;
}
