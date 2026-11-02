// 门禁日志的**一次有界观测**：一个 fd、一次 fstat 定下截止、只读这个截止之内的那一段。
//
// 由来（第 4 轮审查 F1）：看门狗原先在同一拍里分三次读这份文件 —— `statSync` 定「有没有
// 输出过 / 静了多久」，`acceptGateLogTailBytes` 再读一遍取末行，最后又 `statSync` 一次取
// 字节数。命令的 stdout 直接接在这份文件的 fd 上，**不受 JS 同步调用栈保护**：它只要插在
// 第一次 stat 之后、读末行之前写下第一行，同一份现场就会一边说「停在 X、累计 26B」，一边说
// 「它从头到尾没写过东西」—— 一句话里给出两个相反的排查方向。补几条文本排除堵不住它，
// 因为错的不是某一种措辞，是**裁定消费了几个不同时刻的事实**。
//
// 所以裁定要消费的不是「这个文件现在怎么样」，而是一次观测：
//  · 一个 fd —— 中途被换掉/删掉/重建不会被当成同一份文件（`identity` = dev:ino）
//  · 一次 fstat 定下 `length` —— 这就是这次观测的截止，之后到的字节属于**下一次**观测，
//    不许用来补齐这一次的裁定
//  · 只读 `[length - tailBytes, length)` —— 末行、字节数、写没写过、时间全在这个范围里算
//
// 读不成功一律返回 null，由上面决定怎么说「未知」：**不许**退化成「它没输出过」——
// 日志读不出来和命令没输出是两件事，混成一句会把人支去查错的方向。
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** 一次有界观测的全部内容。同一份 `GateLogSighting` 里的字段互相自洽，可以放心混用。 */
export type GateLogSighting = {
  /** 这次观测的截止长度（字节）。 */
  length: number;
  /** 文件身份 `dev:ino`。两次观测身份不同 = 不是同一份日志，长度不可比。 */
  identity: string;
  /** 文件最后修改时间（墙上时间）；读不到是 0。 */
  mtimeMs: number;
  /** 截止长度之内的末尾若干字节。 */
  tail: Buffer;
  /** `tail` 的第一个字节在文件里的偏移。 */
  tailStart: number;
};

/**
 * 观测一次。`tailBytes` 是这次要捎带读回来的尾巴长度（末行就从它里面找）。
 *
 * 要么交出一份**完整覆盖 `[tailStart, length)` 的观测**，要么返回 null。中间状态（fstat
 * 看见 10000B、真读的时候只剩 0B）不许拼成一份「小一点但看着正常」的观测交出去。
 */
export function sightGateLog(logPath: string, tailBytes: number): GateLogSighting | null {
  let fd: number | null = null;
  try {
    fd = openSync(logPath, "r");
    const info = fstatSync(fd);
    const identity = `${info.dev}:${info.ino}`;
    const tailStart = Math.max(0, info.size - Math.max(0, tailBytes));
    const buf = Buffer.alloc(Math.max(0, info.size - tailStart));
    let read = 0;
    while (read < buf.length) {
      const got = readSync(fd, buf, read, buf.length - read, tailStart + read);
      // 读不满 = 文件在 fstat 之后被截短了。**这一拍整个作废**，不许把截止收窄成一份
      // 「长度 2000、尾巴 0 字节」的合成观测交出去（第 5 轮审查 F1 采集端）：那个截止从来
      // 没有真实存在过，调用方拿它跟 base 比长度也识别不出来，于是一份凭空的事实就进了裁定。
      if (got <= 0) return null;
      read += got;
    }
    return { length: info.size, identity, mtimeMs: info.mtimeMs, tail: buf, tailStart };
  } catch { return null; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* 关不上也只是个 fd */ } } }
}
