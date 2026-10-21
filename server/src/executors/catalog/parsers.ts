import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import { parseClaudeStream } from "../claude.js";
import { lastBlockStart, markdownImageRefs, type MarkdownImageRef } from "@ash/shared/markdown-images";
import {
  captureMarkdownImages,
  discardUnclaimedImages,
  imageStore,
  persistMarkdownImageRefs,
  type ImageSnapshots,
} from "../../agent-attachments.js";
import type { CliParser, CliParserContext } from "./types.js";

// ── 目录自带的输出解析器 ────────────────────────────────────────────────────
// spec 不声明 parser 时用 textParser;声明了就用它自己那份(可内联在 spec 文件里)。

// 控制序列(颜色、光标移动)。CLI 在非 TTY 下多半不上色,但不保证 —— 留着会让
// 转写出来的 Markdown 里全是 `ESC[32m` 这种噪声。
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

/**
 * 最保守的解析:stdout 逐行当 assistant 文本,退出码非 0 就报错。
 *
 * 适用于「只会往 stdout 打人话」的 CLI —— 也就是所有还没实测出结构化输出格式的
 * CLI 的安全起点:它不猜任何事件语义,所以不会把工具调用错报成正文,代价只是
 * timeline 里看不到工具调用与思考过程。
 *
 * 有结构化输出(json / stream-json)的 CLI 请在自己的 spec 里换掉它:输出格式跟
 * claude 一致的直接用 claudeStreamJsonParser,别的照 parsers.ts 的写法内联一份。
 */
export const textParser: CliParser = (ctx) => textEvents(ctx);

async function* textEvents(ctx: CliParserContext): AsyncIterable<AgentEvent> {
  const { child, bin, lifecycle } = ctx;
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  const push = (e: AgentEvent) => {
    queue.push(e);
    resolve?.();
    resolve = null;
  };

  const trace = new RunTraceRecorder(ctx.trace);
  let stdoutLines = 0;
  let stderrTail = "";

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    trace.event(line);
    stdoutLines += 1;
    push({ kind: "text", text: stripAnsi(line) + "\n" });
    // 正文里的本机图片不在这儿收 —— 逐行看不见跨行的写法。归 withMarkdownImages,
    // 它裹在**所有**解析器外面(见 generic.ts),十个自定义解析器才不会各漏一次。
  });
  child.stderr?.on("data", (d) => {
    const chunk = d.toString();
    stderrTail = (stderrTail + chunk).slice(-8000);
    trace.stderr(chunk);
  });

  // 收尾单点:三条路(spawn 失败 / close / exit 后流不收尾)都汇到这里,保证
  // 事件流一定以 done 结束 —— 少一个 done 就是任务永远卡 running。
  const finish = (opts: { exitStatus: number; spawnError?: string; flushTimeout?: boolean }) => {
    if (finished) return;
    finished = true;
    trace.close();
    const tail = stripAnsi(stderrTail).trim();
    if (opts.spawnError) push({ kind: "error", message: opts.spawnError });
    else if (opts.flushTimeout)
      push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    else if (!lifecycle.stopRequested && opts.exitStatus !== 0)
      push({
        kind: "error",
        message: tail
          ? `${ctx.label} 以 exit ${opts.exitStatus} 结束：${tail.slice(0, 2000)}`
          : `${ctx.label} 以 exit ${opts.exitStatus} 结束,且 stderr 为空(命令行参数可能不对)`,
      });
    else if (!lifecycle.stopRequested && opts.exitStatus === 0 && stdoutLines === 0)
      push({
        kind: "error",
        message:
          `${ctx.label} 以 exit 0 结束但没有任何 stdout 输出 —— 多半是非交互参数不对` +
          `(执行参数在 server/src/executors/catalog/ 下该 CLI 的 spec 里${tail ? `;stderr:${tail.slice(0, 500)}` : ""})`,
      });
    push({ kind: "done", exitStatus: opts.exitStatus });
    resolve?.();
    resolve = null;
  };

  child.on("error", (err: NodeJS.ErrnoException) => {
    finish({ exitStatus: 1, spawnError: spawnErrorMessage(bin, err) });
  });
  child.on("close", (code, signal) => {
    finish({ exitStatus: code ?? (signal ? 1 : 0) });
  });
  forceFinishOnExit(child, () => finished, (exit) => finish({ exitStatus: exit, flushTimeout: true }));

  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) return;
    await new Promise<void>((r) => (resolve = r));
  }
}

/**
 * claude 那套 `--output-format stream-json --verbose` 的解析(文本增量 + tool_use +
 * session_id + result)。**只在该 CLI 确实输出同一套 schema 时才用** —— claude Code
 * 的 fork 常常连输出格式一起继承,那时这份能直接白嫖工具调用与流式文本;schema 不
 * 一样就会一行都解析不出来,还不如 textParser。
 */
export const claudeStreamJsonParser: CliParser = (ctx) =>
  parseClaudeStream(ctx.child, undefined, ctx.bin, undefined, null, undefined, undefined, undefined, ctx.cwd);
// parseClaudeStream 自带落图(它要分别记父会话和每个子智能体的账),别再让 generic 裹一层。
claudeStreamJsonParser.ownsMarkdownImages = true;

// 攒到这么长就把**已经定型的那几个块**交代掉并裁走(见 shared 的 lastBlockStart)。
// 不设上限的话 carry 跟着整条回合无限涨;设大了也不行 —— 每片到达都要把 carry 整份解析
// 一遍,窗口放大一倍解析代价就翻一倍。
const SCAN_WINDOW = 8192;
// 一个块自己就比这还大(往围栏里灌了一整份日志):放弃管这条消息,见 withMarkdownImages。
const SCAN_CEILING = 1 << 20;

/**
 * 给**任意**解析器的事件流补上「正文里提到的那张本机图片」。
 *
 * 事件流经过它,`![](…)` 指到的本机图片被复制进 uploads,并**逐处引用**挂一条 attachment
 * 事件(见 agent-attachments.ts 的 persistMarkdownImageRefs)。
 *
 * 为什么裹在外面而不是写进每个解析器:`spec.exec.parser ?? textParser` 是二选一,目录里
 * 十个 CLI(gemini / kimi / cursor / qwen / …)各自内联了一份解析器,只在默认那份里持久化
 * 等于十家全漏 —— 同一句话在 claude 上看得见图、换个执行器就只剩裂图标(审查第 1 轮 F3)。
 * 这一层是 run 与 attach 都必经的出口,接在这里就没有「谁家忘了接」这回事。
 * 自带持久化的解析器(claudeStreamJsonParser 套的 parseClaudeStream)由 generic 直接放行,
 * 不过这一层 —— 两层各存一份就是同一处引用两条记录、两份拷贝(见 generic.ts)。
 *
 * **身份按「语法已经定型」的边界认,绝不按碎片边界认**。流式解析器一个 text 事件可能只是
 * 半句话,而半句话的语法结论随时会被后文推翻:
 *   · `![a][r]` 先到、`[r]: output/x.png` 后到 —— 按碎片扫时那处引用还没有定义,扫完又把
 *     交代过的前文裁掉,后到的定义再也修正不了它(拼回来明明有一张图,结果一条都没存);
 *   · 行内代码的一对反引号被切在两片里 —— 前半片里 `![示例](output/x.png)` 看着是真图,
 *     等后半片的反引号到了它才是代码(于是白存一份,而展示端扫完整正文不认它)。
 * 两种都是审查第 2 轮 F2 的实测用例。所以这里只攒,到**消息结束**(`done`)才认 —— 单条
 * 消息攒得下时(绝大多数)就是「整条消息一次认」,扫出来的节点集合跟展示端扫同一段正文的
 * 结果必然相同。攒不下时(见 SCAN_WINDOW)也只在**顶层块边界**上认:未闭合的围栏、还在写
 * 的段落恒是最后一个块,裁在它前面等于「只认已经写完的那几个块」,它们的结论不会再变。
 * 代价只有一处且是「少管」而不是「管错」:定义离它那处引用超过一个窗口远时,这一侧不管
 * 那处引用,展示端照旧按完整正文解析、退一档去工作目录取(见 shared 的 lastBlockStart)。
 *
 * **字节反过来,一刻都不能等**:一条消息里 agent 边说边重拍同一个路径是常事(红→蓝→红,
 * 这一层裹的是整条 run,中间真的会有工具改文件),全等到收尾再读,三处引用会一起拿到最后
 * 那份字节(审查第 1 轮 F1 实测 A)。所以每来一片就按当下的正文把**字节**先拍进 uploads
 * (captureMarkdownImages:不发事件、不占身份),定型那一遍扫描再决定哪几处引用是真图、
 * 各自领走哪一份快照 —— 先拍下来,待会儿再认。没人领走的那几份在流收尾时删掉。
 */
export async function* withMarkdownImages(
  events: AsyncIterable<AgentEvent>,
  cwd?: string,
): AsyncIterable<AgentEvent> {
  const seen = imageStore();
  // 解析器自己挂上来的附件(工具结果截图):同一份拷贝不铺两张卡片。正文引用来的那些
  // **不能**按路径去重 —— 重拍过的两处引用字节可能一样,但它们是两处引用(F1)。
  const passed = new Set<string>();
  // 流式阶段拍下的字节。key 带一个 generation:裁走一段之后 carry 里的偏移会整体挪位,
  // 老快照一律作废(它指的那处引用已经交代过了)。
  const snapshots: ImageSnapshots = new Map();
  // 拍下来的 vs 真被某条结果领走的 —— 收尾时把没人领的删掉(见 discardUnclaimedImages)。
  const captured = new Set<string>();
  const claimed = new Set<string>();
  let generation = 0;
  let carry = "";
  let scanned = 0;
  // 这条消息已经放弃管了:一条事件都不发,正文照旧原样转发。
  let abandoned = false;

  const emit = function* (refs: MarkdownImageRef[]): Generator<AgentEvent> {
    for (const image of persistMarkdownImageRefs(refs, seen, { cwd, snapshots, generation })) {
      if (image.path) claimed.add(image.path);
      yield { kind: "attachment", ...image };
    }
  };
  const advance = (kept: string) => {
    snapshots.clear();
    generation += 1;
    carry = kept;
    scanned = kept.length;
  };
  const flush = function* (): Generator<AgentEvent> {
    const text = abandoned ? "" : carry;
    // 先交代再清账:`advance` 会把这一轮的快照作废,反过来的话这条消息的字节就全部退回
    // 「收尾时再读文件」—— 重拍过的三处引用会一起拿到最后那份(F1 实测 A)。
    if (text) yield* emit(markdownImageRefs(text));
    advance("");
    abandoned = false;
  };

  for await (const event of events) {
    if (event.kind === "attachment") {
      if (event.path) {
        if (passed.has(event.path)) continue;
        passed.add(event.path);
        claimed.add(event.path);
      }
      yield event;
      continue;
    }
    if (event.kind === "text") {
      yield event;
      if (abandoned) continue;
      carry += event.text;
      // 一处引用只可能由 `)`(行内图)、`]`(引用式图)或行尾(它的定义)收尾 —— 三个都
      // 没有的那一片不可能改变「有哪几处引用」,拿它当闸省掉逐 token 的解析。攒过窗口时
      // 照扫:那一轮要把定型的块交代掉才能裁。
      if (!/[)\]\n]/.test(event.text) && carry.length - scanned < SCAN_WINDOW) continue;
      scanned = carry.length;
      const refs = markdownImageRefs(carry);
      for (const path of captureMarkdownImages(refs, seen, snapshots, { cwd, generation })) captured.add(path);
      if (carry.length <= SCAN_WINDOW) continue;
      // 攒过窗口了:最后一个顶层块之前的语法已经定型,把那一段的引用交代掉再裁走它。
      // **裁掉的只是已经交代过的那一段**,不丢内容、也不会把块状态裁断(对比上一版的
      // 「按字符数硬裁 + 留个头」:开栏被裁掉之后围栏里的示例会被当成真图)。
      const cut = lastBlockStart(carry);
      if (cut > 0) {
        yield* emit(refs.filter((ref) => ref.end <= cut));
        advance(carry.slice(cut));
        continue;
      }
      // 裁不动(一个块自己就超了天花板,比如往围栏里灌了一整份日志):放弃管这条消息 ——
      // 一条事件都不发,于是展示端把这几处引用当成「服务端没管过」,退一档去工作目录取。
      // 宁可退一档,也不按半截正文定性:那正是 F2 那两幕的成因。
      if (carry.length > SCAN_CEILING) {
        abandoned = true;
        advance("");
      }
      continue;
    }
    // 消息收尾:先把这条消息的图交代完,再把 `done` 放出去 —— 反过来的话结算那一侧已经
    // 把回合收了,后到的 attachment 挂不上这一回合。
    if (event.kind === "done") yield* flush();
    yield event;
  }
  yield* flush();
  discardUnclaimedImages(captured, claimed);
}
