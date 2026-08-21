// HTTP 传输层：拼路径、发请求、把非 2xx 变成带 status 的 ApiError。
// 和 `api.ts` 分开住，是因为那份端点清单已经顶到单文件 700 行上限；调用点仍然只从
// `api.ts` 引（它把这里和 `apiTypes.ts` 一并再导出），不必知道有这一层。
const API_ROOT = "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function apiPath(path: string): string {
  return `${API_ROOT}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(path), init);
  const body = await parseBody(response);
  if (!response.ok) {
    throw apiError(response, body);
  }
  return body as T;
}

export function apiError(response: Response, body: unknown): ApiError {
  const message =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `${response.status} 请求失败`;
  return new ApiError(response.status, message, body);
}

export function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export const id = encodeURIComponent;
