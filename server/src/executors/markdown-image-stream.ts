// 事件流上的「正文里提到的那张本机图片」—— **一笔账 = 一份文档**。
//
// 从 catalog/parsers.ts 拆出来:现在它不只服务 generic 那条链,三家专用适配器
// (claude-stream / codex / codex-app-server)也要从同一个出口走,所以它不能再住在
// 「目录自带的解析器」里(claude-stream 反过来被 parsers 依赖,放那儿是循环导入)。
import type { AgentEvent } from "@ash/shared";
import {
  definitionLine,
  scanMarkdownImages,
  type MarkdownDefinition,
  type MarkdownImageRef,
} from "@ash/shared/markdown-images";
import {
  captureMarkdownImages,
  discardUnclaimedImages,
  imageStore,
  persistMarkdownImageRefs,
  type ImageSnapshots,
  type ImageStore,
  type PersistedMarkdownImage,
} from "../agent-attachments.js";
import { childActivity } from "./native-agent-activity.js";

// **冻结字节**那一遍扫描的窗口。全文一直留着(见 Ledger.text),这个窗口只决定「每来一片
// 要重新解析多长一段」—— 不设上限的话一份 1 MB 的回合会被逐片重解析成 O(n²)。
const SCAN_WINDOW = 8192;
// 一个块自己就比这还大(往围栏里灌了一整份日志):这一段不再冻结字节,窗口直接跳到末尾。
// 只影响「字节拍得够不够早」,不影响「有没有这张图」—— 后者由收尾那一遍整篇扫描说了算。
const SCAN_CEILING = 1 << 20;
// 还在写的定义行(`[r]: output/sho`):它的目的地由**裸文字**收尾,一个标点都不带。
const PENDING_DEFINITION = /(?:^|\n) {0,3}\[(?:[^\]\\\n]|\\.)*\]:[^\n]*$/;
// 窗口之前那几条定义带着走,最多这么大(见 keepDefinitions)。满了只是「这处引用的字节拍
// 得晚一点」,不会让它消失。
const DEFINITION_HOLD = SCAN_WINDOW;

/**
 * 一笔账 = 屏幕上**一份独立的 Markdown 文档**。
 *
 * 主会话一份(每个回合各一份),每个子智能体抽屉里的正文各是一份 —— 后者**跨父回合累加**
 * (见 web/src/task-detail/nativeWorkModel.ts:同 id 的子活动合成同一份文档),所以父回合
 * 收尾不等于它收尾。定义、脚注都是整篇文档的,两份文档的正文一个字都不能混进同一笔账里扫。
 */
type Ledger = {
  /** 这一笔账的结果怎么回到事件流:主会话一条 attachment,子智能体裹一层 activity。 */
  wrap: (image: PersistedMarkdownImage) => AgentEvent;
  /** 按内容寻址的落盘账本 **按文档分开**:`ref` 是「这份文档里第几条结果」,配对只认它。 */
  seen: ImageStore;
  /**
   * 这份文档到此刻为止的**全文**,一个字都不裁。
   *
   * 上一版按窗口裁剪正文,于是「定义离它那处引用超过一个窗口远」时那处引用连图片节点都
   * 不是,整份文档没有持久副本(审查第 5 轮 R2A 实测:177 字的同一份内容存下 1 条,70 KB
   * 的存下 0 条)。全文留着就没有这一档 —— 收尾那一遍扫的是整篇,跟展示端扫的完全是同
   * 一段字节,结论必然一致。代价只有内存,而这段正文本来就同时躺在 trace 和 .md 里。
   */
  text: string;
  /** 冻结字节那一遍的窗口起点(`text` 里的绝对偏移)。 */
  base: number;
  /** 已经扫到的全文长度 —— 攒够一个窗口才值得再解析一遍。 */
  scanned: number;
  /** 冻结下来的字节,key = 这处引用在 `text` 里的**绝对**起点。 */
  snapshots: ImageSnapshots;
  /** 窗口之前那几条定义(恒以空行结尾),只进冻结字节那一遍的解析,见 keepDefinitions。 */
  prefix: string;
  carried: Map<string, string>;
  /** 交代到这个绝对偏移为止了:起点在它之前的引用不再发第二遍。 */
  emitted: number;
};

/** 这条事件是**某个子智能体**说的正文吗 —— 它那份抽屉正文是独立的一份文档。 */
function childText(event: AgentEvent): { id: string; text: string } | null {
  const work = event.kind === "tool" ? event.nativeWork : undefined;
  if (work?.type !== "activity" || work.event.kind !== "text" || !work.event.text) return null;
  return { id: work.id, text: work.event.text };
}

/** 这条事件宣告**某个子智能体收工了**吗 —— 那份抽屉文档到此为止,可以整份结账。 */
function childClosed(event: AgentEvent): string | null {
  const work = event.kind === "tool" ? event.nativeWork : undefined;
  if (work?.type !== "agent") return null;
  const done = work.closed === true || ["completed", "failed", "stopped"].includes(work.status);
  return done && work.id ? work.id : null;
}

/**
 * 「正文里提到的那张本机图片」的账本 —— **在协议读到那一行的那一刻**记账。
 *
 * 为什么不是一层流包装:三家专用适配器都是「readline 收到一行 → push 进 queue → 消费者
 * 自己来取」,队列是**先攒着**的。记账挂在下游取事件那一刻时,从「CLI 吐出那一行」到
 * 「我们去读那个文件」之间隔着整条队列和一次可暂停的 yield,中间 agent 完全来得及把同一个
 * 路径重拍一遍 —— 于是正文写着「修改前是红色」,存下来的却是后来那张蓝图(审查第 5 轮 R1
 * 实测:只把消费端的等待从 0 改成 240 ms,同一份正文的两处引用一起变成蓝图)。所以记账
 * 必须是 adapter 在 push 处**同步**调的一个钩子:`note()` 一返回,字节已经在 uploads 里了。
 *
 * 用法:`queue.push(...sink.note(event))` 代替 `queue.push(event)`;流收尾时 `close()`,
 * 任何退出路径上 `dispose()`。
 */
export type MarkdownImageSink = {
  /** 一条事件进账,返回**真正该入队的那几条**(原事件 + 这一刻结清的附件)。 */
  note(event: AgentEvent): AgentEvent[];
  /** 流到头了:还开着的每一份文档整份结账。 */
  close(): AgentEvent[];
  /** 拍下来、最后没人认领的拷贝删掉。任何退出路径(含异常、提前中断)都要走。 */
  dispose(): void;
};

export function markdownImageSink(cwd?: string): MarkdownImageSink {
  // 解析器自己挂上来的附件(工具结果截图):同一份拷贝不铺两张卡片。正文引用来的那些
  // **不能**按路径去重 —— 重拍过的两处引用字节可能一样,但它们是两处引用(审查第 1 轮 F1)。
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
      text: "",
      base: 0,
      scanned: 0,
      snapshots: new Map(),
      prefix: "",
      carried: new Map(),
      emitted: 0,
    };
    ledgers.set(key, ledger);
    return ledger;
  };

  /**
   * 窗口之前那几条定义留进前缀 —— 同名只留第一条(CommonMark 也取第一条)。
   *
   * 只为**冻结字节**服务:`![图][r]` 的目的地写在一个窗口之外时,少了这段前缀,这一遍扫描
   * 认不出它是图片,字节就要拖到收尾才读(读到的是后来的文件)。带的是**按解析树重写的那
   * 一行**(definitionLine),不是源码切片:引用块里写成两行的定义,切出来的第二行还带着
   * `>`,离开那个引用块之后它不再是一条定义(审查第 4 轮 R2)。
   *
   * 这段前缀装不下了只是「这处引用的字节拍得晚一点」—— 它是不是一张图由收尾那一遍整篇
   * 扫描说了算,跟这里带没带它没有关系。
   */
  const keepDefinitions = (ledger: Ledger, definitions: MarkdownDefinition[]) => {
    for (const definition of definitions) {
      if (ledger.carried.has(definition.identifier)) continue;
      const text = definitionLine(definition);
      if (ledger.prefix.length + text.length + 2 > DEFINITION_HOLD) break;
      ledger.carried.set(definition.identifier, text);
      // 整段**以空行收尾**:后面接上来的窗口从此恒是一个新块的开头,解析结果跟它单独
      // 解析时一模一样(定义本身不产生任何可见节点,也就不会多出图片引用)。
      ledger.prefix = `${[...ledger.carried.values()].join("\n")}\n\n`;
    }
  };

  /** 窗口里那一遍扫描 —— 偏移一律换算回 `text` 的绝对坐标。 */
  const scanWindow = (ledger: Ledger) => {
    const raw = scanMarkdownImages(ledger.prefix + ledger.text.slice(ledger.base));
    const shift = ledger.base - ledger.prefix.length;
    const inside = <T extends { start: number; end: number }>(items: T[]): T[] => items
      .filter((item) => item.start >= ledger.prefix.length)
      .map((item) => ({ ...item, start: item.start + shift, end: item.end + shift }));
    return {
      refs: inside(raw.refs),
      boundary: raw.boundary >= ledger.prefix.length ? raw.boundary + shift : ledger.base,
      definitions: inside(raw.definitions),
    };
  };

  /**
   * 一片正文进账:**当下就把字节拍进 uploads**,必要时把窗口往前挪。
   *
   * 这里一条事件都不发 —— 「哪几处是真图」由文档收尾那一遍整篇扫描说(半截正文的语法结论
   * 随时会被后文推翻:行内代码的一对反引号被切在两片里时,前半片里那个写法示例看着是真图)。
   * 可**字节反过来一刻都不能等**:一条消息里 agent 边说边重拍同一个路径是常事(红→蓝→红),
   * 等收尾再去读文件,三处引用会一起拿到最后那份(审查第 1 轮 F1 实测 A)。
   */
  const feed = (ledger: Ledger, text: string) => {
    ledger.text += text;
    // 这一片有可能改变「有哪几处引用、各指向哪儿」吗:`)`(行内图)、`]`(引用式图)、
    // 换行(定义收尾)是三个硬收尾,**还在写的定义行**是第四种 —— 它的目的地由裸文字收尾。
    // 漏掉第四档,`[r]: ` 和 `output/shot.svg` 分两片到达时那处引用的字节要等到下一片带标点
    // 才拍,中间工具把文件重拍一遍,红图就记成蓝图(审查第 3 轮 R1 的精确反例)。
    if (
      !/[)\]\n]/.test(text)
      && ledger.text.length - ledger.scanned < SCAN_WINDOW
      && !PENDING_DEFINITION.test(ledger.text.slice(ledger.base))
    ) return;
    ledger.scanned = ledger.text.length;
    const { refs, boundary, definitions } = scanWindow(ledger);
    for (const path of captureMarkdownImages(refs, ledger.seen, ledger.snapshots, { cwd })) captured.add(path);
    if (ledger.text.length - ledger.base <= SCAN_WINDOW) return;
    // 攒过一个窗口了:把窗口挪到「语法已经定型」那条线上 —— **挪的只是重解析的起点**,
    // 正文一个字都没少,所以后面再远的定义也还认得出前面那处引用。
    if (boundary > ledger.base) {
      keepDefinitions(ledger, definitions.filter((definition) => definition.end <= boundary));
      ledger.base = boundary;
      return;
    }
    // 一个块自己就超了天花板(往围栏里灌了一整份日志):这一段不再拍字节,免得每来一片
    // 都把这一兆重解析一遍。它们是不是图照旧由收尾那一遍说。
    if (ledger.text.length - ledger.base > SCAN_CEILING) ledger.base = ledger.text.length;
  };

  /**
   * 结账:整篇扫一遍,把**还没交代过**的那几处引用逐一落盘。
   *
   * `whole=false` 是中途的一次进账(父回合收尾时的子文档):只交代到「第一处还等着定义的
   * 引用」之前为止。那一处将来可能因为定义到了而变成一张图,**插在已经交代过的那几处中间**
   * —— 展示端按「第 n 处指向这个目的地的引用 ↔ 第 n 条报这个来源的结果」配对,中间插一处
   * 就会让后面全体错位。停在它前面就不会有这回事。
   */
  const settle = function* (ledger: Ledger, whole: boolean): Generator<AgentEvent> {
    if (!ledger.text) return;
    const scan = scanMarkdownImages(ledger.text);
    const limit = whole || scan.pending < 0 ? ledger.text.length : scan.pending;
    const refs: MarkdownImageRef[] = scan.refs.filter((ref) => ref.start >= ledger.emitted && ref.end <= limit);
    for (const image of persistMarkdownImageRefs(refs, ledger.seen, { cwd, snapshots: ledger.snapshots })) {
      if (image.path) claimed.add(image.path);
      yield ledger.wrap(image);
    }
    ledger.emitted = limit;
  };
  /**
   * 这份文档到此为止:交代完,把**文档状态**清掉。
   *
   * 账本(`seen`)**跨文档留着**:`ref` 是这处引用在这条流里的身份,展示端按「来源 + 身份」
   * 去重(直播那一路和刷新后重建的那一路会汇到一起)。每份文档从 0 重新发号,两份的身份
   * 就会撞上。字节的内容寻址表一起留着也是对的:同一份字节本来就该是同一份拷贝。
   */
  const closeLedger = function* (ledger: Ledger): Generator<AgentEvent> {
    yield* settle(ledger, true);
    ledger.text = "";
    ledger.base = 0;
    ledger.scanned = 0;
    ledger.snapshots = new Map();
    ledger.prefix = "";
    ledger.carried.clear();
    ledger.emitted = 0;
  };

  const take = (generator: Generator<AgentEvent>): AgentEvent[] => [...generator];

  return {
    note(event) {
      if (event.kind === "attachment") {
        if (event.path) {
          if (passed.has(event.path)) return [];
          passed.add(event.path);
          claimed.add(event.path);
        }
        return [event];
      }
      // 子智能体说的正文记在它自己那笔账上(抽屉里那份文档),不许跟主会话混着扫。
      const child = childText(event);
      if (child) {
        feed(ledgerFor(child.id), child.text);
        return [event];
      }
      if (event.kind === "text") {
        feed(ledgerFor(null), event.text);
        return [event];
      }
      // 某个子智能体收工了:它那份抽屉文档整份结账(父回合还会继续跑)。
      const finished = childClosed(event);
      if (finished !== null) {
        const ledger = ledgers.get(finished);
        return ledger ? [event, ...take(closeLedger(ledger))] : [event];
      }
      if (event.kind !== "done" && event.kind !== "turnEnd") return [event];
      // 回合收尾:先把图交代完,再把 `done`/`turnEnd` 放出去 —— 反过来的话结算那一侧已经
      // 把回合收了,后到的 attachment 挂不上这一回合。
      //
      // **主会话一回合一份文档,子智能体的抽屉不是**:它跨父回合累加成同一份(上一回合给
      // 定义、这一回合引用它是真实用法)。所以父回合收尾只给子文档记一次中途的账,文字和
      // 定义环境原样留着 —— 跟着父回合一起清掉的那一版,下一回合那处引用连图片节点都不是
      // (审查第 5 轮 R2C)。`done` 是整条流到头了,那时才整份结账。
      const out: AgentEvent[] = [];
      for (const [key, ledger] of ledgers) {
        if (key === "" || event.kind === "done") out.push(...take(closeLedger(ledger)));
        else out.push(...take(settle(ledger, false)));
      }
      out.push(event);
      return out;
    },
    close() {
      const out: AgentEvent[] = [];
      for (const ledger of ledgers.values()) out.push(...take(closeLedger(ledger)));
      return out;
    },
    dispose() {
      discardUnclaimedImages(captured, claimed);
    },
  };
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
 * 自己攒队列的那三家(claude-stream / codex / codex-app-server)**不走这个入口**:它们在
 * push 处直接调 `sink.note()`,再用 settleMarkdownImages 收尾(见 MarkdownImageSink 的
 * 说明 —— 队列先攒着,挂在下游就等于把字节拍晚了)。
 */
export function withMarkdownImages(
  events: AsyncIterable<AgentEvent>,
  cwd?: string,
): AsyncIterable<AgentEvent> {
  const sink = markdownImageSink(cwd);
  return settleMarkdownImages((async function* () {
    for await (const event of events) yield* sink.note(event);
  })(), sink);
}

/**
 * 已经在 push 处记过账的那条流:负责**收口** —— 正常收尾、上游抛错、提前中断三条路都得
 * 有个了结。
 *
 * 抛错那条路必须在重新抛出**之前**把图交代完:上游一抛,正常收尾的那几句全被跳过,finally
 * 里的清理把「拍下来、还没发出附件记录」的拷贝当垃圾删掉 —— 于是刚才还看得见的截图,清理
 * 原图再打开就没有了(审查第 5 轮 R3 实测:attachments = []、副本 0 个)。消费者这时还在
 * 取事件(异常是它调 next() 时才抛到它手里的),所以这几条 attachment 送得出去。
 */
export async function* settleMarkdownImages(
  events: AsyncIterable<AgentEvent>,
  sink: MarkdownImageSink,
): AsyncIterable<AgentEvent> {
  try {
    try {
      for await (const event of events) yield event;
    } catch (error) {
      for (const event of sink.close()) yield event;
      throw error;
    }
    for (const event of sink.close()) yield event;
  } finally {
    // **必须在 finally 里**:消费者提前 break(翻页、任务被停)时这一轮拍下来、没人认领的
    // 拷贝照样得清掉,否则就是一堆谁都引用不到的磁盘垃圾(审查第 3 轮 N3)。那条路上没法
    // 再 yield(调用方已经不取了),所以它只清垃圾、不补交代。
    sink.dispose();
  }
}
