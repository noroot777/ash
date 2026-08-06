import { relayApi } from "../llm.js";
import {
  asBoolean,
  asString,
  errorResponse,
  isObject,
  responseHeaders,
  upstreamHeaders,
  type JsonObject,
} from "./common.js";
import { responsesToChatRequest } from "./request.js";
import { chatToResponsesResponse } from "./response.js";
import { chatStreamToResponses } from "./stream.js";

export type ConverterProvider = {
  baseUrl: string;
  apiKey: string;
};

function upstreamUrl(provider: ConverterProvider, path: string, search: string): string {
  const relative = path.replace(/^\/+/, "");
  return `${relayApi(provider.baseUrl)}/${relative}${search}`;
}

async function upstreamFetch(
  request: Request,
  provider: ConverterProvider,
  path: string,
  body?: BodyInit,
  forceJson = false,
): Promise<Response> {
  const method = request.method.toUpperCase();
  return fetch(upstreamUrl(provider, path, new URL(request.url).search), {
    method,
    headers: upstreamHeaders(request.headers, provider.apiKey, forceJson),
    body: method === "GET" || method === "HEAD" ? undefined : body,
    redirect: "manual",
    signal: request.signal,
  });
}

async function passthrough(request: Request, provider: ConverterProvider, path: string): Promise<Response> {
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const upstream = await upstreamFetch(request, provider, path, body);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream.headers, false),
  });
}

async function responsesViaChat(request: Request, provider: ConverterProvider): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return errorResponse(405, "Responses API 只支持 POST");
  let source: unknown;
  try {
    source = await request.json();
  } catch {
    return errorResponse(400, "请求体不是有效 JSON");
  }
  let converted: JsonObject;
  try {
    converted = responsesToChatRequest(source);
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : String(error));
  }
  let upstream: Response;
  try {
    upstream = await upstreamFetch(request, provider, "chat/completions", JSON.stringify(converted), true);
  } catch (error) {
    return errorResponse(502, `无法连接供应商：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream.headers, false),
    });
  }
  const sourceObject = isObject(source) ? source : {};
  const streaming = asBoolean(sourceObject.stream) === true;
  if (streaming) {
    if (!upstream.body) return errorResponse(502, "供应商没有返回流式响应体");
    return new Response(chatStreamToResponses(upstream.body, asString(sourceObject.model) ?? ""), {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }
  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return errorResponse(502, "供应商返回的 Chat Completions 响应不是有效 JSON");
  }
  try {
    return Response.json(chatToResponsesResponse(payload), {
      status: 200,
      headers: responseHeaders(upstream.headers, true),
    });
  } catch (error) {
    return errorResponse(502, `响应转换失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

// 供应商开关的语义是“兼容仅实现 Chat Completions 的 OpenAI 端点”：
// Codex 发来的 /responses 转成 /chat/completions；Qwen 等原生 Chat 客户端仍原样透传，
// 避免同一个供应商开关反过来把本来能用的 Chat 请求转坏。
export async function proxyConvertedOpenAiRequest(
  request: Request,
  provider: ConverterProvider,
  path: string,
): Promise<Response> {
  if (path.replace(/\/+$/, "") === "/responses") return responsesViaChat(request, provider);
  try {
    return await passthrough(request, provider, path);
  } catch (error) {
    return errorResponse(502, `无法连接供应商：${error instanceof Error ? error.message : String(error)}`);
  }
}
