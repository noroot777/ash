// 界面配色在前端的单点：用户选的那一档(跟随系统 / 浅色 / 深色)→ 页面根上的
// `data-theme="light|dark"`。全站颜色都从 `styles/global.css` 的变量取，深色那套
// 是挂在 `:root[data-theme="dark"]` 上的一组覆盖值，这里只负责把开关拨到位。
//
// 这一档存在服务端(AppSettings.colorTheme,个人面),但**首屏等不起那一个来回**:
// 先按浅色画出来、`/settings` 回来再翻成深色，就是每次打开都闪一下白。所以本机另存一份
// 镜像，`index.html` 里那段同步脚本在第一帧之前就照它拨好开关(那段脚本与这里共用
// STORAGE_KEY 和判据，改一边要看另一边)。
//
// 发送键那一档刻意不用 localStorage 镜像(见 sendKey.ts):同源下它是所有账号共用的,
// 猜错的代价是把半句话发出去。配色猜错的代价只是**上一个人的深浅色多亮一瞬**,
// `/settings` 一到就按这个人自己的那份改正，所以这里值得用镜像换掉每次的闪白。
//
// 这个文件**不 import `api.ts`**:它被 settingsSync 调(读到设置的那一刻交进来),
// 跟 sendKey.ts 一样夹在中间才不会绕成环。
import type { ColorTheme } from "@ash/shared";
import { COLOR_THEMES } from "@ash/shared";

export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "ash.colorTheme";

const isColorTheme = (value: unknown): value is ColorTheme =>
  typeof value === "string" && (COLOR_THEMES as readonly string[]).includes(value);

function readCached(): ColorTheme {
  try {
    const cached = window.localStorage.getItem(STORAGE_KEY);
    return isColorTheme(cached) ? cached : "system";
  } catch {
    // 隐私模式下读 localStorage 会抛：当作没存过，跟随系统。
    return "system";
  }
}

// 服务端渲染的测试脚本会顺着组件把这里一起 import 进去(那边没有 window/document):
// 没有页面就没有开关可拨，模块只当一份偏好存着，下面那些挂监听、首次上色都跳过。
const inBrowser = typeof window !== "undefined";

const media = inBrowser && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;

let preference: ColorTheme = readCached();
const listeners = new Set<() => void>();

const resolve = (pref: ColorTheme): ResolvedTheme =>
  pref === "system" ? (media?.matches ? "dark" : "light") : pref;

/** 用户选的那一档。 */
export const colorTheme = (): ColorTheme => preference;

/** 此刻页面实际是深是浅(「跟随系统」已经按系统解析过)。 */
export const resolvedTheme = (): ResolvedTheme => resolve(preference);

function paint(): void {
  const root = document.documentElement;
  const resolved = resolve(preference);
  root.dataset.theme = resolved;
  // 原生控件(滚动条、日期选择器、select 的下拉)按它画自己那一套。
  root.style.colorScheme = resolved;
  // 浏览器标签栏 / PWA 标题栏的底色跟着页面的外壳色走，从样式里现读而不是在这里另抄
  // 一份色值 —— 抄的那份迟早会和 global.css 对不上。
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const chrome = toHex(getComputedStyle(root).getPropertyValue("--chrome").trim());
  if (meta && chrome) meta.content = chrome;
  for (const notify of listeners) notify();
}

/**
 * 变量里写的是 `lch(...)`,theme-color 不保证认得 —— 画一个像素让浏览器换算成 sRGB,
 * 写回去的就是和 index.html 那段脚本同一种十六进制。
 */
function toHex(color: string): string | null {
  if (!color) return null;
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 学到一份新的偏好。**变了才重画**。调用方是 `settingsSync.ts`(读到设置、或用户刚选完
 * 还在保存途中 —— 选完立刻生效，不等往返)。
 */
export function syncColorTheme(next: ColorTheme): void {
  if (!isColorTheme(next)) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 存不进去只是下次开页可能闪一下，不影响这一次。
  }
  if (next === preference) return;
  preference = next;
  paint();
}

/** 订阅翻面。返回退订函数。 */
export function onColorThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 「跟随系统」时系统翻面(日落自动切换)页面也跟着翻；钉死的两档不受影响 —— paint
// 按 preference 解析，钉死时 media 怎么变结果都一样。
media?.addEventListener("change", paint);

if (inBrowser) {
  // 另一个标签页里换了配色，这里跟着翻：那边换档时会写这份镜像，而 storage 事件只发给
  // **别的**标签页。同源同 cookie,两个标签页一定是同一个人，镜像就是他刚选的那一档。
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || !isColorTheme(event.newValue) || event.newValue === preference) return;
    preference = event.newValue;
    paint();
  });

  // 模块一加载就按镜像拨一次：index.html 那段脚本已经拨过的话这是空操作，没拨过的入口
  // (测试台、将来别的 html)也不会停在「没有 data-theme」的半截状态。
  paint();
}
