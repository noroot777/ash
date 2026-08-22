// 接力入站 body 的读取闸。
//
// 为什么单独一层:**签名覆盖 body 哈希,所以验签必须在读完整个 body 之后**——鉴权天然
// 排在缓冲之后,任何能连上端口的人都能靠一个巨大 body 把内存吃光,一个字节的签名都不用带。
// 这是身份校验做完之后,这条链上唯一还敞着的一环。
//
// 所以这里边读边计数,超了立刻掐掉连接,不等读完。content-length 报得过大的直接拒,
// 省掉一整趟传输;它可以撒谎或者根本不带(chunked),所以流式计数才是真正的闸,
// 头部检查只是省事的快路径。
//
// 上限还有一个**物理天花板**:body 最终要变成一个 JS 字符串(明文 manifest 直接转,
// 密文解开之后也是),而 Node 的字符串最长 MAX_STRING_LENGTH ≈ 512 MB。超过这个数在
// 读完之后必然抛一句「Cannot create a string longer than…」,用户完全看不懂。所以设置项
// 按 512 封顶,真正的字节闸再和 MAX_STRING_LENGTH 取小 —— 512 MiB 比它多 24 字节,
// 直接用会在最边上漏过去一点点。超限一律换成说人话的错误。
//
// 加密不改变这个上限:信封是二进制帧,密文按字节放,不再套一层 base64
// (见 handoff-crypto.ts 顶部),所以开不开加密能搬多大是一样的。
//
// 剩下的敞口如实记在这:并发的多个请求各自占一份内存,上限只管单个请求。真要防住
// 总量得在连接层限并发,那是整机的事,不该塞进接力里。
import { constants as bufferConstants } from "node:buffer";
import { HandoffError } from "./handoff-types.js";

/** 设置项允许的最大值(MB)。 */
export const MAX_BODY_MB = 512;

const MB = 1024 * 1024;

const tooBig = (limitMb: number): HandoffError =>
  new HandoffError(
    `接力载荷超过本机上限 ${limitMb} MB,已在读取过程中掐断(没有验签、什么都没落库)。`
    + `确实需要搬这么大的任务,就到目标机「设置 → 默认规则 → 接力载荷上限」调高(最高 ${MAX_BODY_MB} MB);`
    + "更常见的原因是 git 历史太大——先在两边把仓库同步到相近的提交,接力就只打增量包了。",
    413,
  );

/**
 * 读取请求体,超过上限就掐断并抛 413(带 ash 标记语义:确实什么都没落库)。
 * 返回**原始字节** —— 调用方拿它验签(哈希的必须是线上那串字节),再判断是明文还是
 * 加密信封。加密信封是二进制的,提前转字符串会把它毁掉。
 */
export async function readCappedBody(req: Request, limitMb: number): Promise<Buffer> {
  const effectiveMb = Math.min(limitMb, MAX_BODY_MB);
  const limit = Math.min(effectiveMb * MB, bufferConstants.MAX_STRING_LENGTH);
  const declared = Number(req.headers.get("content-length"));
  // 快路径:自报就超了,一个字节都不用收。
  if (Number.isFinite(declared) && declared > limit) throw tooBig(effectiveMb);
  const body = req.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // 主动取消:不把剩下的字节收完再拒,那样闸就形同虚设了。
      await reader.cancel().catch(() => { /* 对端已经断了 */ });
      throw tooBig(effectiveMb);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
