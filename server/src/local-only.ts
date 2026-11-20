// mac 版 Navi.app 起 server 时带的两个开关的单点。它们管的是两件不相干的事，所以分开：
//
// `NAVI_DESKTOP_APP=1`：「这份服务是 Navi.app 起的那一份」。
//   · health 里报出来（`instance.desktop`），app 据此认出端口上是不是自家那份；
//   · 在 4317 之外再听 app 窗口专用的端口（window-port.ts）；
//   · 实例模式固定为自用：首启直接落成 single，转多人一律拒绝（库已经是多人的就拒绝启动，
//     多人数据转不回自用，见 auth/mode.ts）。
//
// `NAVI_LOCAL_ONLY=1`：网络暴露面收到「只给坐在这台机器前的人用」。
//   · 只监听 127.0.0.1 —— 别的机器连端口都连不上，不靠鉴权兜底；
//   · 远程设备配对 / 访问密钥那一整套入口关掉（端点答 403，`AuthState.localOnly` 让 web 把
//     对应的页和卡片都藏起来）；
//   · 自用模式同样固定（只有本机进得来，多人无从谈起）。
// app 默认两个都带；用户在 app 菜单里打开「允许其他设备访问」后只带前一个：服务照常是 app
// 那一份，网络这一侧回到普通的自用实例（全网卡监听、配对与访问密钥可用）。都不带时多人能力一点不少。
import { clearEnv, readEnv } from "@navi/shared/env-names";
export const LOCAL_ONLY = readEnv(process.env, "NAVI_LOCAL_ONLY") === "1";
export const DESKTOP_APP = readEnv(process.env, "NAVI_DESKTOP_APP") === "1";
// 读完就从本进程环境里拿掉：agent 在某个 navi 检出里起的验证用 server 不该悄悄继承这两个开关。
clearEnv(process.env, "NAVI_LOCAL_ONLY");
clearEnv(process.env, "NAVI_DESKTOP_APP");

/** 实例模式固定为自用。 */
export const SINGLE_ONLY = LOCAL_ONLY || DESKTOP_APP;

export const LOCAL_ONLY_HOSTNAME = "127.0.0.1";

export const LOCAL_ONLY_REFUSAL = "这台 Navi 以本机自用模式启动（NAVI_LOCAL_ONLY）：只接受本机直连，不提供远程配对、多人和邀请";

/** 转多人被拒时说的那句：本机模式按上面那句说，app 放开了网络的按 app 说。 */
export const SINGLE_ONLY_REFUSAL = LOCAL_ONLY ? LOCAL_ONLY_REFUSAL : "这台 Navi 是 Navi.app 的个人自用版：没有多人和邀请";
