// 输入框里「哪一下算发送」在**前端**的单点。
//
// 这一档存在服务端(AppSettings.composerSendKey,个人面:同一台机器上两个人各按各的
// 习惯),但判据必须在这里收口 —— 全站二十来个输入框,每个自己写一遍
// `(metaKey || ctrlKey) && key === "Enter"` 的话,改了这一档必有几个框跟不上,而
// 「有的框回车能发、有的不能」比两种都不支持更让人摸不着头脑。
//
// 这个文件只管**语义**(哪一下算发送、提示怎么念),不管「哪份应答算数」—— 那是
// `settingsSync.ts` 的事,它按「写比读权威」挑出该采纳的那一份再喂进来。
//
// 这个文件**不 import `api.ts`**:它要被 api 那条链调(读到设置的那一刻把新档位交进来),
// 夹在中间才不会把那两个绕成环。那一次性的拉取在 `useComposerSendKey.ts` 里。
import type { ComposerSendKey } from "@ash/shared";
import { COMPOSER_SEND_KEYS } from "@ash/shared";

const isSendKey = (value: unknown): value is ComposerSendKey =>
  typeof value === "string" && (COMPOSER_SEND_KEYS as readonly string[]).includes(value);

/**
 * `null` = **还没学到**(页面刚起、`/settings` 还在路上)。这一档一定要跟「已经知道
 * 是 enter」分开记:
 *
 *  · 两者行为不同 —— 未知期间**裸回车一律当换行**。发送不可撤销,而这一档的两种取值
 *    对裸回车的解读正好相反;猜错一次的代价是「半句话被发出去」,猜对一次只省下用户
 *    一个 Shift。带 ⌘/Ctrl 的回车不受影响:**两档下它都是发送**,没有歧义。
 *  · 这里曾经用 localStorage 存过一份镜像当「上一次那一档」来顶这段窗口。已经撤掉:
 *    同源下它是所有账号共用的一个键(多人模式里是**别人的**偏好),而且迟到的
 *    `/settings` 应答还会把过期值写回去,于是一次抖动能影响到后面每一次刷新。
 *    窗口本来就只有一次本机请求那么长,不值得用一份跨账号的猜测去填。
 *  · 也**不拿出厂默认兜底**(「读了几次都失败就当 enter」那版已经撤掉):读设置失败
 *    不等于发消息也失败 —— 第 2 轮审查实测,设置 GET 全部 503 时任务照样建得出来,
 *    于是那个兜底把一个没人选过的档位变成了真实的发送行为。读不到就一直保持换行,
 *    发送按钮和 ⌘/Ctrl+回车都还在,没有谁被挡住。
 */
let current: ComposerSendKey | null = null;
const listeners = new Set<(mode: ComposerSendKey | null) => void>();

/** 当前这一档;`null` = 还没学到。事件处理里直接调它,每次按键都读一次。 */
export const composerSendKey = (): ComposerSendKey | null => current;

/**
 * 写提示文案时用。未知期间念的是 `mod-enter` —— 那正是此刻**真正在生效**的规矩
 * (裸回车换行、⌘/Ctrl+回车发送),不是猜一个出厂默认顶上去。
 *
 * 代价是:绝大多数人(用默认档)每次开页会看到提示从「⌘ / Ctrl + Enter 发送」跳成
 * 「Enter 发送」。那一跳只有一次本机请求那么长,而反过来——先写着「Enter 发送」、
 * 按下去却是换行——是在教用户一件不成立的事。
 */
export const displaySendKey = (): ComposerSendKey => current ?? "mod-enter";

/**
 * 学到一份新的设置。**变了才通知**。
 *
 * 调用方只有 `settingsSync.ts`(以及测试台):哪份应答算数由它判,这里收到的一律当成
 * 「此刻的真相」。
 */
export function syncComposerSendKey(next: ComposerSendKey): void {
  if (!isSendKey(next) || next === current) return;
  current = next;
  for (const notify of listeners) notify(next);
}

/** 订阅翻面(提示文案要跟着改)。返回退订函数。 */
export function onComposerSendKeyChange(listener: (mode: ComposerSendKey | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 够用的按键事件形状:React 的合成事件把 `isComposing` 只挂在 `nativeEvent` 上,
 * 原生事件则直接带着它 —— 两种都收,调用点不必各自摊平。
 */
export interface SendKeyEventLike {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

const composing = (event: SendKeyEventLike): boolean =>
  event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229;

/**
 * 这一下回车算「发送」吗。装在**输入框自己**的 onKeyDown 上。
 *
 * 两档共同的否决项:输入法正在选词(那个回车是「选这个词」)、Shift/Alt+回车(那是
 * 换行)。差别只在要不要修饰键:
 *  · `enter`     裸回车就发;**⌘/Ctrl+回车照旧也发** —— 从另一档切过来的人肌肉记忆
 *                不白废,而且这一档下按住 ⌘ 敲回车本来什么也不会发生。
 *  · `mod-enter` 只有 ⌘/Ctrl+回车发,裸回车留给换行。
 *  · 还没学到    按 `mod-enter` 那一套办(裸回车当换行),理由见 `current` 的注释。
 *
 * 补全菜单(`/` 技能、`@` 文件、@成员)开着时**先问它们**:那一下回车是「选中这条」。
 * 现有调用点都是先让菜单处理、它说没吃掉才轮到这里,顺序别倒。
 */
export function isSendKeyEvent(event: SendKeyEventLike): boolean {
  if (event.key !== "Enter" || composing(event)) return false;
  if (event.shiftKey || event.altKey) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return current === "enter";
}

/**
 * 卡片/对话框级的「这一下回车是提交」。跟 `isSendKeyEvent` 的区别是它要照顾
 * **事件从谁身上冒上来的**:
 *  · 里面的输入框已经自己处理掉了(补全菜单选中一条),就别再提交一次 —— 看
 *    `defaultPrevented`。
 *  · 按钮、链接、下拉自带回车语义,抢过来会变成「既选中又提交」;单行输入里的回车
 *    归它所在的表单。所以裸回车只认多行输入;带修饰键则摆明了是「提交」,不问来源。
 */
export function isSubmitKeyEvent(
  event: SendKeyEventLike & { defaultPrevented?: boolean; target?: unknown },
): boolean {
  if (event.defaultPrevented || !isSendKeyEvent(event)) return false;
  if (event.metaKey || event.ctrlKey) return true;
  const target = event.target;
  return target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

/**
 * 提示文案里这两个键怎么念。界面上到处都写着「⌘↵ 发送」,它必须跟着这一档变 ——
 * 否则用户会照着一个不成立的提示去按。
 *  · `send`      长形:「Enter」/「⌘ / Ctrl + Enter」
 *  · `sendShort` 短形:「↵」/「⌘↵」(挤在按钮或状态条里的那些)
 *  · `newline`   换行怎么按
 */
export function sendKeyLabels(mode: ComposerSendKey = displaySendKey()): {
  send: string;
  sendShort: string;
  newline: string;
  /** `aria-keyshortcuts` 的取值 —— 读屏念给人听的那串,同样不能停在写死的 Enter 上。 */
  ariaShortcut: string;
} {
  return mode === "mod-enter"
    ? { send: "⌘ / Ctrl + Enter", sendShort: "⌘↵", newline: "Enter", ariaShortcut: "Meta+Enter Control+Enter" }
    : { send: "Enter", sendShort: "↵", newline: "Shift Enter", ariaShortcut: "Enter" };
}
