// 读盘层：**按字节**把一条会话的 stdout 文件读成一行一行，不认人、不配对。
//
// 为什么单独一个文件：扫描层（`claude-monitor-scan.ts`）原本把两件事揣在一起——「从第几字节
// 接着读、残尾怎么办、一条记录比窗口还长怎么办」和「读出来的行是不是 Monitor、跟谁配对」。
// 前者只跟字节和文件系统打交道，后者只跟来源语义打交道，拆开之后各自都读得完整（第 12 轮
// 审查 F2：那个文件涨到了 705 行，超过单文件 700 行的约定）。
//
// 这一层的全部承诺只有两条：
//
// ① **交出去的都是完整行**，游标只停在行边界上（见 `eachLine`）。
// ② **位置单调往前**，除了「文件比上次短了」那种重写（由调用方判，见 `scanSession`）。
import { open as openFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 单次调用的读取上限。超了这一轮就停在这儿，游标记着，下次接着读。
 *
 * `ASH_MONITOR_SCAN_MAX_BYTES` 只给回归用：128 MiB 的夹具没法写进测试里，而「多轮才读完
 * 一个固定输入、最终要收敛」恰恰是这条路最该钉住的性质（第 8 轮审查实测的不收敛就发生在
 * 截限 + 缓冲满这个组合上）。不设就是 128 MiB。
 */
export const MAX_SCAN_BYTES = (() => {
  const raw = Number(process.env.ASH_MONITOR_SCAN_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 128 * 1024 * 1024;
})();
/** 单次 read 的缓冲大小。 */
const CHUNK = 1 << 20;

/**
 * 一条会话**全部**的 stdout 文件，按时间排好。
 *
 * `sessions.agent_out_path` 只记着最后一次 run 的那一个（每回合覆盖），而内置 Monitor 多半
 * 起在中间某一轮 —— 实测用户那个任务字段指向第 6 个文件，12 个 Monitor 全在前 5 个里。
 * 落盘约定是 `<sessionId>-<时间戳>.agent-out.jsonl`（executors/detached.ts 的 `runPaths`），
 * 所以**拿 `sessions.id` 当前缀**，不从文件名去猜（会话 id 是可含 `-` 的 nanoid）。
 */
export async function streamFilesOf(
  sessionId: string, outPath: string,
): Promise<{ path: string; startedAt: string | null }[]> {
  const dir = dirname(outPath);
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return [{ path: outPath, startedAt: null }]; }
  const files = entries
    .filter((f) => f.startsWith(`${sessionId}-`) && f.endsWith(".agent-out.jsonl"))
    .sort()
    .map((f) => ({ path: join(dir, f), startedAt: timestampOf(f) }));
  return files.length ? files : [{ path: outPath, startedAt: null }];
}

/** 从 `<id>-20261014T063919165Z.agent-out.jsonl` 里把那个时间戳还原成 ISO。认不出就 null。 */
export function timestampOf(fileName: string): string | null {
  const m = /-(\d{8})T(\d{6})(\d{3})Z\./.exec(fileName);
  if (!m) return null;
  const [, date, time, ms] = m;
  const iso = `${date!.slice(0, 4)}-${date!.slice(4, 6)}-${date!.slice(6, 8)}T`
    + `${time!.slice(0, 2)}:${time!.slice(2, 4)}:${time!.slice(4, 6)}.${ms}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * 从 `start` 读到文件尾（或读满 `maxBytes`），逐行回调，返回新游标。
 *
 * **游标只停在完整行的边界上。** 按字节续读时，上一轮很可能正好停在某一行中间（文件还在被
 * 追加）。从半行开始解析会把那条事件整条丢掉，所以残留的不完整尾巴不消费，下次从它的起点
 * 重读。
 */
export type EachLineResult = {
  nextOffset: number;
  /** 读满了单次窗口（或跳过了一条装不下的记录），这个文件还没读完。 */
  truncated: boolean;
  /** 调用方说「这一行我没消费」，游标停在它前面。 */
  stopped: boolean;
  /** 跳过的那条超长记录有多少字节（0 = 没跳过）。 */
  skipped: number;
  /** 文件尾部**没有换行符**的那截有多少字节（0 = 正好停在行边界上）。 */
  tail: number;
};

export async function eachLine(
  path: string, start: number, maxBytes: number,
  /** 返回 false = **这一行没消费掉**，就停在它前面（游标不越过它）。 */
  onLine: (line: string) => boolean,
): Promise<EachLineResult> {
  const fh = await openFile(path, "r");
  try {
    let offset = start;
    let carry = Buffer.alloc(0);
    /** 循环是**读到文件尾**出来的,还是读满窗口出来的。残尾的含义全看这个。 */
    let atEof = false;
    while (offset - start < maxBytes) {
      const want = Math.min(CHUNK, maxBytes - (offset - start));
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      if (!bytesRead) { atEof = true; break; }
      // data[0] 在文件里的绝对位置：carry 来自上一轮、在 offset 之前。
      const base = offset - carry.length;
      const data = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, from);
        if (nl < 0) break;
        const lineStart = from;
        const keepGoing = onLine(data.subarray(from, nl).toString("utf8"));
        // **消费不了就把游标停在这一行之前**，下一轮从它重新开始。越过去就等于丢掉一条
        // 来源不会重发的事实（见 `LATE_CAP` 的背压说明）。
        if (!keepGoing) {
          return { nextOffset: base + lineStart, truncated: false, stopped: true, skipped: 0, tail: 0 };
        }
        from = nl + 1;
      }
      carry = Buffer.from(data.subarray(from)); // 复制：data 可能指向复用的 buf
      offset += bytesRead;
    }
    // ── 一条比窗口还长的记录：**跳过它**，别让位置零进展 ────────────────────────
    //
    // 窗口内一个换行都没有 ⇒ 这一轮 `nextOffset` 等于起点，下一轮同样的输入同样读不出换行，
    // 于是这个文件之后的内容（以及后面所有 run 文件，见 `blocked`）永远读不到。而那条记录
    // 本身在这个窗口下**无论如何都解析不了**（要整条缓冲起来才行），所以跳过它是唯一能往前
    // 的选择：丢一条事件，换这个文件剩下的部分都能读到。
    //
    // 只在「确实找到了它的结尾」时才跳。读到文件尾还没有换行是另一回事：那多半是**正在被
    // 追加的半行**，跳过去就等于把它写完之后的内容一起丢掉 —— 那时照旧停在原地（账上仍记
    // 着「没读完」，见 scanSession）。
    if (offset - carry.length <= start && offset - start >= maxBytes) {
      const end = await nextNewline(fh, offset, maxBytes * NEWLINE_BUDGET);
      if (end !== null) {
        return { nextOffset: end, truncated: true, stopped: false, skipped: end - start, tail: 0 };
      }
    }
    return {
      nextOffset: offset - carry.length,
      truncated: offset - start >= maxBytes,
      stopped: false,
      skipped: 0,
      // **只有读到文件尾出来的残尾才叫残尾。** 读满窗口时手里剩的那截只是「还没读」,下一轮
      // 从它接着读;而文件尾的那截没有换行符,要么正在被写,要么这个文件就这样结束了。
      tail: atEof ? carry.length : 0,
    };
  } finally {
    await fh.close();
  }
}

/**
 * 从 `from` 往后找下一个换行，返回它**之后**那一字节的位置；找不到（或超出预算）就 null。
 *
 * 只给「一条记录比窗口还长」那一支用（见 `eachLine`）：只扫不缓冲，所以多长的记录都不会把
 * 内存顶起来。
 *
 * **预算是干活量的闸**：没有它时,一条很长且**还没写完**的尾行会让每一次请求都把文件从这里
 * 一路扫到尾（而且扫完还是 null,零进展）—— 文件多大就白读多少,每轮一次（第 13 轮审查 N3）。
 * 预算按读取窗口的倍数给：窗口装不下的记录已经是异常形状,给它窗口的 4 倍去找结尾足够宽,
 * 超了就当这一轮没找到——账上照旧记着「没读完」,下一轮再说。
 */
const NEWLINE_BUDGET = 4;
async function nextNewline(
  fh: Awaited<ReturnType<typeof openFile>>, from: number, budget: number,
): Promise<number | null> {
  let offset = from;
  const buf = Buffer.allocUnsafe(CHUNK);
  while (offset - from < budget) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, budget - (offset - from)), offset);
    if (!bytesRead) return null;
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (nl >= 0) return offset + nl + 1;
    offset += bytesRead;
  }
  return null;
}
