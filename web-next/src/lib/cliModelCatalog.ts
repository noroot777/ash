import { useCallback, useEffect, useState } from "react";
import type { AgentType } from "@harness/shared";
import type { CliModelCatalog } from "@harness/shared/cli-presets";
import { CLI_MODEL_PRESETS } from "@harness/shared/cli-presets";
import { api } from "./api.ts";

/**
 * 「CLI 官方账号」那一块的模型候选。跟 provider 的 `/models` 探测(见 modelCatalog.ts)
 * 是同一个套路的另一半:全页共享一份缓存,多个选择器同时打开只发一次请求。
 *
 * 为什么不再直接读 `CLI_MODEL_PRESETS`:那张表是 harness 发版时抄下来的快照,而各家
 * CLI 上新模型跟 harness 发版毫无关系 —— grok 4.6 发布后本机 CLI 早就能用了,下拉框里
 * 却只有 4.5。现在候选来自服务端现问 CLI 的结果(`grok models` 之类),快照只当兜底。
 *
 * 前端仍然 import 那张快照:**首帧不空**。请求在飞的那几百毫秒里先拿快照顶上,总比
 * 一个空下拉框强;拿到真结果就整体替换(而不是并集 —— 已下线的模型不该继续列)。
 */
const cache = new Map<AgentType, CliModelCatalog>();
const requests = new Map<AgentType, Promise<CliModelCatalog>>();
const subscribers = new Map<AgentType, Set<(catalog: CliModelCatalog) => void>>();

/** 还没问到结果时的占位:内容等同于内置快照,`source` 照实写着 preset。 */
export function presetFallback(type: AgentType): CliModelCatalog {
  return {
    type,
    models: [...CLI_MODEL_PRESETS[type]],
    defaultModel: null,
    source: "preset",
    probeSupported: false,
    available: false,
    probedAt: null,
    cliVersion: null,
    error: null,
  };
}

function publish(catalog: CliModelCatalog) {
  cache.set(catalog.type, catalog);
  for (const notify of subscribers.get(catalog.type) ?? []) notify(catalog);
}

function fetchCatalog(type: AgentType, force: boolean): Promise<CliModelCatalog> {
  const inflight = requests.get(type);
  if (inflight && !force) return inflight;
  const request = (force ? api.refreshCliModels(type) : api.cliModels(type))
    .then((list) => {
      const catalog = list.find((entry) => entry.type === type) ?? presetFallback(type);
      publish(catalog);
      return catalog;
    })
    // 拿不到就退回快照:选择器不该因为一个后台接口抖动而变成空的。
    .catch(() => cache.get(type) ?? presetFallback(type))
    .finally(() => {
      if (requests.get(type) === request) requests.delete(type);
    });
  requests.set(type, request);
  return request;
}

/**
 * 一个 CLI 的模型清单。`refresh()` = 用户点了刷新,服务端会绕过缓存现问一次 CLI。
 *
 * `type` 为 null(还没选智能体)时给一份空清单,不发请求。
 */
export function useCliModelCatalog(type: AgentType | null): {
  catalog: CliModelCatalog | null;
  refreshing: boolean;
  refresh: () => void;
} {
  const [catalog, setCatalog] = useState<CliModelCatalog | null>(() => (type ? cache.get(type) ?? presetFallback(type) : null));
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!type) {
      setCatalog(null);
      return;
    }
    let alive = true;
    setCatalog(cache.get(type) ?? presetFallback(type));
    const notify = (next: CliModelCatalog) => { if (alive) setCatalog(next); };
    const listeners = subscribers.get(type) ?? new Set();
    listeners.add(notify);
    subscribers.set(type, listeners);
    if (!cache.has(type)) void fetchCatalog(type, false);
    return () => {
      alive = false;
      listeners.delete(notify);
    };
  }, [type]);

  const refresh = useCallback(() => {
    if (!type) return;
    setRefreshing(true);
    void fetchCatalog(type, true).finally(() => setRefreshing(false));
  }, [type]);

  return { catalog, refreshing, refresh };
}

/**
 * 这一块该给用户看的一句话。**来源要说实话**:实时问出来的和内置兜底的必须能分辨,
 * 拿快照冒充实时目录比清单短一点更坏(用户会以为新模型真的还没上)。
 */
export function cliCatalogNote(catalog: CliModelCatalog | null): string {
  if (!catalog) return "";
  if (catalog.source === "probe") {
    const when = catalog.probedAt ? new Date(catalog.probedAt).toLocaleTimeString() : "";
    return `CLI 实时清单 · ${catalog.models.length} 个${when ? ` · ${when} 探测` : ""}`;
  }
  if (!catalog.models.length) return "该 CLI 未公布模型别名，可手填";
  if (catalog.error) return `内置清单（现问 CLI 失败：${catalog.error}）`;
  if (catalog.probeSupported && !catalog.available) return "内置清单（本机没装这个 CLI，问不到）";
  if (catalog.probeSupported) return "内置清单，可点刷新现问 CLI";
  return "CLI 自带的模型别名（该 CLI 没有可查询的清单命令）";
}
