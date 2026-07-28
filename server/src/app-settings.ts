import type { AppSettings } from "@harness/shared";
import { DEFAULT_APP_SETTINGS } from "@harness/shared";
import { db } from "./db/index.js";
import { appSettings } from "./db/schema.js";

const SETTING_KEYS = new Set<keyof AppSettings>(["worktreeDefault"]);

// Ignore malformed persisted values and fall back to the factory default. The
// PATCH boundary prevents new bad values; this only protects hand-edited/old DBs.
export async function getAppSettings(): Promise<AppSettings> {
  const merged: AppSettings = { ...DEFAULT_APP_SETTINGS };
  for (const row of await db.select().from(appSettings)) {
    if (!SETTING_KEYS.has(row.key as keyof AppSettings)) continue;
    try {
      const value: unknown = JSON.parse(row.value);
      if (row.key === "worktreeDefault" && typeof value === "boolean") {
        merged.worktreeDefault = value;
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
  for (const key of Object.keys(raw)) {
    if (!SETTING_KEYS.has(key as keyof AppSettings)) {
      throw new Error(`未知设置项: ${key}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, "worktreeDefault") && typeof raw.worktreeDefault !== "boolean") {
    throw new Error("worktreeDefault 必须是 boolean");
  }
  return Object.prototype.hasOwnProperty.call(raw, "worktreeDefault")
    ? { worktreeDefault: raw.worktreeDefault as boolean }
    : {};
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
