// 「本机自用」启动开关（`ASH_LOCAL_ONLY=1`）的单点。独立打包的 app 带着它起 server。
//
// 打开之后三件事一起成立，缺一件都不叫「只给坐在这台机器前的人用」：
//   · 只监听 127.0.0.1 —— 别的机器连端口都连不上，不靠鉴权兜底；
//   · 实例模式固定为自用：首启直接落成 single，转多人一律拒绝（库已经是多人的就拒绝启动，
//     多人数据转不回自用，见 auth/mode.ts）；
//   · 远程设备配对 / 访问密钥那一整套入口关掉（端点答 403，`AuthState.localOnly` 让 web 把
//     对应的页和卡片都藏起来）。
// 不开时以上全部照旧，多人能力一点不少。
export const LOCAL_ONLY = process.env.ASH_LOCAL_ONLY === "1";
// 读完就从本进程环境里拿掉：agent 在某个 ash 检出里起的验证用 server 不该悄悄继承这个开关。
delete process.env.ASH_LOCAL_ONLY;

export const LOCAL_ONLY_HOSTNAME = "127.0.0.1";

export const LOCAL_ONLY_REFUSAL = "这台 ash 以本机自用模式启动（ASH_LOCAL_ONLY），不提供远程配对、多人和邀请";
