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
