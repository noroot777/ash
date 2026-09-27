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
// 收口。
//
// 「暂且是我的」撑不起**不可逆**的动作 —— 第 9 轮审查把正主的应答延到 30 秒,副本在那之前就
// 让作业成功了:脚本填进输入框、通知也发了,撤回只能改状态,填进去的东西收不回来。所以所有权
// 分两档,`assistClaimSettled` 就是这条线:
//   · click(这一页自己点的按钮)/ lease(浏览器仲裁的租约)/ handoff(刷新时自己给自己的接力凭据)
//     → **站得住**,成功就直接填
//   · provisional(降级路上靠静默超时暂且认下的)→ 只够只读地跟进度;作业成功时不许动输入框,
//     把脚本摆出来让用户自己拍板(PreviewAiAssist 的 offered)。等待多久都换不来确认,那就别等
//
// handoff 这一档是第 10 轮审查补的:「刷新」和「复制」压根不是一回事 —— 刷新是**顺序交接**
// (旧文档先死,新文档才活),复制是**并发分身**(来源页面一直活着)。所以走的那一份可以在
// `pagehide` 里给自己留一张一次性凭据(sessionStorage,见 takeHandoff):
//   · 同一个标签刷新 → 新文档当场取走它 → 站得住,成功照旧自动填(裸 http 上刷新不再降级)
//   · 复制 / window.open → 它那份快照是在来源页面**还活着**的时候拷走的,里面压根没有这张凭据,
//     而且凭据是一次性的(取走即删),所以伪造不出来 —— 第 9 轮钉住的「副本不许填」一点没松
//
// 但「拿到凭据」本身还不够(第 11 轮审查):`pagehide` **不止刷新会触发** —— 跳走、关掉也写。
// 那个带着未消费凭据的标签接着 window.open 出两个设置页,两页各克隆一份、各自消费掉,于是
// **两页都算站得住**,作业一成功两页都往自己的输入框里填。所以凭据要认两件事:
//   ① 这一份文档是不是**刷新**出来的(导航类型 "reload";window.open / 复制 / 会话恢复都不是)
//   ② 读到就删,**认不认都删** —— 否则那个克隆页自己刷新一下就把凭据洗成了「刷新出来的」
// 两条合起来,一次 pagehide 写下的凭据最多只有「写它的那个标签刷新出来的那一份文档」用得上。
// 「这一页自己点过按钮」同理是副本复制不走的证据:它只活在这一份文档的内存里。
//
// BroadcastChannel 不会把消息投回给发送方自己,所以「自己应答自己」这种事不会发生。
const CHANNEL = "ash:preview-assist-claims";
const LOCK = (projectId: string, claim: string) => `ash:preview-assist:${projectId}:${claim}`;
const HANDOFF_KEY = (projectId: string) => `ash:preview-assist-handoff:${projectId}`;
/** 接力凭据的有效期。刷新是一瞬间的事,给足加载时间就够;过期只是退回「摆出来让用户拍板」。 */
const HANDOFF_MS = 60_000;
/** 这一页的身份。只活在内存里 —— sessionStorage 里的东西会被复制,这个不会。 */
const PAGE = `page-${Math.random().toString(36).slice(2, 10)}`;

type Note =
  | { kind: "ask"; projectId: string; claim: string }
  | {
    kind: "held";
    projectId: string;
    claim: string;
    since: number;
    page: string;
    /** 报一声的这一份站不站得住:站得住的压得过「暂且认下的」,跟谁先谁后无关。 */
    settled: boolean;
  };

/** 所有权是怎么来的 —— 决定它撑不撑得起「直接改用户的输入框」。见文件头。 */
export type AssistClaimSource = "click" | "lease" | "handoff" | "provisional";

interface Hold {
  claim: string;
  /** 这一页从什么时候起拿着它:正主是点下按钮那一刻,副本是它自己打开的那一刻(必然更晚)。 */
  since: number;
  source: AssistClaimSource;
}
interface Ask {
  projectId: string;
  claim: string;
  settle: (heldElsewhere: boolean) => void;
}

const holds = new Map<string, Hold>();
/**
 * 站得住的那些 claim（`${projectId}\0${claim}`）。
 *
 * **跟 `holds` 分开记是必须的**：`holds` 是「现在还应不应答点名」，作业一落终态，
 * previewAssistMemory 就会正常抹掉本地追踪、顺手把登记放掉（不放掉的话服务端 10 分钟后清掉
 * 终态，那个 null 会被读成「出事了」）。而「这份结果能不能填进输入框」是那之后才判的 ——
 * 挂在 `holds` 上就等于「响应丢了但作业已经成功」那一路(回归 ⑤b)自己把自己判成不可信。
 * 只有被撤回（surrender）才真的不再算数。
 */
const settled = new Set<string>();
const settledKey = (projectId: string, claim: string) => `${projectId}\u0000${claim}`;
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
    // **站得住的那一份压得过「暂且认下的」,跟谁先谁后无关** —— 正主刷新之后 since 反而更晚
    // （新文档刚起来），按先后比就会把它判给还活着的那份副本（第 10 轮审查）。
    const mineSettled = held.source !== "provisional";
    if (note.settled !== mineSettled) {
      if (note.settled) surrender(note.projectId);
      else announce(note.projectId); // 我站得住 → 反过来让它交出去
      return;
    }
    // **迟到的应答照样算数**:已经认领过了也要交出去(第 8 轮审查:原来等待项一超时就删,
    // 迟到那句话谁都不认,副本从此永久占着所有权)。谁先拿住谁算,同毫秒按页面 id 定。
    if (note.since < held.since || (note.since === held.since && note.page < PAGE)) surrender(note.projectId);
    else announce(note.projectId); // 我更早 → 反过来让它交出去(两份副本同时恢复的那一种)
  });
  return bus;
}

function announce(projectId: string): void {
  const held = holds.get(projectId);
  if (held) {
    channel()?.postMessage({
      kind: "held", projectId, claim: held.claim, since: held.since, page: PAGE,
      settled: held.source !== "provisional",
    } satisfies Note);
  }
}

/** 交出所有权:登记抹掉,再让订阅者把本地追踪和界面改回「别人的作业」。 */
function surrender(projectId: string): void {
  const held = holds.get(projectId);
  if (held) settled.delete(settledKey(projectId, held.claim));
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
 *
 * `source` 只在**第一次**认下时记住(每一拍轮询都会再调一次,不能把它冲掉)。
 */
export function holdAssistClaim(projectId: string, claim: string | null, source: AssistClaimSource = "click"): void {
  if (!claim) { holds.delete(projectId); return; }
  if (holds.get(projectId)?.claim === claim) return; // 每一拍轮询都会调一次，别重复登记和广播
  holds.set(projectId, { claim, since: Date.now(), source });
  // 站得住的来路只记一次、也不随登记一起放掉（见 settled 的注释）；同时挂上刷新时的接力钩子。
  if (source !== "provisional") { settled.add(settledKey(projectId, claim)); armHandoff(); }
  void grabLock(projectId, claim);
  // 主动报一声:两份副本同时恢复、谁都没来得及应答谁的那一种，就靠这一声分出先后。
  announce(projectId);
}

/**
 * 这份所有权**站不站得住**:站得住才允许动用户的输入框。
 *
 * 站得住的三种来路:这一页自己点的按钮、浏览器仲裁的租约、刷新时自己给自己的接力凭据。降级路上
 * 靠静默超时暂且认下的那一档不算 —— 等多久都换不来确认，而填进输入框和那句「脚本已填入」都
 * 收不回来（第 9 轮审查：正主应答延到 30 秒，副本在撤回之前已经把脚本填了）。
 */
export function assistClaimSettled(projectId: string, claim: string): boolean {
  return settled.has(settledKey(projectId, claim));
}

/**
 * 这一页能不能**独占**这个 claim。
 *
 * true = 能(这一页就是正主);false = 另一个活着的文档拿着它(这一页是会话副本，只许看)。
 * 注意 true 还分两档:租约给的 true 站得住，降级路静默超时给的 true 只够只读跟进度
 * (assistClaimSettled)。
 */
export async function claimAssistOwnership(projectId: string, claim: string): Promise<boolean> {
  const byLock = await grabLock(projectId, claim);
  if (byLock !== null) {
    if (byLock) holdAssistClaim(projectId, claim, "lease");
    return byLock;
  }
  // 没有 Web Locks:先看这一页刷新时给自己留的那张一次性凭据 —— 副本伪造不出来(见文件头)。
  if (takeHandoff(projectId, claim)) { holdAssistClaim(projectId, claim, "handoff"); return true; }
  return askAround(projectId, claim);
}

const session = (): Storage | undefined => {
  try { return globalThis.sessionStorage; } catch { return undefined; } // 隐私模式会抛
};

/** 走之前留下的那张凭据:只给站得住的那一档发,而且只此一份。 */
function writeHandoff(projectId: string, claim: string): void {
  try { session()?.setItem(HANDOFF_KEY(projectId), JSON.stringify({ claim, at: Date.now() })); } catch { /* 隐私模式 */ }
}
const dropHandoff = (projectId: string): void => {
  try { session()?.removeItem(HANDOFF_KEY(projectId)); } catch { /* 隐私模式 */ }
};

/**
 * 取走凭据(一次性)。认下来就说明「这一页刷新过，而且刷新之前它就是站得住的那个正主」。
 *
 * 两条都得过:**这一份文档是刷新出来的**，而且**读到就删、认不认都删**。缺哪一条都能被克隆出
 * 几个正主来(见文件头第 11 轮审查那一段)——尤其是「认不认都删」:留着的话，克隆页自己刷新
 * 一下就把它洗成了「刷新出来的」。
 */
function takeHandoff(projectId: string, claim: string): boolean {
  const store = session();
  if (!store) return false;
  let raw: string | null = null;
  try { raw = store.getItem(HANDOFF_KEY(projectId)); } catch { return false; }
  if (!raw) return false;
  dropHandoff(projectId);
  if (!cameFromReload()) return false;
  try {
    const baton = JSON.parse(raw) as { claim?: unknown; at?: unknown };
    return baton?.claim === claim && typeof baton.at === "number" && Date.now() - baton.at < HANDOFF_MS;
  } catch { return false; }
}

let reloaded: boolean | undefined;
/**
 * 这一份文档是不是**同一个标签刷新**出来的（导航类型 "reload"）。
 *
 * `window.open`、复制标签、会话恢复都不是刷新 —— 它们是并发分身或历史恢复，各自克隆了一份
 * 存储。取不到这条信息就按「不是」算：那只是退回「把脚本摆出来让用户拍板」，不会认错人。
 */
function cameFromReload(): boolean {
  if (reloaded !== undefined) return reloaded;
  try {
    const entries = globalThis.performance?.getEntriesByType?.("navigation") as { type?: string }[] | undefined;
    reloaded = entries?.[0]?.type === "reload";
  } catch { reloaded = false; }
  return reloaded;
}

let armed = false;
/** 挂上「这一页要走了」的钩子:站得住的所有权第一次落地时挂一次就够。 */
function armHandoff(): void {
  if (armed || typeof globalThis.addEventListener !== "function") return;
  armed = true;
  const wrote = new Set<string>();
  // pagehide 而不是 unload/beforeunload:刷新、关掉、跳走都会走到它，而且它是现在推荐的那一个。
  globalThis.addEventListener("pagehide", () => {
    for (const [projectId, held] of holds) {
      if (held.source === "provisional") continue; // 暂且认下的那一档不配发凭据
      writeHandoff(projectId, held.claim);
      wrote.add(projectId);
    }
  });
  // 进了 bfcache 又被恢复:文档没换过，凭据没人消费。留着它等于给之后复制出去的标签留了个后门。
  globalThis.addEventListener("pageshow", (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    for (const projectId of wrote) dropHandoff(projectId);
    wrote.clear();
  });
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

/** 降级路的点名:有人应答就是别人的;没人应答**暂且**算自己的（可撤回且不足以动输入框，见文件头）。 */
function askAround(projectId: string, claim: string, waitMs = 300): Promise<boolean> {
  const wire = channel();
  if (!wire) { holdAssistClaim(projectId, claim, "provisional"); return Promise.resolve(true); }
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
      // 静默不等于没有正主,所以这只是「暂且是我的」:够只读地跟着进度，不够改用户的输入框。
      holdAssistClaim(projectId, claim, "provisional");
      ask.settle(false);
    }, waitMs);
    wire.postMessage({ kind: "ask", projectId, claim } satisfies Note);
  });
}
