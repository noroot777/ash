// 输入框里「哪一下算发送」在**前端**的单点。
//
// 这一档存在服务端(AppSettings.composerSendKey,个人面:同一台机器上两个人各按各的
// 习惯),但判据必须在这里收口 —— 全站二十来个输入框,每个自己写一遍
// `(metaKey || ctrlKey) && key === "Enter"` 的话,改了这一档必有几个框跟不上,而
// 「有的框回车能发、有的不能」比两种都不支持更让人摸不着头脑。
//
// 这个文件**不 import `api.ts`**:它要被 api 层调(读到设置的那一刻把新档位交进来),
// 夹在中间才不会把那两个绕成环。那一次性的拉取在 `useComposerSendKey.ts` 里。
import type { ComposerSendKey } from "@ash/shared";
import { COMPOSER_SEND_KEYS, DEFAULT_APP_SETTINGS } from "@ash/shared";

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
 */
let current: ComposerSendKey | null = null;
const listeners = new Set<(mode: ComposerSendKey | null) => void>();

/**
 * 应答乱序的护栏。`/settings` 的读取点不止一处(工作台开场、设置页、技能清单、
 * 新建面板),**保存之前发出的那条 GET 完全可能在 PATCH 之后才回来**;无条件采纳
 * 的话,刚存好的「⌘/Ctrl+回车」会被那条旧应答悄悄换回去,用户下一个回车就把没写完
 * 的任务发出去了(第 1 轮审查问题 1)。
 *
 * 所以按**发请求的先后**定胜负:api 层在发出之前取号,应答回来时带着它,号比已采纳
 * 的小就直接丢掉。用「发出顺序」而不是「回来顺序」,是因为用户最后那一下点击对应的
 * 必然是最后发出的那条请求。
 */
let issued = 0;
let applied = 0;

/** api 层在**发出请求之前**取号。 */
export const nextSettingsTicket = (): number => ++issued;

/** 当前这一档;`null` = 还没学到。事件处理里直接调它,每次按键都读一次。 */
export const composerSendKey = (): ComposerSendKey | null => current;

/** 写提示文案时用:未知期间先按出厂默认念(这段窗口只有一次本机请求那么长)。 */
export const displaySendKey = (): ComposerSendKey => current ?? DEFAULT_APP_SETTINGS.composerSendKey;

/**
 * 学到一份新的设置。**变了才通知**,所以可以在每次读 `/settings` 时无脑调一次
 * (钉在 `api.ts` 的 adopt 里,跟 hostCliPolicy 同一个理由:学到这一档的路只有
 * `/settings` 那两条,放在调用点迟早漏)。
 *
 * `ticket` 省略时取一个最新的号 —— 意思是「这是此刻最新的一句话」,给不经过 api 层
 * 的直接设定用(测试台、下面那个兜底)。走 api 的一律把发请求前取的号传进来。
 */
export function syncComposerSendKey(next: ComposerSendKey, ticket = nextSettingsTicket()): void {
  if (!isSendKey(next) || ticket < applied) return;
  applied = ticket;
  if (next === current) return;
  current = next;
  for (const notify of listeners) notify(next);
}

/**
 * `/settings` 实在读不到时的兜底:认出厂默认,别把裸回车无限期地锁成换行。
 *
 * 只在重试用尽之后调(useComposerSendKey.ts)。到那一步整台服务端多半已经不应答了,
 * 「回车发不出去」只会被当成又一处坏掉的地方,不如回到出厂行为。
 *
 * **故意不走 `syncComposerSendKey`,也就不动 `applied`**:这只是「等不到就先按出厂的
 * 来」,不是一句权威答复。占了号的话,别处那条还在路上的读取(设置页、新建面板各有
 * 一条,它们的号更小)回来时会被当成过期货丢掉 —— 服务端明明答了,用户的那一档却要等
 * 到下一次读取才生效。
 */
export function settleComposerSendKeyDefault(): void {
  if (current !== null) return;
  current = DEFAULT_APP_SETTINGS.composerSendKey;
  for (const notify of listeners) notify(current);
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
} {
  return mode === "mod-enter"
    ? { send: "⌘ / Ctrl + Enter", sendShort: "⌘↵", newline: "Enter" }
    : { send: "Enter", sendShort: "↵", newline: "Shift Enter" };
}
