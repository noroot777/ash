// markdown-image-stream.ts 的**契约层**:扫描常量、一笔账(Ledger)的形状、子文档判别、
// 以及对外导出的全部类型。从 stream 拆出来只为守 700 行上限(同 markdown-image-flow.ts);
// 账本的行为语义仍在 stream 本体,这里只有「账长什么样」。
import type { AgentEvent } from "@ash/shared";
import type {
  ImageRefSpot,
  ImageSnapshots,
  ImageStore,
  PersistedMarkdownImage,
} from "../agent-attachments.js";

// **冻结字节**那一遍扫描的窗口。全文一直留着(见 Ledger.text),这个窗口只决定「每来一片
// 要重新解析多长一段」—— 不设上限的话一份 1 MB 的回合会被逐片重解析成 O(n²)。
export const SCAN_WINDOW = 8192;
// 一个块自己就比窗口长(往围栏里灌了一整份日志)时,重解析按**比例**放慢:这一窗每长
// 1/8 才再解析一遍。于是总解析量恒 ≈ 8 倍正文长度(线性),而不是逐片重扫那一兆。
//
// 上一版在这里设了个 1 MB 的天花板,过线就把窗口**跳到末尾**:那一段里的引用从此拍不到
// 字节,全部退回收尾那一遍去读文件 —— 读到的是后来的文件(审查第 6 轮 R2 的同类范围)。
// 按比例放慢既不放弃任何一段,也不会 O(n²);代价只是那种畸形大块里的字节最多晚 1/8 块。
export const SCAN_SLACK = 8;
// 还在写的定义行(`[r]: output/sho`):它的目的地由**裸文字**收尾,一个标点都不带。
export const PENDING_DEFINITION = /(?:^|\n) {0,3}\[(?:[^\]\\\n]|\\.)*\]:[^\n]*$/;

/** 一处引用的「目的地 + 它在全文里占的那一段」—— 落盘和交代都只要这三个数。 */
export type ImageSlot = ImageRefSpot & { end: number };

/**
 * 一笔账 = 屏幕上**一份独立的 Markdown 文档**。
 *
 * 主会话一份(每个回合各一份),每个子智能体抽屉里的正文各是一份 —— 后者**跨父回合累加**
 * (见 web/src/task-detail/nativeWorkModel.ts:同 id 的子活动合成同一份文档),所以父回合
 * 收尾不等于它收尾,它自己说「收工了」也不等于(同 id 的子智能体会被唤醒接着说)。定义、
 * 脚注都是整篇文档的,两份文档的正文一个字都不能混进同一笔账里扫。
 */
export type Ledger = {
  /** 这份文档的身份:主会话 null,子智能体 = 它的 id。持久账(MarkdownImageSpot.doc)用它。 */
  key: string | null;
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
  /** 已经记过**临时账**的起点 → 当时记的目的地(目的地变了要再记一笔),见 freeze。 */
  noted: Map<number, string>;
  /** 全文里最近一个 `![` 的起点(-1 = 还没有)。freezeTail 的免扫闸:增量维护,别回头找。 */
  bang: number;
  /**
   * **最早**一个还没定论的 `![`(-1 = 没有)。一处图片节点自己比窗口还长(9 KB 的 title/alt)
   * 时,放慢档的窗口封底会把节点开头切掉 —— 窗口里认不出候选推不出「这一片没有完整引用」
   * (审查第 8 轮 R2)。回看跟着它越过封底;定论(冻结过、定型线越过它、交代线越过它)就清。
   */
  open: number;
  /** open 之后出现过 `](` —— 行内节点已进目的地/标题段,`)` 才可能是它的收尾。增量维护,
   * 把「散落的 `)`」挡在回看之外(等 `]` 的裸 `![` 不该为每个右括号付一次解析)。 */
  openLink: boolean;
  /** 交代到这个绝对偏移为止了:起点在它之前的引用不再发第二遍。 */
  emitted: number;
  /** 有「语法已定型、还没交代过」的引用在等着 —— 下一条事件进流时就把它交代出去。 */
  due: boolean;
};

/** 这条事件是**某个子智能体**说的正文吗 —— 它那份抽屉正文是独立的一份文档。 */
export function childText(event: AgentEvent): { id: string; text: string } | null {
  const work = event.kind === "tool" ? event.nativeWork : undefined;
  if (work?.type !== "activity" || work.event.kind !== "text" || !work.event.text) return null;
  return { id: work.id, text: work.event.text };
}

/** 这条事件宣告**某个子智能体收工了**吗 —— 那份抽屉文档记一次中途的账。 */
export function childClosed(event: AgentEvent): string | null {
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

/**
 * 一条**消费者之外**的账目:这份文档(`doc`,主会话为 null)里 `pos` 处的引用指向 `source`。
 *
 * 为什么要有这条账:交代出去的 attachment 事件只活在**消费者**手里 —— 它取走事件、写进
 * trace,这条关系才落盘。消费者半路死掉(落库抛错、进程被杀)时,uploads 里那份字节还在
 * (dispose 不删已露过脸的),可「它是哪份文档哪一处引用的」这层关系只存在于内存,刷新后
 * 重建的那一页只能提示「图取不到」(审查第 7 轮 R3)。`note` 由服务端接到持久账本上
 * (agent-image-journal.ts),重建时跟 trace 合并,这层关系就不再跟消费者同生共死。
 */
export type MarkdownImageSpot = {
  doc: string | null;
  /** 这条账属于子智能体的哪份**快照式**正文(message/result),缺省 = 追加式文档本体。 */
  field?: "message" | "result";
  /** 快照式正文的代号(见 shared NativeAgentActivity attachment 的 rev)。 */
  rev?: number;
  /** 引用在这份文档全文里的绝对起点 —— 临时账与最终账靠它对上同一处。 */
  pos: number;
  source: string;
  /** 最终账才有:这份文档里第几条结果(展示端配对认的身份)。 */
  ref?: number;
  path?: string;
  lost?: boolean;
  /** 这个节点**不需要本地结果**(站外地址、data: 等,浏览器自己取):交代时如实记一笔,
   * 恢复侧才能把它当作合法间隔 —— 没有这一笔,「每个节点都该有一条 attachment」的推断会
   * 在第一个站外图上断掉,把后面还等定义的引用整段当成交代过(复审 R3)。 */
  skipped?: boolean;
  /** false = 字节刚冻结(临时账,随时会被最终账覆盖);true = 已经作为事件交代出去。 */
  final: boolean;
};

/** 续聊/接管时一份文档在**之前的进程**里已经写下的正文、用掉的身份数与未结状态。 */
export type MarkdownImageSeedDoc = {
  text: string;
  refs: number;
  /**
   * 交代推进到的绝对偏移。缺省 = 正文末尾(老口径:种子区间当作全部交代过)。恢复侧
   * (agent-image-journal)只有在能用持久账核实「已交代的恰是前 refs 条、各在哪一处」时才给
   * 更靠前的值 —— 接回的 sink 据此**继续交代**种子区间里还没交代的引用(审查第 8 轮 R1:
   * 不接续,重启前被待定引用扣押的那一处永远不再交付,补回行又排在新记录之后,红蓝对调)。
   */
  emitted?: number;
  /** 之前的进程已冻结的字节(含「读到了、写盘失败」的 lost 结论),按绝对起点。 */
  snapshots?: ReadonlyArray<{ pos: number; destination: string; path?: string; lost?: boolean }>;
  /** 仅快照式正文(metaSeedKey 键)用:上一条进程的**最高代本身**。要不要升代由正文判据
   * (前缀延长=同代,非前缀改版/清场=新代)决定 —— 盲目 +1 会把协议重放的同一份正文当成
   * 新内容重拍(第 9 轮复审 R1 metaResumeNewTurn)。 */
  rev?: number;
};

export type MarkdownImageAccounting = {
  /** 每出一条值得持久化的账(临时的冻结、最终的交代)就叫一声。必须自己兜住异常。 */
  note?: (record: MarkdownImageSpot) => void;
  /** 子文档 id → 它之前的状态。子文档跨进程累加(见 Ledger 注释),不接上就会重新发号。 */
  seed?: ReadonlyMap<string, MarkdownImageSeedDoc>;
};

