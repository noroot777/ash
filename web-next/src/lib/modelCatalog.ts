import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import { providersForAgent } from "../settings/agentProviderRules.ts";
import { api } from "./api.ts";
import { cliCatalogNote, useCliModelCatalog } from "./cliModelCatalog.ts";

/**
 * 「这个智能体能选哪些模型」的**唯一来源**。对话框的 @ 选择、任务信息里的模型下拉、
 * 新建/派生面板的模型输入全部读它，于是「供应商页面固定了哪几个模型」这一个开关
 * 能一次管住所有选模型的地方。
 *
 * 分块按**供应商**：该智能体在执行器页面注册的 Profile，按各自挂载的供应商聚合；
 * 没挂供应商的走 CLI 官方账号那一块（模型由 lib/cliModelCatalog.ts 现问 CLI，问不到才是内置快照）。
 * 每块记住一个代表 Profile —— 选中模型时连它一起生效，用户才不用先挑 Profile 再挑模型。
 */
export interface ModelGroup {
  key: string;
  providerId: string | null; // null = CLI 官方账号
  providerName: string;
  executorId: string | null; // 该块的代表 Profile（null = 类型默认）
  executorName: string | null;
  profileModel: string | null; // 代表 Profile 自带的模型 = 「跟随执行器」实际会跑的那个
  models: string[];
  status: "ready" | "loading" | "failed";
  /** 这一块的来源说明，直接展示给用户（固定了几个 / 正在探测 / 失败原因）。 */
  note: string;
  /**
   * 「现问一次」。缺省 = 这一块没有可刷新的来源（固定清单是用户自己填的，没什么好问的）。
   * 有它的两块：CLI 官方账号（问 CLI 自己）和 api 模式的供应商（问 /v1/models）——
   * 它们的清单都会在 harness 之外变化，所以必须给用户一个不重启就能拿到新模型的动作。
   */
  onRefresh?: () => void;
  refreshing?: boolean;
}

// ── provider /models 探测：全页共享一份缓存 ─────────────────────────────────
// 同一个供应商在多个选择器里同时打开时只探一次；供应商被改过（base URL / Key /
// 模式）就靠 clearProviderModelCache 打版本号作废，而不是留着旧结果骗人。
const providerModelCache = new Map<string, string[]>();
const providerModelRequests = new Map<string, Promise<string[]>>();
const providerModelVersions = new Map<string, number>();

function providerCacheKey(provider: LlmProvider) {
  const version = providerModelVersions.get(provider.id) ?? 0;
  return `${provider.id}\u0000${version}\u0000${provider.protocol}\u0000${provider.baseUrl}`;
}

export function clearProviderModelCache(providerId?: string) {
  if (providerId) {
    providerModelVersions.set(providerId, (providerModelVersions.get(providerId) ?? 0) + 1);
    const prefix = `${providerId}\u0000`;
    for (const key of providerModelCache.keys()) {
      if (key.startsWith(prefix)) providerModelCache.delete(key);
    }
    for (const key of providerModelRequests.keys()) {
      if (key.startsWith(prefix)) providerModelRequests.delete(key);
    }
    return;
  }
  providerModelCache.clear();
  providerModelRequests.clear();
  providerModelVersions.clear();
}

/** 供应商被改动的次数：组件把它放进 effect 依赖，就能在缓存作废时重新探测。 */
export function providerCacheVersion(providerId: string): number {
  return providerModelVersions.get(providerId) ?? 0;
}

export function cachedProviderModels(provider: LlmProvider): string[] | undefined {
  return providerModelCache.get(providerCacheKey(provider));
}

export function loadProviderModels(provider: LlmProvider): Promise<string[]> {
  const key = providerCacheKey(provider);
  const cached = providerModelCache.get(key);
  if (cached) return Promise.resolve(cached);
  let request = providerModelRequests.get(key);
  if (!request) {
    request = api.probeModels({
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      id: provider.id,
    }).then(({ models }) => {
      providerModelCache.set(key, models);
      providerModelRequests.delete(key);
      return models;
    }, (error) => {
      providerModelRequests.delete(key);
      throw error;
    });
    providerModelRequests.set(key, request);
  }
  return request;
}

/** 固定模式下这家供应商的候选：固定列表优先，没固定就退回它的默认模型。 */
export function pinnedModelsOf(provider: LlmProvider): string[] {
  const pinned = provider.pinnedModels.map((model) => model.trim()).filter(Boolean);
  if (pinned.length) return pinned;
  return provider.model.trim() ? [provider.model.trim()] : [];
}

// ── 供应商列表：同样全页共享一份 ─────────────────────────────────────────────
let providersRequest: Promise<LlmProvider[]> | null = null;
const providerSubscribers = new Set<(providers: LlmProvider[]) => void>();

function loadProviders(): Promise<LlmProvider[]> {
  providersRequest ??= api.llmProviders().catch(() => [] as LlmProvider[]);
  return providersRequest;
}

/** 供应商被增删改后调用：下一个读它的选择器会重新拉，且已挂载的会当场更新。 */
export function refreshProviders() {
  providersRequest = null;
  void loadProviders().then((providers) => {
    for (const subscriber of providerSubscribers) subscriber(providers);
  });
}

export function useProviders(): LlmProvider[] {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  useEffect(() => {
    let alive = true;
    const update = (next: LlmProvider[]) => { if (alive) setProviders(next); };
    providerSubscribers.add(update);
    void loadProviders().then(update);
    return () => {
      alive = false;
      providerSubscribers.delete(update);
    };
  }, []);
  return providers;
}

type GroupSeed = {
  key: string;
  providerId: string | null;
  providerName: string;
  executorId: string | null;
  executorName: string | null;
  profileModel: string | null;
  provider?: LlmProvider;
};

/**
 * 分块骨架：不含任何异步结果，纯粹由「注册了哪些 Profile / 挂了哪些供应商」决定。
 * 抽出来是为了让 hook 的依赖是这份稳定的骨架，而不是每次渲染新建的数组。
 *
 * 排序上**当前生效的执行器所挂的供应商排第一块**（`currentExecutorId`，没传就退回
 * 默认 Profile）：打开选模型时想换的九成是同一家的另一个模型，把它排在第一屏能省掉
 * 一次翻找；排第二的仍是默认 Profile 那块。
 */
function groupSeeds(
  type: AgentType,
  profiles: AgentExecutorProfile[],
  providers: LlmProvider[],
  currentExecutorId: string | null,
): GroupSeed[] {
  const typeProfiles = profiles.filter((profile) => profile.type === type);
  const seeds: GroupSeed[] = [];
  const seen = new Set<string>();
  // 当前执行器 > 默认 Profile > 其余：排在前面的 Profile 成为所在块的代表，
  // 块的先后顺序也由此确定。
  const rank = (profile: AgentExecutorProfile) =>
    (profile.id === currentExecutorId ? 2 : 0) + (profile.isDefault ? 1 : 0);
  const ordered = [...typeProfiles].sort((a, b) => rank(b) - rank(a));
  for (const profile of ordered) {
    const providerId = profile.providerId ?? null;
    const groupKey = providerId ?? "__cli";
    if (seen.has(groupKey)) continue;
    const provider = providerId ? providers.find((candidate) => candidate.id === providerId) : undefined;
    // 供应商被删掉后 Profile 上会留一个悬空 id：按 CLI 官方账号处理，别静默空着。
    if (providerId && !provider) continue;
    seen.add(groupKey);
    seeds.push({
      key: groupKey,
      providerId: provider ? provider.id : null,
      providerName: provider ? provider.name : "CLI 官方账号",
      executorId: profile.id,
      executorName: profile.name,
      profileModel: profile.model?.trim() || null,
      provider,
    });
  }
  // 该类型还没有任何 Profile：仍然给出类型默认这一块，用户照样能选 CLI 别名。
  if (!seeds.length) {
    seeds.push({
      key: "__cli",
      providerId: null,
      providerName: "CLI 官方账号",
      executorId: null,
      executorName: null,
      profileModel: null,
    });
  }
  // 该类型能挂、但还没有任何 Profile 挂上的供应商也列出来：用户在这里选了模型，
  // 就等于「这一回合用这家供应商」——只是没有专属 Profile，执行器退回类型默认。
  for (const provider of providersForAgent(type, providers)) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    seeds.push({
      key: provider.id,
      providerId: provider.id,
      providerName: provider.name,
      executorId: null,
      executorName: null,
      profileModel: null,
      provider,
    });
  }
  return seeds;
}

/**
 * 按供应商分块的模型目录。`api` 模式的块会在挂载时并发探测（每家一条请求，
 * 结果进全页缓存）；`pinned` 模式的块直接就绪，一个网络请求都不发。
 */
export function useAgentModelCatalog(
  type: AgentType | null,
  profiles: AgentExecutorProfile[],
  providers: LlmProvider[],
  /** 当前生效的执行器 id：它挂的供应商排第一块。 */
  currentExecutorId: string | null = null,
): ModelGroup[] {
  const seeds = useMemo(
    () => (type ? groupSeeds(type, profiles, providers, currentExecutorId) : []),
    [type, profiles, providers, currentExecutorId],
  );
  const [probes, setProbes] = useState<Record<string, { models?: string[]; error?: string }>>({});
  // CLI 官方账号那块的候选:服务端现问 CLI 的结果(问不到才是内置快照)。
  const { catalog: cliCatalog, refreshing: cliRefreshing, refresh: refreshCli } = useCliModelCatalog(type);
  const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);

  // 供应商那块的「现问一次」:作废这家的缓存再探一遍。清缓存是全页生效的,所以其它
  // 已挂载的选择器下次读也拿新的,不会出现「这个框刷新了、那个框还是旧的」。
  const refreshProvider = useCallback((provider: LlmProvider) => {
    clearProviderModelCache(provider.id);
    setProbes((current) => {
      const next = { ...current };
      delete next[provider.id];
      return next;
    });
    setRefreshingProvider(provider.id);
    void loadProviderModels(provider)
      .then(
        (models) => setProbes((current) => ({ ...current, [provider.id]: { models } })),
        (error) => {
          const message = error instanceof Error ? error.message : "模型探测失败";
          setProbes((current) => ({ ...current, [provider.id]: { error: message } }));
        },
      )
      .finally(() => setRefreshingProvider((current) => (current === provider.id ? null : current)));
  }, []);

  useEffect(() => {
    let alive = true;
    for (const seed of seeds) {
      const provider = seed.provider;
      if (!provider || provider.modelListMode !== "api") continue;
      const cached = cachedProviderModels(provider);
      if (cached) {
        setProbes((current) => (current[provider.id] ? current : { ...current, [provider.id]: { models: cached } }));
        continue;
      }
      void loadProviderModels(provider).then(
        (models) => { if (alive) setProbes((current) => ({ ...current, [provider.id]: { models } })); },
        (error) => {
          if (!alive) return;
          const message = error instanceof Error ? error.message : "模型探测失败";
          setProbes((current) => ({ ...current, [provider.id]: { error: message } }));
        },
      );
    }
    return () => { alive = false; };
  }, [seeds]);

  return useMemo(() => seeds.map((seed) => {
    const provider = seed.provider;
    if (!provider) {
      // CLI 官方账号:清单来自服务端现问 CLI(探不到才是内置快照,note 会说清是哪种)。
      // 不跟快照取并集 —— 探测成功就以 CLI 报的为准,已下线的模型不该继续留在下拉里。
      const cliModels = cliCatalog ? [...cliCatalog.models] : [];
      return {
        ...seed,
        models: dedupe([seed.profileModel, ...cliModels]),
        status: "ready" as const,
        note: cliCatalogNote(cliCatalog),
        // 没有可查询的清单命令时不给刷新按钮:点了也只会再拿到同一份快照,
        // 给一个什么都不会变的按钮比不给更让人困惑。
        onRefresh: cliCatalog?.probeSupported ? refreshCli : undefined,
        refreshing: cliRefreshing,
      };
    }
    if (provider.modelListMode === "pinned") {
      const pinned = pinnedModelsOf(provider);
      return {
        ...seed,
        models: dedupe([seed.profileModel, ...pinned]),
        status: "ready" as const,
        note: pinned.length ? `固定 ${pinned.length} 个模型` : "还没固定模型，去供应商设置里添加",
      };
    }
    const probe = probes[provider.id];
    const providerRefresh = { onRefresh: () => refreshProvider(provider), refreshing: refreshingProvider === provider.id };
    if (probe?.models) {
      return {
        ...seed,
        models: dedupe([seed.profileModel, ...probe.models]),
        status: "ready" as const,
        note: `实时目录 · ${probe.models.length} 个模型`,
        ...providerRefresh,
      };
    }
    if (probe?.error) {
      return {
        ...seed,
        models: dedupe([seed.profileModel]),
        status: "failed" as const,
        note: `模型目录读取失败：${probe.error}`,
        ...providerRefresh,
      };
    }
    return {
      ...seed,
      models: dedupe([seed.profileModel]),
      status: "loading" as const,
      note: "正在读取模型目录…",
      ...providerRefresh,
    };
  }), [cliCatalog, cliRefreshing, probes, refreshCli, refreshProvider, refreshingProvider, seeds]);
}

function dedupe(models: (string | null | undefined)[]): string[] {
  return [...new Set(models.map((model) => model?.trim()).filter((model): model is string => !!model))];
}

/** 所有块拍平成一张去重后的模型名清单（给 datalist 之类不分块的表面用）。 */
export function flattenCatalogModels(groups: ModelGroup[]): string[] {
  return dedupe(groups.flatMap((group) => group.models));
}
