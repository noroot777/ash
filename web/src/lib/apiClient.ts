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

function parseText(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  return parseText(await response.text());
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
  return new ApiError(response.status, errorMessage(body, response.status), body);
}

function errorMessage(body: unknown, status: number): string {
  return typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
    ? body.error
    : `${status} 请求失败`;
}

// 请求体大到用户能感知的只有上传这一条：远程访问时几 MB 的图要传上十几秒，期间必须能
// 回答「传到哪了」。fetch 给不了上传进度（请求体 ReadableStream 上传各浏览器支持不一），
// 只有 XHR 的 upload.progress 能，所以这条单独走 XHR。同源请求，cookie 照常带。
export function postWithProgress<T>(
  path: string,
  body: unknown,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<T> {
  const { onProgress, signal } = options;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError(0, "上传已取消", null));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiPath(path));
    xhr.setRequestHeader("content-type", "application/json");
    if (onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      });
    }
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort);
    const done = () => signal?.removeEventListener("abort", onAbort);
    xhr.addEventListener("load", () => {
      done();
      const parsed = xhr.status === 204 ? undefined : parseText(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T);
      else reject(new ApiError(xhr.status, errorMessage(parsed, xhr.status), parsed));
    });
    xhr.addEventListener("error", () => {
      done();
      reject(new ApiError(0, "网络中断", null));
    });
    xhr.addEventListener("abort", () => {
      done();
      reject(new ApiError(0, "上传已取消", null));
    });
    xhr.send(JSON.stringify(body));
  });
}

export function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export const id = encodeURIComponent;
