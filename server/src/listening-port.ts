let boundPort: number | null = null;

function validPort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

/** 记录 HTTP server 实际绑定的端口；PORT=0 时只能在 listen 回调后得到。 */
export function recordListeningPort(port: number): void {
  boundPort = validPort(port);
}

/** 服务内生成回连 URL 时使用实际监听端口，同时不污染子进程继承的环境变量。 */
export function currentListeningPort(): number | null {
  return boundPort ?? validPort(process.env.PORT ?? 4317);
}

/**
 * **确知**自己绑在哪个端口上才返回；没 listen 过就是 null，不猜。
 *
 * 上面那个会退到 `PORT ?? 4317`，对「日志里出现这个端口就别当成预览本尊」那类判断够用
 * ——猜错了顶多少认一个端口。要把用户的会话 cookie 递过去的那一跳不能用它：猜错的
 * 4317 上可能坐着**另一台** ash，那就是把凭据送给了不该拿到的进程。
 */
export function boundListeningPort(): number | null {
  return boundPort;
}
