// 与 ash server 说话的那一层：地址、回合身份、连不上时的退避重试，以及把结果包成
// MCP 响应的两个壳。从 index.ts 拆出来的动机是**职责**不是行数：工具注册表会一直长
// （每加一个 ash 能力就多一段），而这一层是恒定的；混在一起时，改一句工具描述也要把
// 整份传输层重新读一遍。
//
// 这里不含任何业务判断 —— 业务全在 ash 的 HTTP 端点上（见 index.ts 顶部那段）。
import { UNDELIVERED_NET_CODES } from "@ash/shared/mcp-delivery";

export const BASE = (process.env.ASH_URL ?? process.env.HARNESS_URL ?? "http://localhost:4317").replace(/\/+$/, "");
export const SOURCE_TASK_ID = process.env.ASH_TASK_ID?.trim() ?? "";
export const TURN_TOKEN = process.env.ASH_TURN_TOKEN?.trim() ?? "";
export const DIRECTION_TOKEN = process.env.ASH_DIRECTION_TOKEN?.trim() ?? "";

// 本机流量一律不走代理。Node 24+ 在 NODE_USE_ENV_PROXY=1(或显式 HTTP_PROXY)下
// **连 localhost 也走代理** —— 实测本机 http_proxy=127.0.0.1:7897 时,打给
// ash 的每一次工具调用都先绕到代理再回来。两个后果:①白白多一跳、还把
// ash 的存活绑在代理上;②server 重启时拿到的是代理给的 UND_ERR_SOCKET
// (「对端关闭」)而不是 ECONNREFUSED,下面那个「确定没送达才重试」的判断就永远
// 命中不了。合并而不是覆盖已有的 NO_PROXY,别把用户自己的配置吃掉。
// 必须在第一次 fetch 之前执行 —— 放模块顶层即可(工具调用都在之后)。
{
  const loopback = ["localhost", "127.0.0.1", "::1"];
  const existing = (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...new Set([...existing, ...loopback])].join(",");
  process.env.NO_PROXY = merged;
  process.env.no_proxy = merged;
}

// 重启窗口的等待上限。scripts/restart.mjs 是「杀掉 → 等端口释放 → 起新进程 →
// 轮询 /api/health」,正常几秒内回来;给到 60s 是留足构建慢、机器忙的余量。
export const RECONNECT_WINDOW_MS = Number(process.env.ASH_RECONNECT_MS ?? process.env.HARNESS_RECONNECT_MS ?? 60_000);

// 只对「明确没送达」的连接错误重试。ECONNREFUSED = 根本没人在监听那个端口
// (server 重启期间的确切表现),请求一个字节都没发出去,重试绝不会重复执行。
// 刻意**不**含 UND_ERR_SOCKET / ECONNRESET:那些是「连上了又断」,可能已经送达,
// 重试就会把 dispatch 这类非幂等操作做两遍。
//
// 码表来自 shared,跟 server 那边「回合结算时补捞漏掉的交卷」是同一份口径
// (`shared/src/mcp-delivery.ts`)。注意那边另有一份**更宽**的判据
// (`isUndeliveredMcpFailure`,连 ECONNRESET 都算没送达)——那份只在幂等白名单
// 的保护下才成立,**不能搬到这里**:这里对所有工具一视同仁。
//
// 形状实测(Node 26):`http://localhost:<关闭端口>` 抛 AggregateError,code 挂在
// AggregateError 自己身上、errors 里是 IPv4/IPv6 各一条;`http://127.0.0.1:…`
// 抛普通 Error。两种都要认。
export function retryableCode(e: unknown): string | null {
  const cause = (e as { cause?: unknown })?.cause;
  const code = (cause as { code?: string })?.code;
  if (code && UNDELIVERED_NET_CODES.has(code)) return code;
  const inner = (cause as { errors?: Array<{ code?: string }> })?.errors;
  const first = inner?.find((x) => x?.code && UNDELIVERED_NET_CODES.has(x.code));
  return first?.code ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One place to talk to the API. Network failures get a human hint; HTTP errors
// surface the server's JSON error body verbatim so the agent can react.
//
// 连不上时会**退避重试**到 RECONNECT_WINDOW_MS 为止,而不是当场抛错。理由:
// agent 进程现在能活过 server 重启(输出走文件不走管道),但它汇报成果的
// `complete_task` 走 HTTP —— 正好撞上重启那几秒就会硬失败,于是「进程活下来了、
// 成果却丢了」。重试把这个窗口抹平。只重试确定没送达的错误,所以 dispatch 这种
// 非幂等调用也不会被做两遍。
export async function call(method: string, path: string, body?: unknown, directionToken = DIRECTION_TOKEN): Promise<unknown> {
  const deadline = Date.now() + RECONNECT_WINDOW_MS;
  let delay = 400;
  let lastCode = "";
  let res: Response;
  for (;;) {
    try {
      const headers: Record<string, string> = { "x-ash-client": "mcp" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (SOURCE_TASK_ID) headers["x-ash-source-task-id"] = SOURCE_TASK_ID;
      if (TURN_TOKEN) headers["x-ash-turn-token"] = TURN_TOKEN;
      if (directionToken) headers["x-ash-direction-token"] = directionToken;
      res = await fetch(`${BASE}/api${path}`, {
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (e) {
      const code = retryableCode(e);
      if (!code || Date.now() >= deadline) {
        const waited = lastCode ? `（已重试 ${Math.round(RECONNECT_WINDOW_MS / 1000)}s，${lastCode}）` : "";
        throw new Error(
          `连不上 ash server (${BASE})${waited}，确认它在运行（npm start）。原始错误：${e instanceof Error ? e.message : String(e)}`,
        );
      }
      lastCode = code;
      // stderr 才是 MCP 的日志通道(stdout 是协议帧,写脏了会直接搞崩会话)。
      console.error(`[ash-mcp] ${code} — server 可能在重启，${delay}ms 后重试 ${method} ${path}`);
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, 5_000);
    }
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path} — ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

export const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
export const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

// 从 shared 派生,别在这里另抄一张名单:AGENT_TYPES 加一个 CLI,MCP 工具的
