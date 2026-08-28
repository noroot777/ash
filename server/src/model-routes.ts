// 模型清单的两个只读端点。从 `routes.ts` 拆出来的理由跟 `skill-routes.ts` 一样:
// 那个文件已经 662 行,逼近 700 上限。
//
// 语义就两句:
//   GET  /agents/models          —— 拿清单(命中缓存就直接返回,没有就现问一次)
//   POST /agents/models/refresh  —— 用户点了「刷新」,绕过缓存重问
// 探测与缓存的全部规矩在 `executors/model-probe.ts` 顶部,这里不复述。
//
// 这两条**不按 actor 收窄**,也不该收窄:多人模式下 `modelCatalogFor` 根本不去问宿主机
// CLI(§八),回的是对谁都一样的内置快照;自用模式下本来就没有「谁」这回事。别在这里
// 补第二道判据 —— 边界是「不起那个子进程」,不是「谁能看见结果」。
import type { Hono } from "hono";
import type { AgentType } from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import { modelCatalogs } from "./executors/model-probe.js";

// `?type=` 可给一个或多个(逗号分隔)。给了不认识的名字就当没给 —— 返回全部,
// 而不是 400:这个接口是「拿候选填下拉框」,为一个拼错的参数把整个选择器打空更坏。
function typesFrom(raw: string): AgentType[] | undefined {
  const wanted = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is AgentType => (AGENT_TYPES as readonly string[]).includes(part));
  return wanted.length ? wanted : undefined;
}

export function mountModelRoutes(api: Hono): void {
  api.get("/agents/models", async (c) => c.json(await modelCatalogs(typesFrom(c.req.query("type") || ""))));

  // 刷新是显式动作(用户按的),所以是 POST:不该被浏览器/代理当成可重放的读请求
  // 预取一遍 —— 每次都会真的去起子进程问 CLI。
  api.post("/agents/models/refresh", async (c) =>
    c.json(await modelCatalogs(typesFrom(c.req.query("type") || ""), true)),
  );
}
