// 卡片上「在 Navi 中打开」那条链接在这台机器上走不走得通。
//
// 链接本身是 `<卡片深链地址>/?project=&task=`（cards.ts taskLink），能不能打开取决于这份服务听在哪：
// 以本机自用模式起的（NAVI_LOCAL_ONLY，mac 版默认）只听 127.0.0.1，手机、别的电脑连端口都连不上，
// 地址填得再对也打不开 —— 设置页和保存时据此就地说一句（不拒存：开关一打开它就能用了）。
//
// mac 版另给桌面端飞书一条 `navi://open?project=&task=`（Navi.app 注册了这个 scheme，收到就把窗口
// 拉到前面、打开那个任务），放在按钮的 `pc_url` 上；手机端仍走 http（`default_url`）。飞书文档写明
// pc_url 支持 AppLink、没说第三方 scheme 支持与否，所以只在 app 起的那份服务上给。
import { isLoopbackHost } from "../auth/remote-access.js";
import { DESKTOP_APP, LOCAL_ONLY } from "../local-only.js";

/** 深链地址在这台服务上为什么打不开（说给设置页看）；没问题是 null。 */
export function deepLinkWarning(base: string | null, env = { localOnly: LOCAL_ONLY, desktopApp: DESKTOP_APP }): string | null {
  if (!base) return null;
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    return null;
  }
  if (isLoopbackHost(host)) return "这是本机地址，只有这台电脑打得开；手机上点卡片的按钮打不开。";
  if (!env.localOnly) return null;
  return env.desktopApp
    ? "这台 Navi 现在只允许本机访问，手机和别的电脑打不开这个地址。在 Navi.app 菜单「Navi › 允许其他设备访问」里打开之后就能用。"
    : "这份服务以本机自用模式（NAVI_LOCAL_ONLY）启动、只听 127.0.0.1，手机和别的电脑打不开这个地址。";
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** 桌面端飞书用的那条 `navi://`；不是 app 起的服务、或者链接不是任务链接时是 null。 */
export function desktopAppLink(url: string, desktopApp = DESKTOP_APP): string | null {
  if (!desktopApp) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const out = new URLSearchParams();
  for (const key of ["project", "task"]) {
    const value = parsed.searchParams.get(key);
    if (value === null) continue;
    if (!ID_RE.test(value)) return null;
    out.set(key, value);
  }
  return out.has("project") ? `navi://open?${out}` : null;
}
