// 事件流上的「正文里提到的那张本机图片」—— **一笔账 = 一份文档**。
//
// 从 catalog/parsers.ts 拆出来:现在它不只服务 generic 那条链,三家专用适配器
// (claude-stream / codex / codex-app-server)也要从同一个出口走,所以它不能再住在
// 「目录自带的解析器」里(claude-stream 反过来被 parsers 依赖,放那儿是循环导入)。
import type { AgentEvent } from "@ash/shared";
import { scanMarkdownImages } from "@ash/shared/markdown-images";
import {
  captureMarkdownImages,
  discardUnclaimedImages,
  imageStore,
  persistMarkdownImageRefs,
  type ImageRefSpot,
  type ImageSnapshots,
  type ImageStore,
  type PersistedMarkdownImage,
} from "../agent-attachments.js";
import { childActivity } from "./native-agent-activity.js";

// **冻结字节**那一遍扫描的窗口。全文一直留着(见 Ledger.text),这个窗口只决定「每来一片
// 要重新解析多长一段」—— 不设上限的话一份 1 MB 的回合会被逐片重解析成 O(n²)。
const SCAN_WINDOW = 8192;
// 一个块自己就比窗口长(往围栏里灌了一整份日志)时,重解析按**比例**放慢:这一窗每长
// 1/8 才再解析一遍。于是总解析量恒 ≈ 8 倍正文长度(线性),而不是逐片重扫那一兆。
//
// 上一版在这里设了个 1 MB 的天花板,过线就把窗口**跳到末尾**:那一段里的引用从此拍不到
// 字节,全部退回收尾那一遍去读文件 —— 读到的是后来的文件(审查第 6 轮 R2 的同类范围)。
// 按比例放慢既不放弃任何一段,也不会 O(n²);代价只是那种畸形大块里的字节最多晚 1/8 块。
const SCAN_SLACK = 8;
// 还在写的定义行(`[r]: output/sho`):它的目的地由**裸文字**收尾,一个标点都不带。
const PENDING_DEFINITION = /(?:^|\n) {0,3}\[(?:[^\]\\\n]|\\.)*\]:[^\n]*$/;

/** 一处引用的「目的地 + 它在全文里占的那一段」—— 落盘和交代都只要这三个数。 */
type ImageSlot = ImageRefSpot & { end: number };

/**
 * 一笔账 = 屏幕上**一份独立的 Markdown 文档**。
 *
 * 主会话一份(每个回合各一份),每个子智能体抽屉里的正文各是一份 —— 后者**跨父回合累加**
 * (见 web/src/task-detail/nativeWorkModel.ts:同 id 的子活动合成同一份文档),所以父回合
 * 收尾不等于它收尾,它自己说「收工了」也不等于(同 id 的子智能体会被唤醒接着说)。定义、
 * 脚注都是整篇文档的,两份文档的正文一个字都不能混进同一笔账里扫。
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
   * 的存下 0 条)。全文留着就没有这一档 —— 权威那一遍扫的是整篇,跟展示端扫的完全是同
   * 一段字节,结论必然一致。代价只有内存,而这段正文本来就同时躺在 trace 和 .md 里。
   */
  text: string;
  /** 冻结字节那一遍的窗口起点(`text` 里的绝对偏移)。 */
  base: number;
  /** 已经扫到的全文长度 —— 攒够一个窗口才值得再解析一遍。 */
  scanned: number;
  /** 语法已经定型到这个偏移为止(见 shared 的 stableBlockBoundary),只增不减。 */
  settled: number;
  /** 冻结下来的字节,key = 这处引用在 `text` 里的**绝对**起点。 */
  snapshots: ImageSnapshots;
  /**
   * 这份文档的**整篇定义表**:identifier → 目的地,同名取第一条(CommonMark 口径)。
   *
   * 没有预算,也不重写成源码带着走。上一版把窗口之外那几条定义重写成一行 `[r]: <path>`
   * 跟在窗口前面,于是必须猜一个预算:600 条定义就溢出,后面的引用照旧拍不到字节
   * (审查第 6 轮 R2 第 2 行);标识符的转义也在重写里栽过(第 5 轮 R2B)。一张表没有这
   * 两档 —— 它只装语义,而语义恰好是定义唯一有用的东西。
   */
  definitions: Map<string, string>;
  /** 还等着定义的那几处引用(绝对起点 → 归一标识符 + 这一段的终点),见 resolveWaiting。 */
  waiting: Map<number, { identifier: string; end: number }>;
  /** 已经不再等待的起点:定义到了、字节也冻结过,别让后面的扫描把它重新排回队。 */
  decided: Set<number>;
  /** 交代到这个绝对偏移为止了:起点在它之前的引用不再发第二遍。 */
  emitted: number;
  /** 有「语法已定型、还没交代过」的引用在等着 —— 下一条事件进流时就把它交代出去。 */
  due: boolean;
};

/** 这条事件是**某个子智能体**说的正文吗 —— 它那份抽屉正文是独立的一份文档。 */
function childText(event: AgentEvent): { id: string; text: string } | null {
  const work = event.kind === "tool" ? event.nativeWork : undefined;
  if (work?.type !== "activity" || work.event.kind !== "text" || !work.event.text) return null;
  return { id: work.id, text: work.event.text };
}

/** 这条事件宣告**某个子智能体收工了**吗 —— 那份抽屉文档记一次中途的账。 */
function childClosed(event: AgentEvent): string | null {
  const work = event.kind === "tool" ? event.nativeWork : undefined;
  if (work?.type !== "agent") return null;
  const done = work.closed === true || ["completed", "failed", "stopped"].includes(work.status);
  return done && work.id ? work.id : null;
}

/**
 * 「正文里提到的那张本机图片」的账本 —— **在协议读到那一行的那一刻**记账。
 *
 * 为什么是两个方法而不是一个:从「CLI 吐出那一行」到「这条事件真的进了事件流」之间隔着
 * 好几级缓冲 —— token 级增量要攒成小块(claude 的 textBuf、codex 的 deltaBuffer)、子智能体
 * 的活动要按 40 字/换行合并(NativeActivityBuffer)、事件还要排在一条消费者自己来取的
 * queue 上。字节必须在**最前面**那一刻就冻住(中间 agent 完全来得及把同一个路径重拍一
 * 遍:审查第 5 轮 R1、第 6 轮 R1),而「交代哪几处是真图」只能排在后面(半截正文的语法
 * 结论随时会被后文推翻)。所以:
 *   · `capture(event)` —— 协议读到的原始正文,**同步**进账本、该拍的字节当场拍下来;
 *   · `release(event)` —— 这条事件真的进流了,返回该入队的那几条(结清的附件 + 原事件)。
 *
 * 两者**不许合成一个**,也不许只调一个:只调 capture 这条流一张图都不会交代出去,只调
 * release 则字节又拍晚了。唯一的调用点是 event-queue.ts 的 EventQueue —— 整条流水线
 * (捕获 → 增量合并 → 活动合并 → 交代 → 入队)在那里只写一次,十一个解析器和三家专用
 * 适配器都从它走,于是没有「谁家忘了接钩子」这回事。
 */
export type MarkdownImageSink = {
  /** 协议读到这段正文的那一刻:进账本、冻结字节。不产生任何事件。 */
  capture(event: AgentEvent): void;
  /** 这条事件进流了:返回**真正该入队的那几条**(这一刻结清的附件 + 原事件)。 */
  release(event: AgentEvent): AgentEvent[];
  /**
   * 这条事件已经从 `release` 出去过了吗 —— 收口那一层据此认出「没记过账的事件」。
   *
   * 为什么还要留这条后路:解析器**可以**不用 EventQueue,自己 `yield` 事件(测试夹具、
   * 以后新写的某份解析器)。那种事件一条账都没记过,到了收口那一层必须补记一次,否则
   * 它那条链一张图都不会落盘 —— 「谁家忘了接」这回事只能由系统兜,不能由自觉兜。补记
   * 的代价只是字节拍得晚一点(这一刻才去读文件),「这张图存不存在」照旧成立。
   */
  noted(event: AgentEvent): boolean;
  /** 流到头了:还开着的每一份文档整份结账。 */
  close(): AgentEvent[];
  /** 拍下来、最后没人认领、而且语法也没认下它的拷贝删掉。任何退出路径都要走。 */
  dispose(): void;
};

export function markdownImageSink(cwd?: string): MarkdownImageSink {
  // 解析器自己挂上来的附件(工具结果截图):同一份拷贝不铺两张卡片。正文引用来的那些
  // **不能**按路径去重 —— 重拍过的两处引用字节可能一样,但它们是两处引用(审查第 1 轮 F1)。
  const passed = new Set<string>();
  // 拍下来的 vs 真被某条结果领走的 vs 语法已经认下它的 —— 三者的分别见 dispose。
  const captured = new Set<string>();
  const claimed = new Set<string>();
  const exposed = new Set<string>();
  /** 从 release 出去过的事件(含它自己造的 attachment),见 MarkdownImageSink.noted。 */
  const released = new WeakSet<object>();
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
      settled: 0,
      snapshots: new Map(),
      definitions: new Map(),
      waiting: new Map(),
      decided: new Set(),
      emitted: 0,
      due: false,
    };
    ledgers.set(key, ledger);
    return ledger;
  };

  /** 窗口里那一遍扫描 —— 偏移一律换算回 `text` 的绝对坐标。 */
  const scanWindow = (ledger: Ledger) => {
    const raw = scanMarkdownImages(ledger.text.slice(ledger.base));
    const shift = ledger.base;
    const move = <T extends { start: number; end: number }>(items: readonly T[]): T[] =>
      items.map((item) => ({ ...item, start: item.start + shift, end: item.end + shift }));
    return {
      refs: move(raw.refs),
      waiting: move(raw.waiting),
      definitions: move(raw.definitions),
      boundary: raw.boundary + shift,
    };
  };

  /** 把这几处的字节拍进 uploads,并记下「语法已经认下它」的那几份(见 dispose)。 */
  const freeze = (ledger: Ledger, slots: readonly ImageSlot[]) => {
    for (const path of captureMarkdownImages(slots, ledger.seen, ledger.snapshots, { cwd })) captured.add(path);
    for (const slot of slots) {
      if (slot.end > ledger.settled) continue;
      const path = ledger.snapshots.get(slot.start)?.path;
      if (path) exposed.add(path);
    }
  };

  /**
   * 刚收下的定义解开了哪几处等待 —— **解开那一刻就冻结字节**。
   *
   * 这是「语义一旦可解释,立刻冻结对应字节」的那一半。定义离它那处引用有多远没有上限:
   * 引用在最前面、定义在 12 KB 之后时,窗口早就挪过去了,上一版只能等收尾那一遍整篇扫描
   * 才认出这是一张图 —— 那时去读文件,读到的是中间被重拍过的新图(审查第 6 轮 R2 第 1 行
   * 实测:应 RED/BLUE,实际 BLUE/BLUE)。记下「谁在等哪个标识符」之后就不必再把那处引用
   * 留在窗口里:定义一到,按表查一次就知道是哪几处、各指向哪儿。
   */
  const resolveWaiting = (ledger: Ledger): ImageSlot[] => {
    const found: ImageSlot[] = [];
    for (const [start, entry] of [...ledger.waiting]) {
      const destination = ledger.definitions.get(entry.identifier);
      if (destination === undefined) continue;
      ledger.waiting.delete(start);
      ledger.decided.add(start);
      found.push({ destination, start, end: entry.end });
    }
    freeze(ledger, found);
    return found;
  };

  /**
   * 一片正文进账:**当下就把字节拍进 uploads**,必要时把窗口往前挪。
   *
   * 这里一条事件都不发 —— 「哪几处是真图」由权威那一遍整篇扫描说(半截正文的语法结论
   * 随时会被后文推翻:行内代码的一对反引号被切在两片里时,前半片里那个写法示例看着是真
   * 图)。可**字节反过来一刻都不能等**:一条消息里 agent 边说边重拍同一个路径是常事
   * (红→蓝→红),等收尾再去读文件,三处引用会一起拿到最后那份(审查第 1 轮 F1 实测 A)。
   */
  const feed = (ledger: Ledger, text: string) => {
    ledger.text += text;
    const window = ledger.text.length - ledger.base;
    const fresh = ledger.text.length - ledger.scanned;
    // 这一窗已经畸形地大了(一个块自己就比窗口长):按比例放慢,见 SCAN_SLACK。
    if (window > SCAN_WINDOW && fresh * SCAN_SLACK < window) return;
    // 这一片有可能改变「有哪几处引用、各指向哪儿」吗:`)`(行内图)、`]`(引用式图)、
    // 换行(定义收尾)是三个硬收尾,**还在写的定义行**是第四种 —— 它的目的地由裸文字收尾。
    // 漏掉第四档,`[r]: ` 和 `output/shot.svg` 分两片到达时那处引用的字节要等到下一片带标点
    // 才拍,中间工具把文件重拍一遍,红图就记成蓝图(审查第 3 轮 R1 的精确反例)。
    if (
      !/[)\]\n]/.test(text)
      && fresh < SCAN_WINDOW
      && !PENDING_DEFINITION.test(ledger.text.slice(ledger.base))
    ) return;
    ledger.scanned = ledger.text.length;
    const scan = scanWindow(ledger);
    ledger.settled = Math.max(ledger.settled, scan.boundary);
    // 定义表是整篇文档的,同名取第一条 —— 收下它才能解开窗口之外那几处等待。
    for (const definition of scan.definitions) {
      if (!ledger.definitions.has(definition.identifier)) {
        ledger.definitions.set(definition.identifier, definition.destination);
      }
    }
    // 这一窗认出来的引用:引用式那几处的目的地按**整篇**定义表纠正 —— 窗口里恰好另有一条
    // 同名定义时,这一窗会按那条解,而 CommonMark 取全篇第一条。
    const refs: ImageSlot[] = scan.refs.map((ref) => ({
      destination: (ref.identifier !== undefined ? ledger.definitions.get(ref.identifier) : undefined) ?? ref.destination,
      start: ref.start,
      end: ref.end,
    }));
    freeze(ledger, refs);
    // 定义已经到了的,从等待队列里摘掉:它现在是货真价实的图片节点。
    for (const ref of refs) ledger.waiting.delete(ref.start);
    for (const candidate of scan.waiting) {
      if (ledger.decided.has(candidate.start) || candidate.start < ledger.emitted) continue;
      ledger.waiting.set(candidate.start, { identifier: candidate.identifier, end: candidate.end });
    }
    const resolved = resolveWaiting(ledger);
    // 有「语法已定型、还没交代过」的引用了吗 —— 有才值得去跑权威那一遍整篇扫描。整篇扫描
    // 是 O(全文):按段落跑等于 O(n²),按**图片**跑才是对的(一份文档里的图是个小数)。
    const pendingShown = (slot: ImageSlot) => slot.end <= ledger.settled && slot.start >= ledger.emitted;
    if (refs.some(pendingShown) || resolved.some(pendingShown)) ledger.due = true;
    if (window <= SCAN_WINDOW) return;
    // 攒过一个窗口了:把窗口挪到「语法已经定型」那条线上 —— **挪的只是重解析的起点**,
    // 正文一个字都没少,定义表和等待队列也都原样留着,所以再远的定义也还认得出前面那处引用。
    if (scan.boundary > ledger.base) ledger.base = scan.boundary;
  };

  /**
   * 交代:**整篇扫一遍**(权威结论),把还没交代过的那几处引用逐一落盘。
   *
   * 终点分三档,因为「这一刻能交代到哪儿」有三种答案:
   *   · `settled` —— 流中途。只到语法定型线为止:后面那半句的结论随时会被下一片推翻。
   *   · `checkpoint` —— 这份文档告一段落(父回合收尾、子智能体说收工)。定型线之后那个
   *     还在写的块也一起交代掉 —— 它多半就是最后一句话,等下去只会让图迟迟不出现。
   *   · `whole` —— 这份文档彻底到头了,整篇交代。
   *
   * 三档都不许越过「第一处还等着定义的引用」:那一处将来可能因为定义到了而变成一张图,
   * **插在已经交代过的那几处中间** —— 展示端按「第 n 处指向这个目的地的引用 ↔ 第 n 条报
   * 这个来源的结果」配对,中间插一处就会让后面全体错位。停在它前面就不会有这回事。
   */
  const settle = function* (ledger: Ledger, upTo: "settled" | "checkpoint" | "whole"): Generator<AgentEvent> {
    ledger.due = false;
    if (!ledger.text) return;
    const scan = scanMarkdownImages(ledger.text);
    const blocked = upTo !== "whole" && scan.pending >= 0 ? scan.pending : ledger.text.length;
    const stop = Math.min(blocked, upTo === "settled" ? scan.boundary : ledger.text.length);
    if (stop <= ledger.emitted) return;
    const refs = scan.refs.filter((ref) => ref.start >= ledger.emitted && ref.end <= stop);
    for (const image of persistMarkdownImageRefs(refs, ledger.seen, { cwd, snapshots: ledger.snapshots })) {
      if (image.path) claimed.add(image.path);
      yield ledger.wrap(image);
    }
    ledger.emitted = stop;
  };

  /**
   * 这份文档到此为止:交代完,把**文档状态**清掉。
   *
   * 账本(`seen`)**跨文档留着**:`ref` 是这处引用在这条流里的身份,展示端按「来源 + 身份」
   * 去重(直播那一路和刷新后重建的那一路会汇到一起)。每份文档从 0 重新发号,两份的身份
   * 就会撞上。字节的内容寻址表一起留着也是对的:同一份字节本来就该是同一份拷贝。
   */
  const closeLedger = function* (ledger: Ledger): Generator<AgentEvent> {
    yield* settle(ledger, "whole");
    ledger.text = "";
    ledger.base = 0;
    ledger.scanned = 0;
    ledger.settled = 0;
    ledger.snapshots = new Map();
    ledger.definitions.clear();
    ledger.waiting.clear();
    ledger.decided.clear();
    ledger.emitted = 0;
  };

  const take = (generator: Generator<AgentEvent>): AgentEvent[] => [...generator];

  return {
    capture(event) {
      // 子智能体说的正文记在它自己那笔账上(抽屉里那份文档),不许跟主会话混着扫。
      const child = childText(event);
      if (child) {
        feed(ledgerFor(child.id), child.text);
        return;
      }
      if (event.kind === "text") feed(ledgerFor(null), event.text);
    },
    noted(event) {
      return released.has(event);
    },
    release(event) {
      released.add(event);
      if (event.kind === "attachment") {
        if (event.path) {
          if (passed.has(event.path)) return [];
          passed.add(event.path);
          claimed.add(event.path);
        }
        return [event];
      }
      const out: AgentEvent[] = [];
      const finished = childClosed(event);
      if (event.kind === "done" || event.kind === "turnEnd") {
        // 回合收尾:先把图交代完,再把 `done`/`turnEnd` 放出去 —— 反过来的话结算那一侧已经
        // 把回合收了,后到的 attachment 挂不上这一回合。
        //
        // **主会话一回合一份文档,子智能体的抽屉不是**:它跨父回合累加成同一份(上一回合给
        // 定义、这一回合引用它是真实用法)。所以父回合收尾只给子文档记一次中途的账,文字和
        // 定义环境原样留着 —— 跟着父回合一起清掉的那一版,下一回合那处引用连图片节点都不是
        // (审查第 5 轮 R2C)。`done` 是整条流到头了,那时才整份结账。
        for (const [key, ledger] of ledgers) {
          if (key === "" || event.kind === "done") out.push(...take(closeLedger(ledger)));
          else out.push(...take(settle(ledger, "checkpoint")));
        }
      } else if (finished !== null) {
        // 某个子智能体说它收工了:它那份文档记一次中途的账。**状态一个字都不清** ——
        // 同 id 的子智能体会被唤醒接着说(native-work.ts 把同一 thread 的 turn/started、
        // turn/completed 转成 running、completed),而展示端从头到尾按同一个 id 把它的活动
        // 累加成一份正文。跟着「收工」把账本清掉的那一版,它醒来之后再引用上一段的定义,
        // 那处引用连图片节点都不是:完整正文 2 处引用、服务端只剩 1 条结果,页面上两处
        // 一起提示「图取不到」(审查第 6 轮 R2 第 3 行)。
        const ledger = ledgers.get(finished);
        if (ledger) out.push(...take(settle(ledger, "checkpoint")));
      } else {
        for (const ledger of ledgers.values()) if (ledger.due) out.push(...take(settle(ledger, "settled")));
      }
      out.push(event);
      for (const one of out) released.add(one);
      return out;
    },
    close() {
      const out: AgentEvent[] = [];
      for (const ledger of ledgers.values()) out.push(...take(closeLedger(ledger)));
      for (const one of out) released.add(one);
      return out;
    },
    dispose() {
      // **已经露过脸的那几份不算垃圾**。拍字节发生在半截正文上,所以拍下来的分两类:
      //   · 语法最后没认下它的(行内代码的反引号切在两片里:前半片里那个写法示例看着是真
      //     图)—— 那份拷贝谁都引用不到,留着就是纯粹的磁盘垃圾,删;
      //   · 语法已经认下它、只是还没来得及作为 attachment 交出去的 —— 消费者半路不取了
      //     (用户停任务、翻页,或者落库抛错)时这一类会落在这儿,而那段正文已经在屏幕上
      //     出现过,这份字节是它唯一的凭据。连它一起删掉的那一版就是「刚才还看得见的截图,
      //     清理原图再打开就没有了」(审查第 5 轮 R3、第 6 轮 R3)。
      // 误判只会偏向多留几十 KB(拼全了是代码、而那个块恰好已经定型),绝不会偏向删掉
      // 一张真截图 —— 这两种代价不对称。
      discardUnclaimedImages(captured, new Set([...claimed, ...exposed]));
    },
  };
}

/**
 * 给**任意**事件流补上「正文里提到的那张本机图片」。
 *
 * 生产路径上的入口是 event-queue.ts 的 EventQueue:捕获必须排在增量合并、活动合并和队列
 * **之前**,而一层流包装只看得见「事件已经出来了」那一刻。这个函数是**兜底加语义参考**
 * —— 没走那条流水线的事件(解析器自己 yield 的)由 settleMarkdownImages 补记一次账。
 */
export function withMarkdownImages(
  events: AsyncIterable<AgentEvent>,
  cwd?: string,
): AsyncIterable<AgentEvent> {
  return settleMarkdownImages(events, markdownImageSink(cwd));
}

/**
 * 已经在入口处记过账的那条流:负责**收口** —— 正常收尾、上游抛错、提前中断三条路都得
 * 有个了结。
 *
 * 抛错那条路必须在重新抛出**之前**把图交代完:上游一抛,正常收尾的那几句全被跳过(审查
 * 第 5 轮 R3)。消费者这时还在取事件(异常是它调 next() 时才抛到它手里的),所以这几条
 * attachment 送得出去。
 *
 * 消费者自己抛错/提前 break 那条路**没法再 yield**(调用方已经不取了),所以它只走 finally
 * 里的清理 —— 那一档靠两件事兜住:交代是**跟着正文一起发**的(语法一定型就发,不等回合
 * 收尾),以及 dispose 不删「语法已经认下它」的拷贝(见那里的注释)。
 */
export async function* settleMarkdownImages(
  events: AsyncIterable<AgentEvent>,
  sink: MarkdownImageSink,
): AsyncIterable<AgentEvent> {
  try {
    try {
      for await (const event of events) {
        // 已经从 EventQueue 走过账的原样放行;没走过的在这儿补记一次(见 sink.noted)。
        if (sink.noted(event)) {
          yield event;
          continue;
        }
        sink.capture(event);
        yield* sink.release(event);
      }
    } catch (error) {
      for (const event of sink.close()) yield event;
      throw error;
    }
    for (const event of sink.close()) yield event;
  } finally {
    sink.dispose();
  }
}
