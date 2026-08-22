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
// 上限还有一个**物理天花板**:body 最终要变成一个 JS 字符串,而 Node 的字符串最长
// 512MB(buffer.constants.MAX_STRING_LENGTH)。超过这个数在读完之后必然抛一句
// 「Cannot create a string longer than…」,用户完全看不懂。所以设置项按 512 封顶,
// 超限一律换成说人话的错误。
//
// 剩下的敞口如实记在这:并发的多个请求各自占一份内存,上限只管单个请求。真要防住
// 总量得在连接层限并发,那是整机的事,不该塞进接力里。
import { HandoffError } from "./handoff-types.js";

/** JS 字符串的物理上限,body 再大也变不成字符串。设置项不许超过它。 */
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
 * 读取请求体,超过 `limitMb` 就掐断并抛 413(带 ash 标记语义:确实什么都没落库)。
 * 返回 utf8 文本 —— 调用方拿它验签,再决定要不要解密/解析。
 */
export async function readCappedText(req: Request, limitMb: number): Promise<string> {
  const limit = Math.min(limitMb, MAX_BODY_MB) * MB;
  const declared = Number(req.headers.get("content-length"));
  // 快路径:自报就超了,一个字节都不用收。
  if (Number.isFinite(declared) && declared > limit) throw tooBig(Math.min(limitMb, MAX_BODY_MB));
  const body = req.body;
  if (!body) return "";
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
      throw tooBig(Math.min(limitMb, MAX_BODY_MB));
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}
