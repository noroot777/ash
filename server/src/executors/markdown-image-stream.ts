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
  type ImageSnapshots,
} from "../agent-attachments.js";
import { metaImageAccounts } from "./markdown-image-meta.js";
import { childActivity } from "./native-agent-activity.js";

import {
  PENDING_DEFINITION,
  SCAN_SLACK,
  SCAN_WINDOW,
  childClosed,
  childText,
  type ImageSlot,
  type Ledger,
  type MarkdownImageAccounting,
  type MarkdownImageSink,
} from "./markdown-image-ledger.js";

// 契约层(类型与账本形状)住在 markdown-image-ledger.ts,既有引用照旧从这里拿。
export type {
  MarkdownImageAccounting,
  MarkdownImageSeedDoc,
  MarkdownImageSink,
  MarkdownImageSpot,
} from "./markdown-image-ledger.js";

export function markdownImageSink(cwd?: string, accounting?: MarkdownImageAccounting): MarkdownImageSink {
  const note = accounting?.note;
  // 解析器自己挂上来的附件(工具结果截图):同一份拷贝不铺两张卡片。正文引用来的那些
  // **不能**按路径去重 —— 重拍过的两处引用字节可能一样,但它们是两处引用(审查第 1 轮 F1)。
  const passed = new Set<string>();
  // 拍下来的 vs 真被某条结果领走的 vs 语法已经认下它的 —— 三者的分别见 dispose。
  const captured = new Set<string>();
  const claimed = new Set<string>();
  const exposed = new Set<string>();
  /** 从 release 出去过的事件(含它自己造的 attachment),见 MarkdownImageSink.noted。 */
  const released = new WeakSet<object>();
  // 子智能体 message/result(快照式正文)的账各归各(见 markdown-image-meta.ts),但清理
  // 账本共用:拍下没人领的照旧由 dispose 删。
  const meta = metaImageAccounts({ cwd, note, captured, claimed, exposed, seed: accounting?.seed });
  const ledgers = new Map<string, Ledger>();
  const ledgerFor = (id: string | null): Ledger => {
    const key = id ?? "";
    const existing = ledgers.get(key);
    if (existing) return existing;
    // 续聊/接管:这份文档在**上一条进程**里写过的正文和用掉的身份,从种子接回来。种子
    // 区间一个字节都不再碰(emitted 直接越过它),但定义表和「第几条结果」的起算点必须在
    // —— 不接,重开后的第一处引用又从 0 号发起,跟刷新后按 trace 重建的那份撞身份,展示端
    // 按「来源+身份」夹掉一条,两处引用一起「图取不到」(审查第 7 轮 R2);它引用上一段的
    // 定义时也认不出来。子文档(跨回合累加)在续聊/接管/重启接回都要接;主文档一回合一份,
    // 只有**重启接回**(回合没换、进程换了)要接,种子键用 ""(loadMarkdownImageSeed 按
    // 回合过滤后才会给这一键)。
    const seeded = accounting?.seed?.get(id ?? "");
    const seen = imageStore();
    const definitions = new Map<string, string>();
    const snapshots: ImageSnapshots = new Map();
    const waiting = new Map<number, { identifier: string; end: number }>();
    const noted = new Map<number, string>();
    const carried = seeded?.text.length ?? 0;
    const emitted = Math.min(seeded?.emitted ?? carried, carried);
    if (seeded) {
      seen.refs = seeded.refs;
      const parsed = scanMarkdownImages(seeded.text);
      // 种子是历史正文,定义「还在写」的风险只有最后一行那一条,而它续写的概率约等于零;
      // 漏收的代价(字节拍成晚的)远大于误收的(多读一次盘),所以收尾与否都收。
      for (const definition of parsed.definitions) {
        if (!definition.destination) continue;
        if (!definitions.has(definition.identifier)) definitions.set(definition.identifier, definition.destination);
      }
      // 上一条进程已冻结的字节与「丢了」的结论接回来:接回后交代种子区间里的引用,用的是
      // **当时**拍下的那一份,而不是现在去读盘(审查第 8 轮 R1:接回后红图被读成蓝图)。
      for (const snap of seeded.snapshots ?? []) {
        snapshots.set(snap.pos, {
          destination: snap.destination,
          ...(snap.path ? { path: snap.path } : {}),
          ...(snap.lost ? { lost: true } : {}),
        });
        // 这几笔临时账上一条进程已经记过,别再记一遍(目的地变了才值得再记)。
        noted.set(snap.pos, snap.destination);
      }
      // 交代线之后还在等定义的引用重新排队:定义在接回之后才到时,resolveWaiting 才认得它们。
      if (emitted < carried) {
        for (const candidate of parsed.waiting) {
          if (candidate.start >= emitted) waiting.set(candidate.start, { identifier: candidate.identifier, end: candidate.end });
        }
      }
    }
    const ledger: Ledger = {
      key: id,
      wrap: id === null
        ? (image) => ({ kind: "attachment", ...image })
        : (image) => childActivity(id, { kind: "attachment", ...image }),
      seen,
      text: seeded?.text ?? "",
      base: carried,
      scanned: carried,
      settled: carried,
      snapshots,
      definitions,
      waiting,
      decided: new Set(),
      noted,
      bang: -1,
      open: -1,
      openLink: false,
      emitted,
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
      const snapshot = ledger.snapshots.get(slot.start);
      // 「读到了、写盘失败」(lost)也是值得持久化的结论:不记这笔,消费者死后重建的那一页
      // 没有任何记录拦着,前端会退去读**后来**的文件 —— 恰是 lost 要挡的那条路(审查第 8 轮
      // R1 同类位置)。什么都没有的(没字节可存)照旧不记。
      if (!snapshot || (!snapshot.path && !snapshot.lost)) continue;
      if (snapshot.path) exposed.add(snapshot.path);
      // 语法已经认下它 = 这段正文已经(或马上会)出现在屏幕上:这一刻就记一笔**临时账**。
      // 等到交代那一刻才记的话,消费者在两者之间死掉,字节和正文的关系就只剩内存里那份。
      // 同一处只记一次;目的地变了(还在写的定义行后来接长了)就按新目的地再记,合账取最后。
      if (note && ledger.noted.get(slot.start) !== snapshot.destination) {
        ledger.noted.set(slot.start, snapshot.destination);
        note({
          doc: ledger.key, pos: slot.start, source: snapshot.destination,
          ...(snapshot.path ? { path: snapshot.path } : {}),
          ...(snapshot.lost ? { lost: true } : {}),
          final: false,
        });
      }
    }
  };

  /**
   * 放慢期间也不许漏掉字节:解析**末尾这一截**,把这一刻能认出来的引用先拍下来。
   *
   * 为什么需要这一道:SCAN_SLACK 让重解析的频率跟窗口大小成正比,于是一个块自己就比窗口
   * 长的时候(没有空行的长段、长表格),这一截里那张图要等后面一万多字才重解析一遍 ——
   * 中间文件被重拍过,拍到的就是后来那张,正是「字节版本由后面的时点决定」那一类。
   *
   * 这一截没有上下文(前面可能开着一个围栏),所以它的结论一律按**投机**办:只拍字节,
   * `settled`、`waiting`、`scanned`、定义表一个都不动,语法最后不认的那几份由 dispose 当
   * 垃圾清掉。坐标按绝对位置算,跟窗口那一遍对得上,于是同一处引用只读盘一次 —— 早拍下的
   * 那一份(正确的那一份)不会被后来那一遍洗掉(见 captureMarkdownImages 的单调性)。
   *
   * 起点不是 `scanned`,往回带到「最早还在等定义的引用」(再按一个窗口封底):引用被切在
   * 已扫/未扫边界两侧时,光扫新来那截只能看见后半个括号,整处引用就漏拍了;带上回看,这
   * 一截自己就包含完整语法(审查第 7 轮 R1 实测 splitSyntax)。等待中的引用按「整篇定义表
   * ∪ 这一截里新出现的定义」解 —— 定义本身落在放慢区里时(definitionEnvironment),不等
   * 整篇那一遍,它一出现字节就冻;只拍字节,不摘队、不定案,身份与交代仍归整篇扫描。
   *
   * 成本有三道闸:这一片得带着能收尾引用/定义的字符(`)` `]` 换行),这一截得真有 `![`
   * (或有人等定义且这截有 `]:`),解析范围不超过一个窗口。于是放慢档每一片至多解析 8 KB,
   * 总量线性。上一版不设起点、不设闸,从 `scanned` 一路解析到越积越长的末尾:262144 字的
   * 回合要 11 秒(审查第 7 轮 N1),现在同样输入毫秒级(test-agent-image-entry 案 ⑬)。
   */
  /**
   * 最早未定论 `![` 的推进 —— freezeTail 与整窗扫描**共用**这一条:定论判据各自给,推进
   * 逻辑必须同一份。整窗那一侧曾只把 open 清成 -1:同一片里前一节点刚定论、后一节点刚开头
   * 时,后者从此失去回看锚点,之后的碎片里再没有新 `![`,不能自愈(复审 R2 multipleOpenTail:
   * 应 RED/RED,实际 RED/BLUE)。不变量:**任何还没定论的图片节点都不被窗口丢弃** ——
   * open 要么指向最早那个,要么确实一个都不剩。
   */
  const advanceOpen = (ledger: Ledger, concluded: (pos: number) => boolean) => {
    while (ledger.open >= 0 && concluded(ledger.open)) {
      const next = ledger.text.indexOf("![", ledger.open + 1);
      ledger.open = next;
      ledger.openLink = next >= 0 && ledger.text.indexOf("](", next) >= 0;
    }
  };

  const freezeTail = (ledger: Ledger, fresh: string) => {
    // 快速闸:这一片不带能收尾引用/定义的字符就不值得解析 —— 例外是**还在写的定义行**:
    // 有人等定义、窗口尾部正是 `[r]: ` 之后的裸目的地时,这一片(`shot.svg`)一个标点都
    // 没有却恰恰补全了目的地;等下一片标点再拍,文件早被重拍(复审 R2 longBareDefinition:
    // 快车道的整篇扫描有第四档,放慢档的 freezeTail 原先没有)。窗口切片起点可能落在行中,
    // 行首锚因此可能误判一次 —— 代价只是多解析一片,漏判才会漏拍。
    if (
      !/[)\]\n]/.test(fresh)
      && !(ledger.waiting.size && PENDING_DEFINITION.test(ledger.text.slice(-SCAN_WINDOW)))
    ) return;
    let from = Math.min(ledger.scanned, ledger.text.length);
    for (const start of ledger.waiting.keys()) if (start < from) from = start;
    from = Math.max(from, ledger.text.length - SCAN_WINDOW, 0);
    // 一处图片节点**自己**比窗口还长(9 KB 的 title):封底会把节点开头切掉,这一片在切片里
    // 认不出候选 —— 但推不出「这一片没有完整引用」(审查第 8 轮 R2 实测:RED 拍成 BLUE)。
    // 还没定论的最早 `![` 必须整个进切片,所以回看允许越过封底。判据是**收尾字符本身**:
    // 能让 open 定论的只有 `]`(alt 收尾/引用式收尾)和进过 `](` 之后的 `)`(行内收尾),
    // 这样的一片必须回看 —— 按「增长预算」节流的上一版,收尾恰好单独成片(`")\n`,只有
    // 3 字)时增长不足 1/8,完整引用已可解释却被跳过,读到的是 200ms 后重拍的文件(复审
    // R2 实测 tail-split-close)。代价:open 一直没定论时,每个带收尾字符的片都要从 open
    // 重解析一遍 —— 上界是「未定论节点长度 × 这期间的收尾字符片数」,正常输出一处节点
    // 一两次就定论;真正的散文 `)` 由 openLink 挡住(裸 `![` 只等 `]`)。
    if (
      ledger.open >= 0 && ledger.open < from
      && (fresh.includes("]") || (ledger.openLink && fresh.includes(")")))
    ) {
      from = ledger.open;
    }
    // 回看范围里连 `![` 都没有、也没有人等定义:这一片不值得切 8 KB 出来解析。光靠上面的
    // 字符闸拦不住普通散文(换行到处都是),没有这一道,纯正文的放慢档每片都白付一个窗口。
    if (ledger.bang < from && !ledger.waiting.size) return;
    const slice = ledger.text.slice(from);
    if (!slice.includes("![") && !(ledger.waiting.size && slice.includes("]:"))) return;
    const tail = scanMarkdownImages(slice);
    // 这一截里新出现的定义:还没进整篇表(表只收定了型的,而且要等整篇那一遍),先当投机
    // 的后备查找用。没收尾的也用 —— 猜错目的地的代价只是多一份没人认领的拷贝。
    const found = new Map<string, string>();
    for (const definition of tail.definitions) {
      if (!definition.destination) continue;
      if (!found.has(definition.identifier)) found.set(definition.identifier, definition.destination);
    }
    const lookup = (identifier: string) => ledger.definitions.get(identifier) ?? found.get(identifier);
    const spots = new Map<number, ImageSlot>();
    for (const ref of tail.refs) {
      const destination = (ref.identifier !== undefined ? lookup(ref.identifier) : undefined) ?? ref.destination;
      if (destination) spots.set(ref.start + from, { destination, start: ref.start + from, end: ref.end + from });
    }
    for (const candidate of tail.waiting) {
      const start = candidate.start + from;
      const destination = lookup(candidate.identifier);
      if (destination && !spots.has(start)) spots.set(start, { destination, start, end: candidate.end + from });
    }
    for (const [start, entry] of ledger.waiting) {
      const destination = lookup(entry.identifier);
      if (destination && !spots.has(start)) spots.set(start, { destination, start, end: entry.end });
    }
    if (spots.size) freeze(ledger, [...spots.values()]);
    // 定论只认两种:字节已冻上(snapshots)、或整篇扫描已定案(decided)。**这一片的
    // waiting 不算数**:还没闭合的行内节点(`![a](b "title…` 等着收尾)在无上下文切片里会被
    // 解析成「等定义的引用式候选」—— 拿它当定论,收尾那一片(`")\n`)到达时 open 已经被清,
    // 完整引用可解释却没人回看(正是复审 R2 的 tail-split-close)。真正的引用式等待被 open
    // 钉住的代价只是多几次回看,定义一到冻结就推进。定论之后 open 推进到**下一个** `![`
    // (同片可能有多个未决节点,只清不挪会把后面那个漏在窗口外)。
    advanceOpen(ledger, (pos) => ledger.snapshots.has(pos) || ledger.decided.has(pos));
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
  const resolveWaiting = (ledger: Ledger, open: { identifier: string; destination: string } | null): ImageSlot[] => {
    const found: ImageSlot[] = [];
    for (const [start, entry] of [...ledger.waiting]) {
      const destination = ledger.definitions.get(entry.identifier);
      if (destination !== undefined) {
        ledger.waiting.delete(start);
        ledger.decided.add(start);
        found.push({ destination, start, end: entry.end });
      } else if (open && open.identifier === entry.identifier) {
        // 定义行还在写(`[r]: partial.svg` 后面随时接出 `?v=1`):目的地**多半**已经完整,
        // 字节先按它拍下来;不摘队、不定案 —— 等这条定义收了尾,上面那条路会按定了型的
        // 目的地再解一遍,目的地真变了就按新目的地再读一次盘(captureMarkdownImages 按
        // 「起点 + 目的地」的单调性),身份与交代也等那时(见 settle 的扣押)。
        found.push({ destination: open.destination, start, end: entry.end });
      }
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
    const seam = ledger.text.length;
    ledger.text += text;
    const at = text.lastIndexOf("![");
    if (at >= 0) ledger.bang = seam + at;
    else if (text[0] === "[" && ledger.text[seam - 1] === "!") ledger.bang = seam - 1;
    if (ledger.open < 0) {
      const first = text.indexOf("![");
      if (first >= 0) ledger.open = seam + first;
      else if (text[0] === "[" && ledger.text[seam - 1] === "!") ledger.open = seam - 1;
      if (ledger.open >= 0) ledger.openLink = ledger.text.indexOf("](", ledger.open) >= 0;
    } else if (!ledger.openLink && (text.includes("](") || (text[0] === "(" && ledger.text[seam - 1] === "]"))) {
      // 误报(`](` 在 open 之前/被转义)只多付几次回看,漏报才会漏拍 —— 宁可宽。
      ledger.openLink = true;
    }
    const window = ledger.text.length - ledger.base;
    const fresh = ledger.text.length - ledger.scanned;
    // 这一窗已经畸形地大了(一个块自己就比窗口长):按比例放慢,见 SCAN_SLACK。放慢的只是
    // 「哪几处是真图」那一遍,字节照旧当场拍(freezeTail)。
    if (window > SCAN_WINDOW && fresh * SCAN_SLACK < window) {
      freezeTail(ledger, text);
      return;
    }
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
    // 定义表是整篇文档的,同名取第一条 —— 收下它才能解开窗口之外那几处等待。只收**定了
    // 型**的:还在写的定义行(`[proof]: partial.svg` 等着接 `?v=1`)进了表就撤不回来 ——
    // 按它交代出去的来源会跟整篇正文对不上,展示端配不上记录只好退回工作目录取现在的文件
    // (审查第 7 轮 R2 第 1 行)。没有目的地的也不收(micromark 把 `[r]:` 解析成指向空串)。
    for (const definition of scan.definitions) {
      if (!definition.terminated || !definition.destination) continue;
      if (!ledger.definitions.has(definition.identifier)) {
        ledger.definitions.set(definition.identifier, definition.destination);
      }
    }
    // 还在写的那条定义(只可能是最后一条):不进表,但值得拿去**投机冻结**等它的引用。
    // 整篇第一条同名定义已经定型时轮不到它(CommonMark 同名取第一条)。
    const last = scan.definitions.at(-1);
    const open = last && !last.terminated && last.destination && !ledger.definitions.has(last.identifier)
      ? { identifier: last.identifier, destination: last.destination }
      : null;
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
    const resolved = resolveWaiting(ledger, open);
    // 最早未定论 `![` 的另外几条出路:定型线越过它(settled 的语法里它要么已是节点并被上面
    // 冻结,要么根本不是图,围栏里的示例就归这档)、字节已冻结、或交代线已越过。定论之后
    // 推进到下一个,不是清掉:同一片里可能跟着又一个刚开头的节点(复审 R2)。
    advanceOpen(ledger, (pos) =>
      pos < scan.boundary || pos < ledger.emitted || ledger.snapshots.has(pos) || ledger.decided.has(pos));
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
    let blocked = upTo !== "whole" && scan.pending >= 0 ? scan.pending : ledger.text.length;
    if (upTo !== "whole") {
      // 正文以一条**还在写**的定义收尾时,指着它的引用也得扣下:现在交代,报出去的来源是
      // `partial.svg`,下一片接上 `?v=1` 之后整篇正文说的却是 `partial.svg?v=1` —— 展示端
      // 按来源配对,这条结果从此谁都认领不了(审查第 7 轮 R2 第 1 行)。整篇第一条同名定义
      // 已经定型的不算(同名取第一条,后面那条写没写完都轮不到)。`whole` 不扣:文档到头了,
      // 这条定义不会再长,它现在的样子就是展示端看到的样子。
      const last = scan.definitions.at(-1);
      if (last && !last.terminated
        && !scan.definitions.some((definition) => definition !== last && definition.identifier === last.identifier && definition.terminated)) {
        for (const ref of scan.refs) {
          if (ref.identifier === last.identifier && ref.start < blocked) {
            blocked = ref.start;
            break;
          }
        }
      }
    }
    const stop = Math.min(blocked, upTo === "settled" ? scan.boundary : ledger.text.length);
    if (stop <= ledger.emitted) return;
    const refs = scan.refs.filter((ref) => ref.start >= ledger.emitted && ref.end <= stop);
    for (const ref of refs) {
      // 一条一条交代:持久账要把「正文里的哪一处」跟「哪条结果」钉在一起,批量交代拿不到
      // 这层对应(站外地址那种不发结果的引用会让「第 i 条结果 = 第 i 处引用」错位)。
      let produced = false;
      for (const image of persistMarkdownImageRefs([ref], ledger.seen, { cwd, snapshots: ledger.snapshots })) {
        produced = true;
        if (image.path) claimed.add(image.path);
        note?.({ doc: ledger.key, pos: ref.start, source: image.source, ref: image.ref, path: image.path, lost: image.lost, final: true });
        yield ledger.wrap(image);
      }
      // 一条结果都没有 = 这个节点不需要本地保存(站外/data:,浏览器自己取)。持久账记一笔
      // 「合法间隔」:恢复侧按节点推交代线时,它不算缺口(复审 R3)。
      if (!produced && ref.destination) {
        note?.({ doc: ledger.key, pos: ref.start, source: ref.destination, skipped: true, final: true });
      }
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
    ledger.noted.clear();
    ledger.bang = -1;
    ledger.open = -1;
    ledger.openLink = false;
    ledger.emitted = 0;
  };

  const take = (generator: Generator<AgentEvent>): AgentEvent[] => [...generator];

  return {
    capture(event) {
      // 子智能体的 message/result 是快照式正文,字节同样在这一刻冻(账在 meta 那本上)。
      meta.capture(event);
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
        if (event.kind === "done") out.push(...meta.close());
      } else if (finished !== null) {
        // 某个子智能体说它收工了:它那份文档记一次中途的账。**状态一个字都不清** ——
        // 同 id 的子智能体会被唤醒接着说(native-work.ts 把同一 thread 的 turn/started、
        // turn/completed 转成 running、completed),而展示端从头到尾按同一个 id 把它的活动
        // 累加成一份正文。跟着「收工」把账本清掉的那一版,它醒来之后再引用上一段的定义,
        // 那处引用连图片节点都不是:完整正文 2 处引用、服务端只剩 1 条结果,页面上两处
        // 一起提示「图取不到」(审查第 6 轮 R2 第 3 行)。
        const ledger = ledgers.get(finished);
        if (ledger) out.push(...take(settle(ledger, "checkpoint")));
        out.push(...meta.settle(event));
      } else {
        for (const ledger of ledgers.values()) if (ledger.due) out.push(...take(settle(ledger, "settled")));
        out.push(...meta.settle(event));
      }
      out.push(event);
      for (const one of out) released.add(one);
      return out;
    },
    close() {
      const out: AgentEvent[] = [];
      for (const ledger of ledgers.values()) out.push(...take(closeLedger(ledger)));
      out.push(...meta.close());
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

// withMarkdownImages / settleMarkdownImages 住在 markdown-image-flow.ts(700 行上限),
// 从这里原样转发:账本与收口是一对出口,调用方不该知道它们分了家。
export { settleMarkdownImages, withMarkdownImages } from "./markdown-image-flow.js";
