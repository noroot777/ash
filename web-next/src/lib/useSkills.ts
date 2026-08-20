import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentType, SkillEntry, SkillSource } from "@harness/shared";
import { DEFAULT_APP_SETTINGS } from "@harness/shared";
import { api } from "./api.ts";
import type { SlashItem } from "./slashMatch.ts";

// 输入框里 `/` 补全用的技能清单。三件事:拉、缓存、按设置的间隔重拉。
//
// 选中一条只是把 `/名字` 补进正文；确定调用由 server 运行前注入
// 对应 SKILL.md。所以这里仍然只有「补全」，不直接执行技能。
//
// 「哪些候选、按什么顺序」是纯逻辑,在 slashMatch.ts(能被 node 直接跑);
// 这里原样转发,调用方仍从本文件拿。
export type { SlashItem } from "./slashMatch.ts";
export { mergeSlashItems, slashMatchIndex, slashToken, toSlashItems } from "./slashMatch.ts";

export const SOURCE_LABEL: Record<SkillSource, string> = {
  project: "项目",
  user: "个人",
  plugin: "插件",
  builtin: "内置",
};

interface CacheEntry {
  skills: SkillEntry[];
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

// 设置项也缓存一下:每个输入框各拉一次全局设置太蠢,而这个值改动极少。
let settingsAt = 0;
let settingsValue = DEFAULT_APP_SETTINGS.skillRefreshSeconds;
let settingsInflight: Promise<number> | null = null;

async function refreshSecondsOf(): Promise<number> {
  if (Date.now() - settingsAt < 30_000) return settingsValue;
  if (!settingsInflight) {
    settingsInflight = api.settings()
      .then((settings) => {
        settingsValue = settings.skillRefreshSeconds;
        settingsAt = Date.now();
        return settingsValue;
      })
      .catch(() => settingsValue)
      .finally(() => { settingsInflight = null; });
  }
  return settingsInflight;
}

function load(key: string, params: { agentType: string; projectId: string }, force: boolean): Promise<CacheEntry> {
  if (!force) {
    const running = inflight.get(key);
    if (running) return running;
  }
  const task = api.skills({ ...params, refresh: force })
    .then((list): CacheEntry => {
      const entry = { skills: list.skills, at: Date.now() };
      cache.set(key, entry);
      return entry;
    })
    .catch((): CacheEntry => {
      // 读不到就维持上一份(多半是服务端重启中)。技能补全坏掉不该让输入框看起来出事。
      return cache.get(key) ?? { skills: [], at: Date.now() };
    })
    .finally(() => { inflight.delete(key); });
  inflight.set(key, task);
  return task;
}

/**
 * 某个执行器在某个项目下现在能用哪些 `/技能`。
 * 挂载时拉一次(所以「关掉输入框再打开」永远拿得到新的),之后按全局设置轮询。
 */
export function useSkills(query: {
  agentType?: AgentType | string | null;
  projectId?: string | null;
  enabled?: boolean;
}): { skills: SkillEntry[]; refresh: () => void } {
  const agentType = query.agentType || "claude";
  const projectId = query.projectId || "";
  const enabled = query.enabled !== false;
  const key = `${agentType}${projectId}`;
  const cached = cache.get(key);
  const [entry, setEntry] = useState<CacheEntry>(cached ?? { skills: [], at: 0 });
  const [seconds, setSeconds] = useState(settingsValue);
  const keyRef = useRef(key);
  keyRef.current = key;

  const pull = useCallback((force: boolean) => {
    const mine = keyRef.current;
    void load(mine, { agentType, projectId }, force).then((next) => {
      if (keyRef.current === mine) setEntry(next);
    });
  }, [agentType, projectId]);

  useEffect(() => {
    if (!enabled) return;
    setEntry(cache.get(key) ?? { skills: [], at: 0 });
    pull(false);
    void refreshSecondsOf().then(setSeconds);
  }, [enabled, key, pull]);

  useEffect(() => {
    if (!enabled || seconds <= 0) return;
    const timer = setInterval(() => pull(false), seconds * 1000);
    return () => clearInterval(timer);
  }, [enabled, seconds, pull]);

  return { skills: entry.skills, refresh: () => pull(true) };
}

/** 供菜单画分隔线:harness 命令与技能之间的那个下标。 */
export function useSlashSections(items: SlashItem[]): { firstSkillIndex: number } {
  return useMemo(() => ({ firstSkillIndex: items.findIndex((item) => item.kind === "skill") }), [items]);
}
