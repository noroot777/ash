import type { Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { llmProviders } from "../db/schema.js";
import { bearerToken, errorResponse, secretsEqual } from "./common.js";
import { proxyConvertedOpenAiRequest } from "./proxy.js";

export function mountOpenAiConverterRoutes(api: Hono) {
  const handle = async (c: Context) => {
    const providerId = c.req.param("id");
    if (!providerId) return errorResponse(404, "供应商不存在");
    const provider = (await db.select().from(llmProviders).where(eq(llmProviders.id, providerId))).at(0);
    if (!provider || provider.protocol !== "openai" || !provider.protocolConversionEnabled) {
      return errorResponse(404, "供应商协议转换未启用");
    }
    if (!provider.apiKey || !secretsEqual(bearerToken(c.req.raw.headers), provider.apiKey)) {
      return errorResponse(401, "供应商 API Key 无效");
    }
    const pathname = new URL(c.req.url).pathname;
    const marker = "/convert/v1";
    const markerIndex = pathname.indexOf(marker);
    const path = markerIndex >= 0 ? pathname.slice(markerIndex + marker.length) || "/" : "/";
    return proxyConvertedOpenAiRequest(c.req.raw, provider, path);
  };

  api.all("/llm-providers/:id/convert/v1", handle);
  api.all("/llm-providers/:id/convert/v1/*", handle);
}
