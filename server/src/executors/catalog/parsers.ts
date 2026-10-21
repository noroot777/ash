import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import { parseClaudeStream } from "../claude.js";
import { markdownImageRefs, trimCarry } from "@ash/shared/markdown-images";
import { captureMarkdownImages, imageStore, persistMarkdownImageRefs, type ImageSnapshots } from "../../agent-attachments.js";
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

// 攒到这么长就裁(按块边界,见 trimCarry)—— 免得 carry 跟着整条回合无限涨。
const CARRY_MAX = 8192;

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
 * **按消息边界扫,不按碎片扫**。流式解析器一个 text 事件可能只是半句话,而半句话的语法
 * 结论随时会被后文推翻:
 *   · `![a][r]` 先到、`[r]: output/x.png` 后到 —— 按碎片扫时那处引用还没有定义,扫完又把
 *     交代过的前文裁掉,后到的定义再也修正不了它(拼回来明明有一张图,结果一条都没存);
 *   · 行内代码的一对反引号被切在两片里 —— 前半片里 `![示例](output/x.png)` 看着是真图,
 *     等后半片的反引号到了它才是代码(于是白存一份,而展示端扫完整正文不认它)。
 * 两种都是审查第 2 轮 F2 的实测用例。所以**身份**只在消息结束(`done`)那一遍扫描里认:
 * 那时候语法边界是稳定的,扫出来的节点集合跟展示端扫同一段正文的结果必然相同。
 *
 * **字节反过来,一刻都不能等**:一条消息里 agent 边说边重拍同一个路径是常事(红→蓝→红,
 * 这一层裹的是整条 run,中间真的会有工具改文件),全等到收尾再读,三处引用会一起拿到最后
 * 那份字节(审查第 1 轮 F1 实测 A)。所以每来一片就按当下的正文把**字节**先拍进 uploads
 * (captureMarkdownImages:不发事件、不占身份),收尾那一遍权威扫描再决定哪几处引用是真图、
 * 各自领走哪一份快照 —— 先拍下来,待会儿再认。
 *
 * 攒的上限是兜底而不是常态(单条消息不该有兆字节的正文):顶到上限就先扫一轮、按**块
 * 边界**裁掉已交代的部分(见 shared 的 trimCarry:围栏的开栏不会跟着被裁掉),代价是那种
 * 超长消息退回「按片扫」的老语义 —— 但不这么兜,一条失控的流能把内存吃光。
 */
export async function* withMarkdownImages(
  events: AsyncIterable<AgentEvent>,
  cwd?: string,
): AsyncIterable<AgentEvent> {
  const seen = imageStore();
  // 解析器自己挂上来的附件(工具结果截图):同一份拷贝不铺两张卡片。正文引用来的那些
  // **不能**按路径去重 —— 重拍过的两处引用字节可能一样,但它们是两处引用(F1)。
  const passed = new Set<string>();
  // 流式阶段拍下的字节。key 带一个 generation:裁剪过的 carry 里偏移会整体挪位,老快照
  // 一律作废(它指的那处引用已经交代过了)。
  const snapshots: ImageSnapshots = new Map();
  let generation = 0;
  let carry = "";

  const emit = function* (refs: ReturnType<typeof markdownImageRefs>): Generator<AgentEvent> {
    for (const image of persistMarkdownImageRefs(refs, seen, { cwd, snapshots, generation })) {
      yield { kind: "attachment", ...image };
    }
  };
  const drop = (kept: string) => {
    snapshots.clear();
    generation += 1;
    carry = kept;
  };
  const flush = function* (): Generator<AgentEvent> {
    if (!carry) return;
    yield* emit(markdownImageRefs(carry));
    drop("");
  };

  for await (const event of events) {
    if (event.kind === "attachment") {
      if (event.path) {
        if (passed.has(event.path)) continue;
        passed.add(event.path);
      }
      yield event;
      continue;
    }
    if (event.kind === "text") {
      yield event;
      carry += event.text;
      // 一处引用只可能由 `)`(行内图)、`]`(引用式图)或行尾(它的定义)收尾 —— 三个都
      // 没有的那一片不可能改变「有哪几处引用」,拿它当闸省掉逐 token 的解析。顶到上限时
      // 照扫:那一轮要把攒着的引用交代掉才能裁(见下),漏掉就等于把它们丢了。
      if (!/[)\]\n]/.test(event.text) && carry.length <= CARRY_MAX) continue;
      const refs = markdownImageRefs(carry);
      captureMarkdownImages(refs, seen, snapshots, { cwd, generation });
      // 兜底:顶到上限才按老语义交代一轮并裁剪(交代过的引用一个字都不再扫,否则同一处
      // 会发两条、身份对不上)。
      if (carry.length > CARRY_MAX) {
        yield* emit(refs);
        drop(trimCarry(carry.slice(refs.at(-1)?.end ?? 0), CARRY_MAX));
      }
      continue;
    }
    // 消息收尾:先把这条消息的图交代完,再把 `done` 放出去 —— 反过来的话结算那一侧已经
    // 把回合收了,后到的 attachment 挂不上这一回合。
    if (event.kind === "done") yield* flush();
    yield event;
  }
  yield* flush();
}
