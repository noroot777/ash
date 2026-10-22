import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import { parseClaudeStream } from "../claude.js";
import {
  definitionLine,
  markdownImageRefs,
  scanMarkdownImages,
  type MarkdownDefinition,
  type MarkdownImageRef,
  type MarkdownScan,
} from "@ash/shared/markdown-images";
import {
  captureMarkdownImages,
  discardUnclaimedImages,
  imageStore,
  persistMarkdownImageRefs,
  shiftSnapshots,
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

// 攒到这么长就把**已经定型的那几个块**交代掉并裁走(见 shared 的 stableBlockBoundary)。
// 不设上限的话 carry 跟着整条回合无限涨;设大了也不行 —— 每片到达都要把 carry 整份解析
// 一遍,窗口放大一倍解析代价就翻一倍。
const SCAN_WINDOW = 8192;
// 一个块自己就比这还大(往围栏里灌了一整份日志):放弃管这条消息,见 withMarkdownImages。
const SCAN_CEILING = 1 << 20;
// 「还等着定义的引用式图」最多把裁点压住这么久(见 shared 的 scanMarkdownImages 的 pending):
// 定义在现实里紧跟在后面,而正文里一句孤零零的 `![foo]` 永远不会有定义 —— 不设上限的话
// 它能把整条消息钉在内存里,最后反而撞上天花板把这条消息整个放弃掉。
const PENDING_HOLD = SCAN_WINDOW * 4;
// 还在写的定义行(`[r]: output/sho`):它的目的地由**裸文字**收尾,一个标点都不带。
const PENDING_DEFINITION = /(?:^|\n) {0,3}\[(?:[^\]\\\n]|\\.)*\]:[^\n]*$/;
// 带着走的**定义环境**最多这么大(见 withMarkdownImages 的 keepDefinitions)。定义行短、
// 条数少,一个窗口足够装下现实中的全部;满了就不再收 —— 那一档退回「这一侧不管那处引用」,
// 展示端照旧按完整正文解析、退一档去工作目录取。
const DEFINITION_HOLD = SCAN_WINDOW;

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
  // 流式阶段拍下的字节,按它那处引用在 carry 里的偏移记账(裁剪后由 shiftSnapshots 挪位)。
  let snapshots: ImageSnapshots = new Map();
  // 拍下来的 vs 真被某条结果领走的 —— 收尾时把没人领的删掉(见 discardUnclaimedImages)。
  const captured = new Set<string>();
  const claimed = new Set<string>();
  let carry = "";
  let scanned = 0;
  /**
   * 裁走的那几段里留下来的**链接引用定义**,拼成一段不可见的解析前缀(恒以空行结尾)。
   *
   * 定义是**整篇文档的**,不是它所在那个块的:按块边界裁剪只保证块结构不被切断,证明不了
   * 「留下来这几个块不再依赖裁走的那几个」。`[r]: output/shot.svg` 在前、11 KB 正文之后才
   * 出现 `![图][r]` 时,定义一裁走那处引用就连图片节点都不是,这条消息从此没有持久副本
   * (审查第 3 轮 R2 实测:完整正文 1 处、服务端 0 条)。所以把定义带着走,后续每一遍都
   * 按「前缀 + carry」解析,再把坐标换算回 carry 自己那一套。
   *
   * 只带链接引用定义,**不带脚注定义**:脚注定义里可以有图,带着走就等于同一处引用被反复
   * 拍、反复交代。而它本来也不会丢 —— 它里面那几处引用就在它自己那个块里,裁走之前已经
   * 交代过了。
   */
  let prefix = "";
  const carried = new Map<string, string>();
  // 这条消息已经放弃管了:一条事件都不发,正文照旧原样转发。
  let abandoned = false;

  const emit = function* (refs: MarkdownImageRef[]): Generator<AgentEvent> {
    for (const image of persistMarkdownImageRefs(refs, seen, { cwd, snapshots })) {
      if (image.path) claimed.add(image.path);
      yield { kind: "attachment", ...image };
    }
  };
  /** carry 坐标系里的那几处引用 —— 带着定义前缀解析,再把偏移换算回来。 */
  const rebase = (refs: MarkdownImageRef[]): MarkdownImageRef[] => refs
    .filter((ref) => ref.start >= prefix.length)
    .map((ref) => ({ ...ref, start: ref.start - prefix.length, end: ref.end - prefix.length }));
  const scan = (): MarkdownScan => {
    if (!prefix) return scanMarkdownImages(carry);
    const raw = scanMarkdownImages(prefix + carry);
    return {
      refs: rebase(raw.refs),
      boundary: Math.max(0, raw.boundary - prefix.length),
      pending: raw.pending >= prefix.length ? raw.pending - prefix.length : -1,
      definitions: raw.definitions
        .filter((definition) => definition.start >= prefix.length)
        .map((definition) => ({
          ...definition,
          start: definition.start - prefix.length,
          end: definition.end - prefix.length,
        })),
    };
  };
  /**
   * 要裁走的那一段里的定义留进前缀 —— 同名只留第一条(CommonMark 也取第一条)。
   *
   * 带的是**按解析树重写的那一行**(definitionLine),不是源码切片:引用块里写成两行的
   * 定义,切出来的第二行还带着 `>` 容器标记,离开那个引用块之后它不再是一条定义 ——
   * 携带等于没携带,后面那处引用照旧一条结果都发不出来(审查第 4 轮 R2)。
   */
  const keepDefinitions = (definitions: MarkdownDefinition[]) => {
    for (const definition of definitions) {
      if (carried.has(definition.identifier)) continue;
      const text = definitionLine(definition);
      if (prefix.length + text.length + 2 > DEFINITION_HOLD) break;
      carried.set(definition.identifier, text);
      // 整段**以空行收尾**:后面接上来的 carry 从此恒是一个新块的开头,解析结果跟它单独
      // 解析时一模一样(定义本身不产生任何可见节点,也就不会多出图片引用)。
      prefix = `${[...carried.values()].join("\n")}\n\n`;
    }
  };
  /** 交代过的那一段裁走:**留下来那一段的快照必须跟着挪**(见 shiftSnapshots)。 */
  const advance = (cut: number) => {
    snapshots = shiftSnapshots(snapshots, cut);
    carry = carry.slice(cut);
    scanned = carry.length;
  };
  const flush = function* (): Generator<AgentEvent> {
    // 先交代再清账:清空快照之后再交代,这条消息的字节就全部退回「收尾时再读文件」——
    // 重拍过的三处引用会一起拿到最后那份(F1 实测 A)。
    if (!abandoned && carry) yield* emit(rebase(markdownImageRefs(prefix + carry)));
    snapshots = new Map();
    carry = "";
    scanned = 0;
    prefix = "";
    carried.clear();
    abandoned = false;
  };

  try {
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
        // 这一片有可能改变「有哪几处引用、各指向哪儿」吗:`)`(行内图)、`]`(引用式图)、
        // 换行(定义收尾)是三个硬收尾,**还在写的定义行**是第四种 —— 它的目的地由裸文字
        // 收尾。漏掉第四档,`[r]: ` 和 `output/shot.svg` 分两片到达时那处引用的字节要等到
        // 下一片带标点才拍,中间工具把文件重拍一遍,红图就记成蓝图(审查第 3 轮 R1 的精确
        // 反例)。四档都不沾的片拿它当闸省掉逐 token 的解析;攒过窗口时照扫(要裁就得先扫)。
        if (
          !/[)\]\n]/.test(event.text)
          && carry.length - scanned < SCAN_WINDOW
          && !PENDING_DEFINITION.test(carry)
        ) continue;
        scanned = carry.length;
        const { refs, boundary, pending, definitions } = scan();
        for (const path of captureMarkdownImages(refs, seen, snapshots, { cwd })) captured.add(path);
        if (carry.length <= SCAN_WINDOW) continue;
        // 攒过窗口了:交代到「语法已经定型」那条线为止再把它裁走 —— **裁掉的只是交代过的
        // 那一段**,不丢内容、也不会把块状态裁断(上一版「按字符数硬裁 + 留个头」会把开栏
        // 裁掉,于是围栏里的示例被当成真图)。还等着定义的引用式图把这条线往前压:它在
        // 解析树里还只是一段普通文字,裁掉就等于定义再到也没人认领它(审查第 3 轮 R2)。
        const held = pending >= 0 && carry.length - pending <= PENDING_HOLD
          ? Math.min(boundary, pending)
          : boundary;
        if (held > 0) {
          yield* emit(refs.filter((ref) => ref.end <= held));
          // 裁走那一段里的定义**带着走** —— 后面的引用式图还要靠它才认得出来(见 prefix)。
          keepDefinitions(definitions.filter((definition) => definition.end <= held));
          advance(held);
          continue;
        }
        // 裁不动(一个块自己就超了天花板,比如往围栏里灌了一整份日志):放弃管这条消息 ——
        // 一条事件都不发,于是展示端把这几处引用当成「服务端没管过」,退一档去工作目录取。
        // 宁可退一档,也不按半截正文定性:那正是 F2 那两幕的成因。
        if (carry.length > SCAN_CEILING) {
          abandoned = true;
          advance(carry.length);
        }
        continue;
      }
      // 消息收尾:先把这条消息的图交代完,再把 `done` 放出去 —— 反过来的话结算那一侧已经
      // 把回合收了,后到的 attachment 挂不上这一回合。
      if (event.kind === "done") yield* flush();
      yield event;
    }
    yield* flush();
  } finally {
    // **必须在 finally 里**:消费者提前 break(翻页、任务被停)或者上游抛错时,这一轮拍下
    // 来、没人认领的拷贝照样得清掉,否则就是一堆谁都引用不到的磁盘垃圾(审查第 3 轮 N3)。
    discardUnclaimedImages(captured, claimed);
  }
}
