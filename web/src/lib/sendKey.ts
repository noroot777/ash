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

// 本地镜像。**不是**缓存,是为了**第一下回车不出错**:这一档住在服务端,而 `/settings`
// 回来之前页面已经可以打字了。没有镜像的话,选了「⌘+回车发送」的人每次刷新都有一个
// 窗口期,随手一个回车就把半句话发出去 —— 发送不可撤销,比多存一个键贵得多。
const MIRROR_KEY = "ash:composer-send-key";

const isSendKey = (value: unknown): value is ComposerSendKey =>
  typeof value === "string" && (COMPOSER_SEND_KEYS as readonly string[]).includes(value);

function readMirror(): ComposerSendKey {
  try {
    const saved = window.localStorage.getItem(MIRROR_KEY);
    if (isSendKey(saved)) return saved;
  } catch { /* 隐私模式下读不到:用出厂默认 */ }
  return DEFAULT_APP_SETTINGS.composerSendKey;
}

let current = readMirror();
const listeners = new Set<(mode: ComposerSendKey) => void>();

/** 当前这一档。事件处理里直接调它 —— 每次按键都读一次,所以永远是最新的。 */
export const composerSendKey = (): ComposerSendKey => current;

/**
 * 学到一份新的设置。**变了才通知**,所以可以在每次读 `/settings` 时无脑调一次
 * (钉在 `api.ts` 的 adopt 里,跟 hostCliPolicy 同一个理由:学到这一档的路只有
 * `/settings` 那两条,放在调用点迟早漏)。
 */
export function syncComposerSendKey(next: ComposerSendKey): void {
  if (!isSendKey(next) || next === current) return;
  current = next;
  try { window.localStorage.setItem(MIRROR_KEY, next); }
  catch { /* 存不下就只在本轮生效 */ }
  for (const notify of listeners) notify(next);
}

/** 订阅翻面(提示文案要跟着改)。返回退订函数。 */
export function onComposerSendKeyChange(listener: (mode: ComposerSendKey) => void): () => void {
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
 *
 * 补全菜单(`/` 技能、`@` 文件、@成员)开着时**先问它们**:那一下回车是「选中这条」。
 * 现有调用点都是先让菜单处理、它说没吃掉才轮到这里,顺序别倒。
 */
export function isSendKeyEvent(event: SendKeyEventLike): boolean {
  if (event.key !== "Enter" || composing(event)) return false;
  if (event.shiftKey || event.altKey) return false;
  return current === "enter" || event.metaKey || event.ctrlKey;
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
export function sendKeyLabels(mode: ComposerSendKey = current): {
  send: string;
  sendShort: string;
  newline: string;
} {
  return mode === "mod-enter"
    ? { send: "⌘ / Ctrl + Enter", sendShort: "⌘↵", newline: "Enter" }
    : { send: "Enter", sendShort: "↵", newline: "Shift Enter" };
}
