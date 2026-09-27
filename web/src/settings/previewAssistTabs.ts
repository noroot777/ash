// 「这个 claim 现在还在谁手里」——同源页面之间的作业所有权裁决。
//
// 为什么需要裁决:所有权记在 `sessionStorage`(见 previewAssistMemory.ts),而 sessionStorage
// **不是每个新标签都从空的开始**。带 opener 打开的页面(`window.open`、`target=_blank`)和「复制
// 标签页」都会拿到来源页面那一份的**初始副本**,于是那个从没点过按钮的新页面手里也有一份跟
// 服务端作业对得上的 claim,成功时照样把自己的输入框改掉,还说「脚本已填入」(第 7 轮审查)。
//
// 光比 claim 分不出正主和副本(两边一模一样),分得开的只有「同一时刻还有没有另一个**活着的**
// 文档拿着它」。而「活着」这件事**不能靠问一句、等一会儿**:正主主线程忙 800ms、标签被冻结、
// 调度延迟,都会让它答不上来,静默于是被读成「没有正主」,副本就此认领 —— 第 8 轮审查复现的
// 正是这一下(而且迟到的那句应答当时还被永久忽略了)。
//
// 所以主路把账交给浏览器 —— **Web Locks**:文档拿住一把以 claim 命名的锁就一直不放手,
// `ifAvailable` 当场回答「有没有别人拿着」。没有超时、没有猜:
//   · 正主卡住 → 锁还在它手里 → 副本当场知道自己是副本(JS 停摆不影响锁的账)
//   · 正主刷新 → 旧文档销毁、锁自动释放 → 新文档立刻拿到 → 正主照旧是自己
//     (第 6 轮要的「刷新之后还能接着跟」不能因为这次修复丢掉)
//   · 复制 / window.open → 正主还活着,锁拿不到 → 新页面只读
//
// 降级路:`navigator.locks` 要安全上下文,裸 http 的局域网地址(ash 常这么开)根本没有它。那一档
// 退回 BroadcastChannel 点名,但**判断必须是可撤回的**:超时只算「暂且是我的」,迟到的应答一到
// 就当场交出去;两份副本同时恢复、彼此都没来得及登记的那一种,靠「谁先拿住谁算」(since 早的赢)
// 收口。代价照实说:降级路上「超时」到「撤回」之间那几百毫秒里副本仍把自己当正主 —— 比原来
// 「永久认错」小得多,而安全上下文(localhost / https)压根走不到这一档。
//
// BroadcastChannel 不会把消息投回给发送方自己,所以「自己应答自己」这种事不会发生。
const CHANNEL = "ash:preview-assist-claims";
const LOCK = (projectId: string, claim: string) => `ash:preview-assist:${projectId}:${claim}`;
/** 这一页的身份。只活在内存里 —— sessionStorage 里的东西会被复制,这个不会。 */
const PAGE = `page-${Math.random().toString(36).slice(2, 10)}`;

type Note =
  | { kind: "ask"; projectId: string; claim: string }
  | { kind: "held"; projectId: string; claim: string; since: number; page: string };

interface Hold {
  claim: string;
  /** 这一页从什么时候起拿着它:正主是点下按钮那一刻,副本是它自己打开的那一刻(必然更晚)。 */
  since: number;
}
interface Ask {
  projectId: string;
  claim: string;
  settle: (heldElsewhere: boolean) => void;
}

const holds = new Map<string, Hold>();
const asking = new Set<Ask>();
const losers = new Set<(projectId: string) => void>();
/** 已经拿在手里的锁名(拿到就不放,所以只记不删)。 */
const locked = new Set<string>();
let bus: BroadcastChannel | null | undefined;

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void> | undefined,
  ): Promise<unknown>;
}
const lockManager = (): LockManagerLike | null => {
  try {
    return (globalThis.navigator as unknown as { locks?: LockManagerLike } | undefined)?.locks ?? null;
  } catch { return null; }
};

function channel(): BroadcastChannel | null {
  if (bus !== undefined) return bus;
  try {
    const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    bus = Ctor ? new Ctor(CHANNEL) : null;
  } catch { bus = null; }
  bus?.addEventListener("message", (event: MessageEvent) => {
    const note = event.data as Note | null;
    if (note?.kind === "ask") {
      if (holds.get(note.projectId)?.claim === note.claim) announce(note.projectId);
      return;
    }
    if (note?.kind !== "held") return;
    for (const ask of [...asking]) {
      if (ask.projectId === note.projectId && ask.claim === note.claim) ask.settle(true);
    }
    const held = holds.get(note.projectId);
    if (held?.claim !== note.claim) return;
    // **迟到的应答照样算数**:已经认领过了也要交出去(第 8 轮审查:原来等待项一超时就删,
    // 迟到那句话谁都不认,副本从此永久占着所有权)。谁先拿住谁算,同毫秒按页面 id 定。
    if (note.since < held.since || (note.since === held.since && note.page < PAGE)) surrender(note.projectId);
    else announce(note.projectId); // 我更早 → 反过来让它交出去(两份副本同时恢复的那一种)
  });
  return bus;
}

function announce(projectId: string): void {
  const held = holds.get(projectId);
  if (held) channel()?.postMessage({ kind: "held", projectId, claim: held.claim, since: held.since, page: PAGE } satisfies Note);
}

/** 交出所有权:登记抹掉,再让订阅者把本地追踪和界面改回「别人的作业」。 */
function surrender(projectId: string): void {
  holds.delete(projectId);
  for (const loser of losers) loser(projectId);
}

/** 订阅「这一页的所有权被撤回了」。返回退订。 */
export function watchAssistClaimLost(listener: (projectId: string) => void): () => void {
  losers.add(listener);
  return () => { losers.delete(listener); };
}

/**
 * 这一页认下(或放下)一个 claim:别人点名时应答的就是这份登记,顺手把同名的锁握住。
 *
 * 登记跟本地那条追踪记录同生同死(previewAssistMemory.ts 的三个写入口各调一次):记录一抹掉
 * 就不再应答 —— 之后从这一页复制出去的标签本来也继承不到什么。
 */
export function holdAssistClaim(projectId: string, claim: string | null): void {
  if (!claim) { holds.delete(projectId); return; }
  if (holds.get(projectId)?.claim === claim) return; // 每一拍轮询都会调一次，别重复登记和广播
  holds.set(projectId, { claim, since: Date.now() });
  void grabLock(projectId, claim);
  // 主动报一声:两份副本同时恢复、谁都没来得及应答谁的那一种，就靠这一声分出先后。
  announce(projectId);
}

/**
 * 这一页能不能**独占**这个 claim。
 *
 * true = 能(这一页就是正主);false = 另一个活着的文档拿着它(这一页是会话副本，只许看)。
 */
export async function claimAssistOwnership(projectId: string, claim: string): Promise<boolean> {
  const byLock = await grabLock(projectId, claim);
  if (byLock !== null) {
    if (byLock) holdAssistClaim(projectId, claim);
    return byLock;
  }
  return askAround(projectId, claim);
}

/** 拿锁:true=拿到了,false=别的活文档拿着,null=这个环境没有 Web Locks(走降级路)。 */
function grabLock(projectId: string, claim: string): Promise<boolean | null> {
  const manager = lockManager();
  if (!manager) return Promise.resolve(null);
  const name = LOCK(projectId, claim);
  if (locked.has(name)) return Promise.resolve(true);
  return new Promise<boolean | null>((resolve) => {
    let answered = false;
    const answer = (value: boolean | null) => { if (!answered) { answered = true; resolve(value); } };
    try {
      void manager.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) { answer(false); return undefined; }
        locked.add(name);
        answer(true);
        // 一直不放手:锁的生死交给浏览器 —— 这一页卡住锁还在，这一页消失锁自动收回。
        return new Promise<void>(() => { /* 直到文档结束 */ });
      }).catch(() => answer(null));
    } catch { answer(null); }
  });
}

/** 降级路的点名:有人应答就是别人的;没人应答**暂且**算自己的（可撤回，见文件头）。 */
function askAround(projectId: string, claim: string, waitMs = 300): Promise<boolean> {
  const wire = channel();
  if (!wire) { holdAssistClaim(projectId, claim); return Promise.resolve(true); }
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask: Ask = {
      projectId,
      claim,
      settle: (heldElsewhere) => {
        if (!asking.delete(ask)) return;
        if (timer !== undefined) clearTimeout(timer);
        resolve(!heldElsewhere);
      },
    };
    asking.add(ask);
    timer = setTimeout(() => {
      // 静默不等于没有正主,所以这只是「暂且是我的」:先登记下来,迟到的应答会把它撤回。
      holdAssistClaim(projectId, claim);
      ask.settle(false);
    }, waitMs);
    wire.postMessage({ kind: "ask", projectId, claim } satisfies Note);
  });
}
