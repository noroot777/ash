import type { AppSettings } from "@harness/shared";
import { DEFAULT_APP_SETTINGS } from "@harness/shared";
import { db } from "./db/index.js";
import { appSettings } from "./db/schema.js";

// 加一个全局设置项**只改这一张表**：读取归一、PATCH 校验、报错文案全从这里派生。
// `satisfies` 保证漏登记一个字段就编译不过 —— 以前三处逐字段 if 是三份得同时想起来改
// 的拷贝，漏一处的表现是「设置能存进去但读不出来」。
const SETTING_SPECS = {
  worktreeDefault: { ok: (v: unknown) => typeof v === "boolean", hint: "必须是 boolean" },
  defaultWorkflowId: {
    ok: (v: unknown) => typeof v === "string" && v.length <= 64,
    hint: "必须是字符串（起手式 id，空串 = 跟随系统推荐）",
  },
} satisfies { [K in keyof AppSettings]: { ok: (v: unknown) => boolean; hint: string } };

const SETTING_KEYS = Object.keys(SETTING_SPECS) as (keyof AppSettings)[];
const isSettingKey = (key: string): key is keyof AppSettings =>
  (SETTING_KEYS as string[]).includes(key);

// Ignore malformed persisted values and fall back to the factory default. The
// PATCH boundary prevents new bad values; this only protects hand-edited/old DBs.
export async function getAppSettings(): Promise<AppSettings> {
  const merged: AppSettings = { ...DEFAULT_APP_SETTINGS };
  for (const row of await db.select().from(appSettings)) {
    if (!isSettingKey(row.key)) continue;
    try {
      const value: unknown = JSON.parse(row.value);
      if (SETTING_SPECS[row.key].ok(value)) {
        (merged as unknown as Record<string, unknown>)[row.key] = value;
      }
    } catch {
      // Invalid storage is equivalent to an absent key: keep the default.
    }
  }
  return merged;
}

export function parseAppSettingsPatch(input: unknown): Partial<AppSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("settings patch 必须是对象");
  }
  const raw = input as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!isSettingKey(key)) throw new Error(`未知设置项: ${key}`);
    const spec = SETTING_SPECS[key];
    if (!spec.ok(raw[key])) throw new Error(`${key} ${spec.hint}`);
    patch[key] = raw[key];
  }
  return patch as Partial<AppSettings>;
}

export async function patchAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  for (const [key, value] of Object.entries(patch) as [keyof AppSettings, AppSettings[keyof AppSettings]][]) {
    const encoded = JSON.stringify(value);
    await db
      .insert(appSettings)
      .values({ key, value: encoded })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: encoded } });
  }
  return getAppSettings();
}
