// 「这个 claim 现在还在谁手里」——同源页面之间的一次点名。
//
// 为什么非要点名:作业所有权记在 `sessionStorage`(见 previewAssistMemory.ts),而 sessionStorage
// **不是每个新标签都从空的开始**。带 opener 打开的页面(`window.open`、`target=_blank`)和「复制
// 标签页」都会拿到来源页面那一份的**初始副本**,之后两份才各走各的。于是那个从没点过按钮的新
// 页面手里也有了一份跟服务端作业对得上的 claim,成功时照样把自己的输入框改掉,还说「脚本已填入」
// (第 7 轮审查复现;第 6 轮那条双标签回归用的是 `context.newPage()`,没有 opener,正好绕过了
// 这种复制语义)。
//
// 光看存储里那串 claim 分不出正主和副本 —— 两边一模一样。唯一分得开的是**同一时刻还有没有另一个
// 活着的页面拿着它**:
//   · 刷新 → 旧文档先销毁、它的频道跟着关掉,没人应答 → 这一页接着算自己的(第 6 轮要的
//     「刷新还在」不能因为这次修复丢掉)
//   · 复制 / window.open → 来源页面还活着,它会应答 → 新页面就此知道自己是副本,放弃这条记录
//
// BroadcastChannel 不会把消息投回给发送方自己,所以「自己应答自己」这种事不会发生。
// 拿不到 BroadcastChannel 的环境(隐私模式抛异常、老 webview)只能答「没别人」,也就是退回修复
// 之前的行为:宁可多认一份,也不能让刷新之后正主自己都认不出来。
const CHANNEL = "ash:preview-assist-claims";

type Note =
  | { kind: "ask"; projectId: string; claim: string; from: string }
  | { kind: "held"; projectId: string; claim: string; to: string };

/** 这一页自认持有的 claim,按项目一格(应答点名时比的就是它)。 */
const holds = new Map<string, string>();
/** 正在等应答的点名,按发起方 id。 */
const waiting = new Map<string, (held: boolean) => void>();
let bus: BroadcastChannel | null | undefined;

function channel(): BroadcastChannel | null {
  if (bus !== undefined) return bus;
  try {
    const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    bus = Ctor ? new Ctor(CHANNEL) : null;
  } catch { bus = null; }
  bus?.addEventListener("message", (event: MessageEvent) => {
    const note = event.data as Note | null;
    if (note?.kind === "ask") {
      if (holds.get(note.projectId) === note.claim) {
        bus?.postMessage({ kind: "held", projectId: note.projectId, claim: note.claim, to: note.from } satisfies Note);
      }
      return;
    }
    if (note?.kind === "held") waiting.get(note.to)?.(true);
  });
  return bus;
}

/**
 * 这一页认下(或放下)一个 claim。别的页面点名时应答的就是这份登记。
 *
 * 登记跟本地那条追踪记录同生同死(previewAssistMemory.ts 的三个写入口各调一次):记录一抹掉就
 * 不再应答 —— 之后从这一页复制出去的标签本来也继承不到什么。
 */
export function holdAssistClaim(projectId: string, claim: string | null): void {
  if (claim) { holds.set(projectId, claim); channel(); } else holds.delete(projectId);
}

/** 点名:同源还有别的活着的页面拿着这个 claim 吗。有人应答就立刻返回,没人就等到超时。 */
export function assistClaimHeldElsewhere(projectId: string, claim: string, waitMs = 300): Promise<boolean> {
  const bus = channel();
  if (!bus) return Promise.resolve(false);
  const from = `ask-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (held: boolean) => {
      if (!waiting.delete(from)) return;
      if (timer !== undefined) clearTimeout(timer);
      resolve(held);
    };
    waiting.set(from, settle);
    timer = setTimeout(() => settle(false), waitMs);
    bus.postMessage({ kind: "ask", projectId, claim, from } satisfies Note);
  });
}
