import type { AppSettings } from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import { db } from "./db/index.js";
import { MAX_BODY_MB } from "./handoff-body.js";
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
  skillRefreshSeconds: {
    // 按**小时**计:装新技能是低频动作,而等不及的人有「立即重新扫描」和「关掉输入框
    // 再打开」两条即时通道,没必要让所有页面每分钟对着服务端刷一遍 HTTP。
    ok: (v: unknown) =>
      typeof v === "number" && Number.isInteger(v) && (v === 0 || (v >= 3600 && v <= 86400)),
    hint: "必须是 0（关闭轮询）或 3600~86400 之间的整数秒（1~24 小时）",
  },
  handoffTargets: {
    ok: (v: unknown) =>
      Array.isArray(v) && v.length <= 20 && v.every((t) => {
        if (!t || typeof t !== "object") return false;
        const { name, url, peerFp } = t as { name?: unknown; url?: unknown; peerFp?: unknown };
        // peerFp 是记住的对端公钥指纹(sha256 hex),可缺省/可为 null(还没配对过)。
        if (peerFp != null && !(typeof peerFp === "string" && /^[0-9a-f]{64}$/.test(peerFp))) return false;
        return typeof name === "string" && name.length >= 1 && name.length <= 64
          && typeof url === "string" && /^https?:\/\/\S+$/.test(url) && url.length <= 256;
      }),
    hint: "必须是 {name,url,peerFp?}[]（url 以 http(s):// 开头，peerFp 是 64 位小写 hex 指纹，最多 20 个目标）",
  },
  handoffRequireApproval: { ok: (v: unknown) => typeof v === "boolean", hint: "必须是 boolean" },
  handoffEncrypt: { ok: (v: unknown) => typeof v === "boolean", hint: "必须是 boolean" },
  handoffMaxBodyMb: {
    ok: (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_BODY_MB,
    hint: `必须是 1..${MAX_BODY_MB} 的整数（512 是硬顶：body 最终要变成一个 JS 字符串）`,
  },
  // 实例模式与根目录只能走 `/api/auth/setup`(首启向导 / 危险区转换):那条路要同时
  // 建管理员、建目录、发 key,拆成一次裸 PATCH 就会留下「模式是多人但一个用户都没有」
  // 的锁死状态。所以这里的 ok 恒 false —— **PATCH /settings 永远拒绝这两项**,读取仍走
  // getAppSettings 那条统一的归一路径。
  instanceMode: {
    ok: () => false,
    hint: "只能通过首启向导 / 设置页危险区转换（POST /api/auth/setup）设定",
  },
  rootDir: {
    ok: () => false,
    hint: "只能在转多人模式时设定，设定后锁死（一改所有已建项目路径失效）",
  },
} satisfies { [K in keyof AppSettings]: { ok: (v: unknown) => boolean; hint: string } };

// 上面两项对 PATCH 永远说不,但读取仍要认得住盘里的值 —— 所以读侧另有一份校验。
const READ_ONLY_SPECS: Partial<Record<keyof AppSettings, (v: unknown) => boolean>> = {
  instanceMode: (v) => v === "" || v === "single" || v === "multi",
  rootDir: (v) => typeof v === "string" && v.length <= 4096,
};

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
      const accept = READ_ONLY_SPECS[row.key] ?? SETTING_SPECS[row.key].ok;
      if (accept(value)) {
        (merged as unknown as Record<string, unknown>)[row.key] = value;
      }
    } catch {
      // Invalid storage is equivalent to an absent key: keep the default.
    }
  }
  return merged;
}

/**
 * 绕过 PATCH 校验直写一个设置项。**只给 auth/setup 那条路用**(实例模式与根目录):
 * 它俩对外恒拒,但转换向导必须写得进去。别在别处调它。
 */
export async function writeSystemSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): Promise<void> {
  const encoded = JSON.stringify(value);
  await db
    .insert(appSettings)
    .values({ key, value: encoded })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: encoded } });
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
