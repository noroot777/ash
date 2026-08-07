import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentType, SkillEntry, SkillSource } from "@harness/shared";
import { DEFAULT_APP_SETTINGS } from "@harness/shared";
import { api } from "./api.ts";

// 输入框里 `/` 补全用的技能清单。三件事:拉、缓存、按设置的间隔重拉。
//
// **harness 不写任何提示词**:选中一条只是把 `/名字` 补进正文,原样发下去由 CLI
// 自己认。所以这里没有「执行技能」的概念,只有「补全」。

export interface SlashItem {
  /** 补进正文的文本,含斜杠。 */
  command: string;
  label: string;
  hint?: string;
  /** harness 自己的派生命令(/team、/duet)vs CLI 已装的技能。 */
  kind: "harness" | "skill";
  source?: SkillSource;
  /** 同一份技能还装在哪些别的 CLI 上(按物理路径认)。 */
  alsoIn?: AgentType[];
}

export const SOURCE_LABEL: Record<SkillSource, string> = {
  project: "项目",
  user: "个人",
  plugin: "插件",
  builtin: "内置",
};

interface CacheEntry {
  skills: SkillEntry[];
  remote: boolean;
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

function load(key: string, params: { agentType: string; projectId: string; executorId: string }, force: boolean): Promise<CacheEntry> {
  if (!force) {
    const running = inflight.get(key);
    if (running) return running;
  }
  const task = api.skills({ ...params, refresh: force })
    .then((list): CacheEntry => {
      const entry = { skills: list.skills, remote: list.remote, at: Date.now() };
      cache.set(key, entry);
      return entry;
    })
    .catch((): CacheEntry => {
      // 读不到就维持上一份(多半是服务端重启中)。技能补全坏掉不该让输入框看起来出事。
      return cache.get(key) ?? { skills: [], remote: false, at: Date.now() };
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
  executorId?: string | null;
  enabled?: boolean;
}): { skills: SkillEntry[]; remote: boolean; refresh: () => void } {
  const agentType = query.agentType || "claude";
  const projectId = query.projectId || "";
  const executorId = query.executorId || "";
  const enabled = query.enabled !== false;
  const key = `${agentType}${projectId}${executorId}`;
  const cached = cache.get(key);
  const [entry, setEntry] = useState<CacheEntry>(cached ?? { skills: [], remote: false, at: 0 });
  const [seconds, setSeconds] = useState(settingsValue);
  const keyRef = useRef(key);
  keyRef.current = key;

  const pull = useCallback((force: boolean) => {
    const mine = keyRef.current;
    void load(mine, { agentType, projectId, executorId }, force).then((next) => {
      if (keyRef.current === mine) setEntry(next);
    });
  }, [agentType, projectId, executorId]);

  useEffect(() => {
    if (!enabled) return;
    setEntry(cache.get(key) ?? { skills: [], remote: false, at: 0 });
    pull(false);
    void refreshSecondsOf().then(setSeconds);
  }, [enabled, key, pull]);

  useEffect(() => {
    if (!enabled || seconds <= 0) return;
    const timer = setInterval(() => pull(false), seconds * 1000);
    return () => clearInterval(timer);
  }, [enabled, seconds, pull]);

  return { skills: entry.skills, remote: entry.remote, refresh: () => pull(true) };
}

/** 正文里正在敲的那个斜杠 token(整段正文只有它时才算,免得句中的 `/` 也弹菜单)。 */
export function slashToken(text: string): string | null {
  return /^\s*(\/\S*)$/.exec(text)?.[1]?.toLowerCase() ?? null;
}

export function toSlashItems(skills: SkillEntry[]): SlashItem[] {
  return skills.map((skill) => ({
    command: skill.command,
    label: skill.description || "技能",
    kind: "skill" as const,
    source: skill.source,
    alsoIn: skill.alsoIn,
  }));
}

/**
 * 合成候选:**harness 自己的命令永远排在最前**。它们改变的是「谁来干这件事」
 * (派生一个团队/一场讨论),技能只是给当前这轮加一句提示词 —— 前者点错了代价大得多,
 * 不能让某个 CLI 装了个叫 team 的技能就把它挤下去。
 */
export function mergeSlashItems(harness: SlashItem[], skills: SkillEntry[], token: string | null): SlashItem[] {
  const items = [...harness, ...toSlashItems(skills)];
  if (!token) return [];
  return items.filter((item) => item.command.toLowerCase().startsWith(token));
}

/** 供菜单画分隔线:harness 命令与技能之间的那个下标。 */
export function useSlashSections(items: SlashItem[]): { firstSkillIndex: number } {
  return useMemo(() => ({ firstSkillIndex: items.findIndex((item) => item.kind === "skill") }), [items]);
}
