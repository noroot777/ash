// 「某个 CLI 能跑哪些模型、每个模型有哪些智能水平档位」的进程级缓存。
//
// 为什么单独一个文件:它原先住在 `ExecutionConfig.tsx` 里,而那里唯一的取数入口是
// 「用户点开模型选择器」—— 直接显示一个已有任务的模型/档位时谁都不去取,于是首帧拿
// 内置规则判,把一个合法的 `low` 标成「不支持」(2026-10-01 第 1 轮审查问题 2)。
// 拆出来之后这段逻辑能脱开 React 跑,取数时机就钉得住了(见
// `mobile/scripts/test-cli-capability.mjs`)。
//
// 取数函数由调用方传进来(组件传 `api.cliModels`,测试传假的):这个文件不碰
// react-native,也不碰网络。
import type { AgentType } from "@ash/shared";
import type { CliModelCatalog, ModelEffortMap } from "@ash/shared/cli-presets";

/**
 * CLI 官方账号那一档的能力。`models` 是 server 现问 CLI 的候选(`grok models` 之类),
 * 拿不到就由调用方退回 `CLI_MODEL_PRESETS` 那份内置快照 —— 快照是发版时抄的,新模型
 * 上线后会滞后,所以只当兜底。
 *
 * `efforts` 是同一份回答里顺带的 per-model 智能水平档位(CLI 亲口报的,见服务端
 * `cachedModelEfforts`)。缺省 = 这家没有可问的档位来源,档位退回内置规则。
 */
export interface CliCapability {
  models: string[];
  efforts?: ModelEffortMap;
}

export type CliCapabilityFetcher = (type: AgentType) => Promise<CliModelCatalog[]>;

// 整个 app 共一份,打开哪个任务都不用重探。
const cache = new Map<AgentType, CliCapability>();
// 同一个 type 的并发取数合并成一次:一个任务详情里可能同时挂着「执行」和「验证」两个
// ExecutionConfig,各自一挂载就是两个请求。
const inflight = new Map<AgentType, Promise<CliCapability | null>>();

/** 已经拿到的那份,不触发取数。组件用它给首帧一个初值。 */
export function peekCliCapability(type: AgentType): CliCapability | undefined {
  return cache.get(type);
}

/**
 * 取某个 CLI 的候选 + 档位。命中缓存直接给,否则合并到同一个请求上。
 *
 * **失败不写缓存**:下次进来还要再试一次。这跟模型候选那一半的宽容度一致(失败了
 * 有内置快照顶着),但档位这一半更要紧 —— 拿不到就只能按内置规则判,而内置规则可能
 * 比 CLI 实际支持的窄,会把一个合法配置标成「不支持」。
 */
export function fetchCliCapability(
  type: AgentType,
  fetcher: CliCapabilityFetcher,
): Promise<CliCapability | null> {
  const hit = cache.get(type);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(type);
  if (running) return running;
  const request = fetcher(type)
    .then((list) => {
      const entry = list.find((item) => item.type === type);
      if (!entry?.models.length) return null;
      const next: CliCapability = {
        models: [...entry.models],
        ...(entry.modelEfforts ? { efforts: entry.modelEfforts } : {}),
      };
      cache.set(type, next);
      return next;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(type);
    });
  inflight.set(type, request);
  return request;
}

/** 只给测试用:清掉缓存与在途请求。 */
export function resetCliCapabilityCache(): void {
  cache.clear();
  inflight.clear();
}
