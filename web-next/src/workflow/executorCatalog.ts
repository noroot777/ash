// 线路图上的执行器候选。工作流定义里只存 executorId（agents.id），名字和模型候选
// 都要现查——存进定义就会随改名腐烂（shared/workflow.ts 的注释讲了这条）。
//
// 页面上可能同时有好几张线路图（composer 一张、Inspector 一张），所以两个请求做成
// 模块级缓存共享，跟 agentAvailability 的 detection 一个路子。
import { useEffect, useState } from "react";
import type { AgentExecutorProfile, LlmProvider } from "@harness/shared";
import { api } from "../lib/api.ts";

export interface ExecutorCatalog {
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
}

const EMPTY: ExecutorCatalog = { profiles: [], providers: [] };
let cached: Promise<ExecutorCatalog> | null = null;

function load(): Promise<ExecutorCatalog> {
  cached ??= Promise.all([api.agents(), api.llmProviders()]).then(
    ([profiles, providers]) => ({ profiles, providers }),
    () => EMPTY,
  );
  return cached;
}

/** 执行器设置里增删改之后调一次，让线路图上的候选跟着更新。 */
export function refreshExecutorCatalog() {
  cached = null;
}

export function useExecutorCatalog(): ExecutorCatalog {
  const [catalog, setCatalog] = useState<ExecutorCatalog>(EMPTY);
  useEffect(() => {
    let alive = true;
    void load().then((next) => { if (alive) setCatalog(next); });
    return () => { alive = false; };
  }, []);
  return catalog;
}

/** 找不到就返回 null —— 调用方据此在 chip 上标红「执行器已不在了」。 */
export function executorName(catalog: ExecutorCatalog, executorId: string): string | null {
  const profile = catalog.profiles.find((candidate) => candidate.id === executorId);
  return profile ? profile.name : null;
}

export function executorProfile(
  catalog: ExecutorCatalog,
  executorId: string | null,
): AgentExecutorProfile | null {
  if (!executorId) return null;
  return catalog.profiles.find((candidate) => candidate.id === executorId) ?? null;
}

export function providerOf(
  catalog: ExecutorCatalog,
  profile: AgentExecutorProfile | null,
): LlmProvider | undefined {
  if (!profile?.providerId) return undefined;
  return catalog.providers.find((candidate) => candidate.id === profile.providerId);
}
