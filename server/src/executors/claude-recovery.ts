// 重启接管:把上一个 ash 进程已经消费掉的那段 claude 输出重新走一遍解析,让接回来的这一代
// 和「从没中断过」处在同一个状态上(claude-stream.ts 的 `consumed`)。
//
// 不变量:**接回后的状态 = 把整条输出从头到尾不间断读一遍的状态。** 所以重放走的是直播
// 那一份逐行处理(同一个函数,只把对外的产出静音),而不是另写一套「挑几样账本补回来」——
// 两套判据迟早分叉:上一版只补了后台账本,回合识别、忙闲、打断标志全是空的,于是通知回合
// 的结果被当成孤儿回执吞掉、请求中途接回的插话不打断(自由审查 KqmEd8oQLV5_ 第 2 轮)。
//
// 输出流里**唯一看不见**的状态是 ash 自己的「我刚发过打断」(`interruptPending`,写在 stdin
// 那一侧)。它留下的痕迹是 CLI 回的 `control_response`(request_id 是 ash 起的 `ash_int_*`),
// 由 `interruptedResults` 在重放之前先扫一遍认出来。
//
// 读不出来(文件没了、权限、水位没落在换行上)= 状态未知,**不是**「什么都没有」:调用方按
// 未知处理,不能拿空账本去判「没有后台工作」。
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
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

/** CLI 对 ash 自己那条打断请求的成功回执(请求身份见 ClaudeControlBridge.request)。 */
export function isOwnInterruptAck(ev: any): boolean {
  if (ev?.type !== "control_response") return false;
  const response = ev.response ?? ev;
  const requestId = response?.request_id ?? ev.request_id;
  return response?.subtype === "success" && typeof requestId === "string" && requestId.startsWith("ash_int_");
}

/**
 * 重放之前先扫一遍:哪几条 `result` 是 ash 自己打断出来的(按事件序号),以及水位停下时是不是
 * 还有一条打断在等它的 `result`。直播里这件事由 `interruptPending` 记着 —— 发打断时置上,下一条
 * `result` 消费掉;输出里只剩回执,它和那条 `result` 谁先谁后都可能,所以两种顺序都认:回执
 * 之前紧挨着(中间没开新回合)有一条没认领的 `result` 就是它,否则就是回执之后的第一条。
 */
export function interruptedResults(events: Iterable<any>): { results: Set<number>; pending: boolean } {
  const results = new Set<number>();
  let unclaimed = -1;
  let pending = false;
  let index = 0;
  for (const ev of events) {
    if (ev?.type === "result" && !ev.parent_tool_use_id) {
      if (pending) {
        results.add(index);
        pending = false;
      } else unclaimed = index;
    } else if (isOwnInterruptAck(ev)) {
      if (unclaimed >= 0) results.add(unclaimed);
      else pending = true;
      unclaimed = -1;
    } else if (startsTurn(ev)) unclaimed = -1;
    index += 1;
  }
  return { results, pending };
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
