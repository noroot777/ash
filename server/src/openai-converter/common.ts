import { randomUUID, timingSafeEqual } from "node:crypto";
import { currentListeningPort } from "../listening-port.js";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function copyDefined(target: JsonObject, source: JsonObject, keys: string[]) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) target[key] = source[key];
  }
}

export function convertId(value: unknown, prefix: "resp_" | "chatcmpl-"): string {
  const source = asString(value) ?? randomUUID().replaceAll("-", "");
  if (source.startsWith(prefix)) return source;
  for (const known of ["resp_", "chatcmpl-", "cmpl-"]) {
    if (source.startsWith(known)) return prefix + source.slice(known.length);
  }
  return prefix + source;
}

export function generatedId(prefix: "resp_" | "msg_" | "rs_" | "call_"): string {
  return prefix + randomUUID().replaceAll("-", "");
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function bearerToken(headers: Headers): string {
  const authorization = headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || headers.get("x-api-key")?.trim() || "";
}

export function secretsEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function protocolConverterBaseUrl(providerId: string): string {
  const configured = process.env.ASH_PROTOCOL_CONVERTER_URL?.trim();
  const origin = (configured || `http://127.0.0.1:${currentListeningPort() ?? 4317}`).replace(/\/+$/, "");
  return `${origin}/api/llm-providers/${encodeURIComponent(providerId)}/convert`;
}

export function responseHeaders(source: Headers, transformed: boolean): Headers {
  const headers = new Headers();
  for (const [key, value] of source) {
    const lower = key.toLowerCase();
    if (["connection", "content-encoding", "content-length", "keep-alive", "transfer-encoding"].includes(lower)) continue;
    headers.set(key, value);
  }
  if (transformed) headers.set("content-type", "application/json; charset=utf-8");
  return headers;
}

export function upstreamHeaders(source: Headers, apiKey: string, forceJson = false): Headers {
  const headers = new Headers();
  for (const [key, value] of source) {
    const lower = key.toLowerCase();
    if (["authorization", "connection", "content-length", "host", "keep-alive", "transfer-encoding", "x-api-key"].includes(lower)) continue;
    headers.set(key, value);
  }
  headers.set("authorization", `Bearer ${apiKey}`);
  if (forceJson) headers.set("content-type", "application/json");
  return headers;
}

export function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message, type: "protocol_conversion_error" } }, { status });
}
