// 搜索 —— 从 `api.ts` 拆出来的一族。
//
// 为什么单独一个文件:流式搜索那一段不是「一行一个端点」的清单内容,它自带一套读流、
// 拼半行、认 marker 的解析逻辑(四十来行),混在端点总清单里既挤占那份清单的 700 行
// 上限,也让人读清单时不得不翻过它。契约不变:调用点仍然只认 `api.searchStream`。
import type { SearchHit } from "@ash/shared";
import type { SearchSort, SearchStreamLine } from "@ash/shared/search";
import { apiPath } from "./apiClient.ts";

// 搜索的查询串。界面只走流式那条(`/search/stream`);服务端另有一条整份返回的
// `/search`,参数完全同形,留给脚本和 curl —— 所以这里单独拎出来,两边不会漂。
const searchQueryParams = (
  query: string,
  scope?: { projectId?: string; type?: "tasks" | "notes"; prefer?: string | null; sort?: SearchSort },
) => {
  const params = new URLSearchParams({ q: query });
  if (scope?.projectId) params.set("projectId", scope.projectId);
  if (scope?.type) params.set("type", scope.type);
  if (scope?.prefer) params.set("prefer", scope.prefer);
  if (scope?.sort) params.set("sort", scope.sort);
  return params;
};

export const searchApi = {
  /**
   * 流式搜索：命中一条回调一条，本项目那一段扫完时回调一次 `onLocalDone`。
   *
   * 语料 2.2 GB，一次全盘扫要几秒。整份返回意味着这几秒里 ⌘K 是空的；边扫边出意味着
   * 本项目的命中第一时间就在列表里了。**`signal` 不是可选的礼貌** —— 用户每敲一个字就是
   * 一次新的全盘扫，不中断上一次，服务端会同时跑几十个扫描，把事件循环占死。
   */
  searchStream: async (
    query: string,
    scope: { projectId?: string; type?: "tasks" | "notes"; prefer?: string | null; sort?: SearchSort } | undefined,
    handlers: { onHit: (hit: SearchHit) => void; onLocalDone?: () => void },
    signal: AbortSignal,
  ): Promise<void> => {
    const response = await fetch(apiPath(`/search/stream?${searchQueryParams(query, scope)}`), { signal });
    if (!response.ok || !response.body) throw new Error(`搜索失败（${response.status}）`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const take = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: SearchStreamLine;
      try {
        parsed = JSON.parse(trimmed) as SearchStreamLine;
      } catch {
        throw new Error("搜索结果不完整，请重试");
      }
      if (!parsed || typeof parsed !== "object") throw new Error("搜索结果格式错误，请重试");
      if ("marker" in parsed) {
        if (parsed.marker === "local-done") handlers.onLocalDone?.();
        return;
      }
      if ((parsed.kind !== "task" && parsed.kind !== "note") || typeof parsed.id !== "string" || typeof parsed.title !== "string"
        || typeof parsed.snippet !== "string" || typeof parsed.updatedAt !== "string") throw new Error("搜索结果格式错误，请重试");
      handlers.onHit(parsed);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) take(line);
      }
      take(buffered + decoder.decode());
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  },
};
