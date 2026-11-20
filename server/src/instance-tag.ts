// 本机实例的短指纹：主机名 + 库文件路径，跨重启不变（每个进程都换的是 instance-binding.ts 的实例号）。
// 两处用它认「是不是同一份 Navi」：飞书「实例已上线」消息里看出两台机器连了同一个应用；卡片上的
// navi:// 链接带着它，收到链接的 Navi.app 比对自己那份服务报的指纹，对不上就不在自己窗口里打开
// （im/app-link.ts、desktop/macos/Sources/DeepLink.swift）。
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { resolveNaviDbFile } from "./db/path.js";

export const instanceTag = (): string =>
  createHash("sha256").update(`${hostname()}\n${resolveNaviDbFile()}`).digest("hex").slice(0, 8).toUpperCase().replace(/^(.{4})/, "$1-");
