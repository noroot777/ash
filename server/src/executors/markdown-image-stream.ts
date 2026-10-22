// 事件流上的「正文里提到的那张本机图片」—— **一笔账 = 一份文档**。
//
// 从 catalog/parsers.ts 拆出来:现在它不只服务 generic 那条链,三家专用适配器
// (claude-stream / codex / codex-app-server)也要从同一个出口走,所以它不能再住在
// 「目录自带的解析器」里(claude-stream 反过来被 parsers 依赖,放那儿是循环导入)。
import type { AgentEvent } from "@ash/shared";
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
  type ImageStore,
  type PersistedMarkdownImage,
} from "../agent-attachments.js";
import { childActivity } from "./native-agent-activity.js";

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
// 带着走的**定义环境**最多这么大(见 keepDefinitions)。定义行短、条数少,一个窗口足够装下
// 现实中的全部;满了就不再收 —— 那一档退回「这一侧不管那处引用」,展示端照旧按完整正文
// 解析、退一档去工作目录取。
const DEFINITION_HOLD = SCAN_WINDOW;

/**
 * 一笔账 = 屏幕上**一份独立的 Markdown 文档**。
 *
 * 主会话正文是一份,每个子智能体抽屉里的正文各是一份(它们在同一条事件流里交错到达,
 * 但渲染时各自解析)。定义、脚注都是**整篇文档的**,所以两份文档的正文一个字都不能混进
 * 同一笔账里扫 —— 混了就会凭空多出/少掉图片节点。
 */
type Ledger = {
  /** 这一笔账的结果怎么回到事件流:主会话一条 attachment,子智能体裹一层 activity。 */
  wrap: (image: PersistedMarkdownImage) => AgentEvent;
  /** 按内容寻址的落盘账本 **按文档分开**:`ref` 是「这份文档里第几条结果」,配对只认它。 */
  seen: ImageStore;
  carry: string;
  scanned: number;
  snapshots: ImageSnapshots;
  /** 裁走的那几段里留下来的定义环境(恒以空行结尾),见 keepDefinitions。 */
  prefix: string;
  carried: Map<string, string>;
  /** 这份文档已经放弃管了:一条事件都不发,正文照旧原样转发。 */
  abandoned: boolean;
};

/** 这条事件是**某个子智能体**说的正文吗 —— 它那份抽屉正文是独立的一份文档。 */
function childText(event: AgentEvent): { id: string; text: string } | null {
  const work = event.kind === "tool" ? event.nativeWork : undefined;
  if (work?.type !== "activity" || work.event.kind !== "text" || !work.event.text) return null;
  return { id: work.id, text: work.event.text };
}

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
 *
 * **三家专用适配器也必须从这儿走**(claude-stream / codex / codex-app-server)。它们原先
 * 各自逐 text block 调 persistMarkdownImages:上一条模型消息给定义、下一条引用它时,展示端
 * 按整条正文解析得出一张图,保存端按单条消息解析压根不认 —— 那张图没有持久副本,原文件
 * 一清理就彻底没了(审查第 4 轮 R2 实测:claude 主链 attachment 为 0,同样内容交给 generic
 * 流是 1)。「模型的一条消息结束了」证明不了「这一段能独立解释 Markdown」,所以边界只能是
 * **一份文档**:主会话一笔账、每个子智能体各一笔(见 Ledger),到回合收尾(`done`/`turnEnd`)
 * 才认身份。
 *
 * **身份按「语法已经定型」的边界认,绝不按碎片边界认**。流式解析器一个 text 事件可能只是
 * 半句话,而半句话的语法结论随时会被后文推翻:
 *   · `![a][r]` 先到、`[r]: output/x.png` 后到 —— 按碎片扫时那处引用还没有定义,扫完又把
 *     交代过的前文裁掉,后到的定义再也修正不了它(拼回来明明有一张图,结果一条都没存);
 *   · 行内代码的一对反引号被切在两片里 —— 前半片里 `![示例](output/x.png)` 看着是真图,
 *     等后半片的反引号到了它才是代码(于是白存一份,而展示端扫完整正文不认它)。
 * 两种都是审查第 2 轮 F2 的实测用例。所以这里只攒,到回合收尾才认 —— 单条消息攒得下时
 * (绝大多数)就是「整份文档一次认」,扫出来的节点集合跟展示端扫同一段正文的结果必然相同。
 * 攒不下时(见 SCAN_WINDOW)也只在**顶层块边界**上认:未闭合的围栏、还在写的段落恒是最后
 * 一个块,裁在它前面等于「只认已经写完的那几个块」,它们的结论不会再变。代价只有一处且是
 * 「少管」而不是「管错」:定义离它那处引用超过一个窗口远时,这一侧不管那处引用,展示端照旧
 * 按完整正文解析、退一档去工作目录取(见 shared 的 lastBlockStart)。
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
  // 解析器自己挂上来的附件(工具结果截图):同一份拷贝不铺两张卡片。正文引用来的那些
  // **不能**按路径去重 —— 重拍过的两处引用字节可能一样,但它们是两处引用(F1)。
  const passed = new Set<string>();
  // 拍下来的 vs 真被某条结果领走的 —— 收尾时把没人领的删掉(见 discardUnclaimedImages)。
  const captured = new Set<string>();
  const claimed = new Set<string>();
  const ledgers = new Map<string, Ledger>();
  const ledgerFor = (id: string | null): Ledger => {
    const key = id ?? "";
    const existing = ledgers.get(key);
    if (existing) return existing;
    const ledger: Ledger = {
      wrap: id === null
        ? (image) => ({ kind: "attachment", ...image })
        : (image) => childActivity(id, { kind: "attachment", ...image }),
      seen: imageStore(),
      carry: "",
      scanned: 0,
      snapshots: new Map(),
      prefix: "",
      carried: new Map(),
      abandoned: false,
    };
    ledgers.set(key, ledger);
    return ledger;
  };

  const emit = function* (ledger: Ledger, refs: MarkdownImageRef[]): Generator<AgentEvent> {
    for (const image of persistMarkdownImageRefs(refs, ledger.seen, { cwd, snapshots: ledger.snapshots })) {
      if (image.path) claimed.add(image.path);
      yield ledger.wrap(image);
    }
  };
  /** carry 坐标系里的那几处引用 —— 带着定义前缀解析,再把偏移换算回来。 */
  const rebase = (ledger: Ledger, refs: MarkdownImageRef[]): MarkdownImageRef[] => refs
    .filter((ref) => ref.start >= ledger.prefix.length)
    .map((ref) => ({ ...ref, start: ref.start - ledger.prefix.length, end: ref.end - ledger.prefix.length }));
  const scan = (ledger: Ledger): MarkdownScan => {
    if (!ledger.prefix) return scanMarkdownImages(ledger.carry);
    const raw = scanMarkdownImages(ledger.prefix + ledger.carry);
    const offset = ledger.prefix.length;
    return {
      refs: rebase(ledger, raw.refs),
      boundary: Math.max(0, raw.boundary - offset),
      pending: raw.pending >= offset ? raw.pending - offset : -1,
      definitions: raw.definitions
        .filter((definition) => definition.start >= offset)
        .map((definition) => ({ ...definition, start: definition.start - offset, end: definition.end - offset })),
    };
  };
  /**
   * 要裁走的那一段里的定义留进前缀 —— 同名只留第一条(CommonMark 也取第一条)。
   *
   * 定义是**整篇文档的**,不是它所在那个块的:按块边界裁剪只保证块结构不被切断,证明不了
   * 「留下来这几个块不再依赖裁走的那几个」。`[r]: output/shot.svg` 在前、11 KB 正文之后才
   * 出现 `![图][r]` 时,定义一裁走那处引用就连图片节点都不是,这份文档从此没有持久副本
   * (审查第 3 轮 R2 实测:完整正文 1 处、服务端 0 条)。所以把定义带着走,后续每一遍都
   * 按「前缀 + carry」解析,再把坐标换算回 carry 自己那一套。
   *
   * 带的是**按解析树重写的那一行**(definitionLine),不是源码切片:引用块里写成两行的
   * 定义,切出来的第二行还带着 `>` 容器标记,离开那个引用块之后它不再是一条定义 ——
   * 携带等于没携带,后面那处引用照旧一条结果都发不出来(审查第 4 轮 R2)。
   *
   * 只带链接引用定义,**不带脚注定义**:脚注定义里可以有图,带着走就等于同一处引用被反复
   * 拍、反复交代。而它本来也不会丢 —— 它里面那几处引用就在它自己那个块里,裁走之前已经
   * 交代过了。
   */
  const keepDefinitions = (ledger: Ledger, definitions: MarkdownDefinition[]) => {
    for (const definition of definitions) {
      if (ledger.carried.has(definition.identifier)) continue;
      const text = definitionLine(definition);
      if (ledger.prefix.length + text.length + 2 > DEFINITION_HOLD) break;
      ledger.carried.set(definition.identifier, text);
      // 整段**以空行收尾**:后面接上来的 carry 从此恒是一个新块的开头,解析结果跟它单独
      // 解析时一模一样(定义本身不产生任何可见节点,也就不会多出图片引用)。
      ledger.prefix = `${[...ledger.carried.values()].join("\n")}\n\n`;
    }
  };
  /** 交代过的那一段裁走:**留下来那一段的快照必须跟着挪**(见 shiftSnapshots)。 */
  const advance = (ledger: Ledger, cut: number) => {
    ledger.snapshots = shiftSnapshots(ledger.snapshots, cut);
    ledger.carry = ledger.carry.slice(cut);
    ledger.scanned = ledger.carry.length;
  };
  /** 一片正文进账:拍字节、必要时交代并裁剪。 */
  const feed = function* (ledger: Ledger, text: string): Generator<AgentEvent> {
    if (ledger.abandoned) return;
    ledger.carry += text;
    // 这一片有可能改变「有哪几处引用、各指向哪儿」吗:`)`(行内图)、`]`(引用式图)、
    // 换行(定义收尾)是三个硬收尾,**还在写的定义行**是第四种 —— 它的目的地由裸文字
    // 收尾。漏掉第四档,`[r]: ` 和 `output/shot.svg` 分两片到达时那处引用的字节要等到
    // 下一片带标点才拍,中间工具把文件重拍一遍,红图就记成蓝图(审查第 3 轮 R1 的精确
    // 反例)。四档都不沾的片拿它当闸省掉逐 token 的解析;攒过窗口时照扫(要裁就得先扫)。
    if (
      !/[)\]\n]/.test(text)
      && ledger.carry.length - ledger.scanned < SCAN_WINDOW
      && !PENDING_DEFINITION.test(ledger.carry)
    ) return;
    ledger.scanned = ledger.carry.length;
    const { refs, boundary, pending, definitions } = scan(ledger);
    for (const path of captureMarkdownImages(refs, ledger.seen, ledger.snapshots, { cwd })) captured.add(path);
    if (ledger.carry.length <= SCAN_WINDOW) return;
    // 攒过窗口了:交代到「语法已经定型」那条线为止再把它裁走 —— **裁掉的只是交代过的
    // 那一段**,不丢内容、也不会把块状态裁断(上一版「按字符数硬裁 + 留个头」会把开栏
    // 裁掉,于是围栏里的示例被当成真图)。还等着定义的引用式图把这条线往前压:它在
    // 解析树里还只是一段普通文字,裁掉就等于定义再到也没人认领它(审查第 3 轮 R2)。
    const held = pending >= 0 && ledger.carry.length - pending <= PENDING_HOLD
      ? Math.min(boundary, pending)
      : boundary;
    if (held > 0) {
      yield* emit(ledger, refs.filter((ref) => ref.end <= held));
      // 裁走那一段里的定义**带着走** —— 后面的引用式图还要靠它才认得出来(见 prefix)。
      keepDefinitions(ledger, definitions.filter((definition) => definition.end <= held));
      advance(ledger, held);
      return;
    }
    // 裁不动(一个块自己就超了天花板,比如往围栏里灌了一整份日志):放弃管这份文档 ——
    // 一条事件都不发,于是展示端把这几处引用当成「服务端没管过」,退一档去工作目录取。
    // 宁可退一档,也不按半截正文定性:那正是 F2 那两幕的成因。
    if (ledger.carry.length > SCAN_CEILING) {
      ledger.abandoned = true;
      advance(ledger, ledger.carry.length);
    }
  };
  /**
   * 回合收尾:每一笔账各自认一遍身份,然后把**文档状态**清掉(下一回合是新的几份文档)。
   *
   * 账本(`seen`)**跨回合留着**:`ref` 是这处引用在这条流里的身份,展示端按「来源 + 身份」
   * 去重(直播那一路和刷新后重建的那一路会汇到一起)。每回合从 0 重新发号,两个回合的
   * 身份就会撞上。字节的内容寻址表一起留着也是对的:同一份字节本来就该是同一份拷贝。
   */
  const flushAll = function* (): Generator<AgentEvent> {
    for (const ledger of ledgers.values()) {
      // 先交代再清账:清空快照之后再交代,这份文档的字节就全部退回「收尾时再读文件」——
      // 重拍过的三处引用会一起拿到最后那份(F1 实测 A)。
      if (!ledger.abandoned && ledger.carry) {
        yield* emit(ledger, rebase(ledger, markdownImageRefs(ledger.prefix + ledger.carry)));
      }
      ledger.carry = "";
      ledger.scanned = 0;
      ledger.snapshots = new Map();
      ledger.prefix = "";
      ledger.carried.clear();
      ledger.abandoned = false;
    }
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
      // 子智能体说的正文记在它自己那笔账上(抽屉里那份文档),不许跟主会话混着扫。
      const child = childText(event);
      if (child) {
        yield event;
        yield* feed(ledgerFor(child.id), child.text);
        continue;
      }
      if (event.kind === "text") {
        yield event;
        yield* feed(ledgerFor(null), event.text);
        continue;
      }
      // 回合收尾:先把这几份文档的图交代完,再把 `done`/`turnEnd` 放出去 —— 反过来的话
      // 结算那一侧已经把回合收了,后到的 attachment 挂不上这一回合。
      if (event.kind === "done" || event.kind === "turnEnd") yield* flushAll();
      yield event;
    }
    yield* flushAll();
  } finally {
    // **必须在 finally 里**:消费者提前 break(翻页、任务被停)或者上游抛错时,这一轮拍下
    // 来、没人认领的拷贝照样得清掉,否则就是一堆谁都引用不到的磁盘垃圾(审查第 3 轮 N3)。
    discardUnclaimedImages(captured, claimed);
  }
}
