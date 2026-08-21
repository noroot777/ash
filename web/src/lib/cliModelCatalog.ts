import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentType } from "@ash/shared";
import type { CliModelCatalog } from "@ash/shared/cli-presets";
import { CLI_MODEL_PRESETS, CLI_MODEL_PROBE_TYPES } from "@ash/shared/cli-presets";
import { api } from "./api.ts";

/**
 * 「CLI 官方账号」那一块的模型候选。跟 provider 的 `/models` 探测(见 modelCatalog.ts)
 * 是同一个套路的另一半:全页共享一份缓存,多个选择器同时打开只发一次请求。
 *
 * 候选来自服务端现问 CLI 的结果,`CLI_MODEL_PRESETS` 那份发版快照只当兜底。仍然
 * import 它是为了**首帧不空**:请求在飞的那几百毫秒里先拿快照顶上,总比一个空下拉框强;
 * 拿到真结果就**整体替换**(而不是并集 —— 已下线的模型不该继续列)。
 */
const cache = new Map<AgentType, CliModelCatalog>();
const fetchedAt = new Map<AgentType, number>();
const requests = new Map<AgentType, Promise<CliModelCatalog>>();
const subscribers = new Map<AgentType, Set<(catalog: CliModelCatalog) => void>>();

/**
 * 降级结果(接口抖了、服务端那次没探到)隔多久允许再自动拉一次。成功的清单缓存到刷新
 * 页面为止就够了,但失败若也永久占着缓存,后面每一个选择器都只能看见那次抖动的后果 ——
 * 服务端已经恢复了,界面却要等用户想起来点刷新。
 */
const DEGRADED_RETRY_MS = 60_000;

function degraded(catalog: CliModelCatalog): boolean {
  // 没有清单命令的 CLI 本来就只有快照,那不是失败,别去重试。
  return catalog.source !== "probe" && catalog.probeSupported;
}

function shouldFetch(type: AgentType): boolean {
  const cached = cache.get(type);
  if (!cached) return true;
  if (!degraded(cached)) return false;
  return Date.now() - (fetchedAt.get(type) ?? 0) >= DEGRADED_RETRY_MS;
}

/** 还没问到结果时的占位:内容等同于内置快照,`source` 照实写着 preset。 */
export function presetFallback(type: AgentType, patch: Partial<CliModelCatalog> = {}): CliModelCatalog {
  return {
    type,
    models: [...CLI_MODEL_PRESETS[type]],
    defaultModel: null,
    source: "preset",
    // 首帧 / 接口失败也要按「这家能不能现问」画刷新按钮,不能等服务端回了才出现。
    probeSupported: CLI_MODEL_PROBE_TYPES.has(type),
    available: false,
    probedAt: null,
    cliVersion: null,
    error: null,
    ...patch,
  };
}

function publish(catalog: CliModelCatalog) {
  cache.set(catalog.type, catalog);
  fetchedAt.set(catalog.type, Date.now());
  for (const notify of subscribers.get(catalog.type) ?? []) notify(catalog);
}

function fetchCatalog(type: AgentType, force: boolean): Promise<CliModelCatalog> {
  const inflight = requests.get(type);
  if (inflight && !force) return inflight;
  // **只有当前那次请求有权 publish**。点刷新会另起一次并顶掉 requests,先前那次
  // (服务端可能正卡在 10s 的 CLI 查询上)结算得更晚 —— 不拦住的话它会把刚刷出来的
  // 实时清单盖回快照,用户看到的是「点了刷新,过两秒又变回去了」。
  const settle = (catalog: CliModelCatalog) => {
    if (requests.get(type) === request) publish(catalog);
    return catalog;
  };
  const request: Promise<CliModelCatalog> = (force ? api.refreshCliModels(type) : api.cliModels(type))
    .then((list) => {
      // live 旧服务端没有这接口时会 200 回 SPA HTML;当成数组 .find 会炸,必须先认形状。
      if (!Array.isArray(list)) {
        return settle(presetFallback(type, {
          error: "模型清单接口不可用（当前连着的服务端还没有 /agents/models）",
        }));
      }
      return settle(list.find((entry) => entry.type === type) ?? presetFallback(type));
    })
    // 拿不到就退回快照:选择器不该因为一个后台接口抖动而变成空的。
    // 失败也 publish,界面才能用 error 说明「该点刷新 / 服务端还没合入」。
    .catch((error) =>
      settle(presetFallback(type, {
        error: error instanceof Error ? error.message : "模型清单请求失败",
      })),
    )
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
  // 连点刷新时,转圈要等**最后一次**结束才停:按先结束的那次熄灯,后一次还在飞,
  // 界面却已经显示「好了」。
  const pending = useRef(0);

  useEffect(() => {
    if (!type) {
      setCatalog(null);
      return;
    }
    let alive = true;
    pending.current = 0;
    setRefreshing(false);
    setCatalog(cache.get(type) ?? presetFallback(type));
    const notify = (next: CliModelCatalog) => { if (alive) setCatalog(next); };
    const listeners = subscribers.get(type) ?? new Set();
    listeners.add(notify);
    subscribers.set(type, listeners);
    if (shouldFetch(type)) void fetchCatalog(type, false);
    return () => {
      alive = false;
      listeners.delete(notify);
    };
  }, [type]);

  const refresh = useCallback(() => {
    if (!type) return;
    pending.current += 1;
    setRefreshing(true);
    void fetchCatalog(type, true).finally(() => {
      pending.current = Math.max(0, pending.current - 1);
      if (!pending.current) setRefreshing(false);
    });
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
