// 卡片上「在 Navi 中打开」那条链接在这台机器上走不走得通。
//
// 链接本身是 `<卡片深链地址>/?project=&task=`（cards.ts taskLink），能不能打开取决于这份服务听在哪：
// 以本机自用模式起的（NAVI_LOCAL_ONLY，mac 版默认）只听 127.0.0.1，手机、别的电脑连端口都连不上，
// 地址填得再对也打不开 —— 设置页和保存时据此就地说一句（不拒存：开关一打开它就能用了）。
//
// mac 版只听本机时，另给桌面端飞书一条 `navi://open?...`（Navi.app 注册了这个 scheme），放在按钮的
// `pc_url` 上；手机端仍走 http（`default_url`）。发卡的服务判断不了收卡的是哪台电脑、装没装 app、
// 那份 app 连的是不是这一份 Navi，所以两条约束：
//   · 只在 http 在别的电脑上一律打不开时才给（app 起的服务、只听本机）：这时 navi:// 只可能让本机
//     那一台变好，别的电脑本来就打不开，不会更糟。放开了别的设备访问，http 打不打得开只看网络通不通、
//     和装没装 app 无关，就不再给 —— 否则没装 app、或装着的 app 连着别的 Navi 的电脑反倒打不开。
//   · 链接自带来源：这份服务的指纹（instance-tag.ts）和原来那条 http 地址。Navi.app 收到后比对自己
//     那份服务报的指纹，对上才在窗口里打开，对不上（连着别的 Navi）就把 http 地址交给浏览器，
//     不在别的工作台里打开一个同号的任务（desktop/macos/Sources/DeepLink.swift）。
// 飞书文档写明 pc_url 支持 AppLink、没说第三方 scheme 支持与否，真飞书桌面端点没点得开没验证过。
//
// 这条决定是起服务那一下定的（两个开关、指纹都是进程级常量），可卡片会被存下来、跨重启一直留在飞书上。
// 所以「会改变链接输出的一切」汇成一个 linkPolicy()：渲染出口（cards.ts openUrl）照它出链接，决策卡的
// 渲染指纹（reconcile.ts renderKeyOf）把它算进去，库里存着的所有卡在它变了之后按它重写（relink.ts）。
// 改了 desktopAppLink 的输出格式就把 LINK_FORMAT 加一，存着的旧格式卡才会被认出来、换掉。
import { isLoopbackHost } from "../auth/remote-access.js";
import { instanceTag } from "../instance-tag.js";
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
const LINK_FORMAT = 2;

/** 链接策略的指纹：同一个值 = 同一条 http 地址渲染出的按钮一模一样。 */
export function linkPolicy(env = { localOnly: LOCAL_ONLY, desktopApp: DESKTOP_APP }, tag: () => string = instanceTag): string {
  return env.desktopApp && env.localOnly ? `${LINK_FORMAT}:navi:${tag()}` : `${LINK_FORMAT}:http`;
}

/** 桌面端飞书用的那条 `navi://`；不该给（见文件头）、或者链接不是任务链接时是 null。 */
export function desktopAppLink(
  url: string,
  env = { localOnly: LOCAL_ONLY, desktopApp: DESKTOP_APP },
  tag: () => string = instanceTag,
): string | null {
  if (!env.desktopApp || !env.localOnly) return null;
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
  if (!out.has("project")) return null;
  out.set("instance", tag());
  out.set("fallback", url);
  return `navi://open?${out}`;
}
