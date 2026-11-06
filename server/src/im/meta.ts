// im_meta 的读写，以及通道的实例级选项。
//
// 选项不进 app_settings：`GET /settings` 会把整份回给任何已登录的人，preview-seed 还会复制
// 进预览库；飞书的选项与凭证一起只属于这一个实例。
import type { ImOptions } from "@ash/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { imMeta } from "../db/schema-im.js";

export async function readMeta(key: string): Promise<string | null> {
  return (await db.select({ value: imMeta.value }).from(imMeta).where(eq(imMeta.key, key))).at(0)?.value ?? null;
}

export async function writeMeta(key: string, value: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  await db.insert(imMeta).values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: imMeta.key, set: { value, updatedAt } });
}

export async function deleteMeta(key: string): Promise<void> {
  await db.delete(imMeta).where(eq(imMeta.key, key));
}

export const DEFAULT_MONTHLY_QUOTA = 10_000;

export const DEFAULT_OPTIONS: ImOptions = {
  enabled: true,
  notifyCompleted: true,
  publicBaseUrl: null,
  monthlyQuota: DEFAULT_MONTHLY_QUOTA,
  titleOnlyProjectIds: [],
};

const OPTIONS_KEY = "options";
let cached: ImOptions | null = null;
let corrupt: string | null = null;

/**
 * 存着的选项坏了（不是 JSON、不是对象、「只推标题」那张单子不是数组）不能按默认值来：默认是「全文都推」，
 * 设成只推标题的项目会开始推全文，发出去就收不回。坏了就先关掉通道（enabled: false），设置页报出原因
 * （optionsError），管理员重新保存一次选项就好了。坏的那份不缓存，库里修好了下一次就读得到。
 */
export async function readOptions(): Promise<ImOptions> {
  if (cached) return cached;
  const raw = await readMeta(OPTIONS_KEY);
  let parsed: unknown = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = null; }
  const shaped = !!parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && (!("titleOnlyProjectIds" in parsed) || Array.isArray((parsed as ImOptions).titleOnlyProjectIds));
  if (!shaped) {
    corrupt = "存着的飞书选项读不懂，已先停掉推送：请核对下面各项设置后重新打开。";
    return { ...DEFAULT_OPTIONS, enabled: false };
  }
  corrupt = null;
  cached = normalizeOptions({ ...DEFAULT_OPTIONS, ...(parsed as Partial<ImOptions>) });
  return cached;
}

/** 选项坏着的话是什么原因（设置页显示）；没坏为 null。 */
export function optionsError(): string | null {
  return corrupt;
}

const URL_RE = /^https?:\/\/[^\s/?#]+(?::\d+)?(?:\/[^\s?#]*)?$/i;

export function normalizeOptions(input: ImOptions): ImOptions {
  const base = input.publicBaseUrl?.trim().replace(/\/+$/, "") || null;
  return {
    enabled: input.enabled !== false,
    notifyCompleted: input.notifyCompleted !== false,
    publicBaseUrl: base && URL_RE.test(base) ? base : null,
    monthlyQuota: Number.isInteger(input.monthlyQuota) && input.monthlyQuota > 0
      ? Math.min(input.monthlyQuota, 100_000_000) : DEFAULT_MONTHLY_QUOTA,
    titleOnlyProjectIds: Array.isArray(input.titleOnlyProjectIds)
      ? [...new Set(input.titleOnlyProjectIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 80))]
      : [],
  };
}

/** 校验并写入。返回错误文案或新选项。 */
export async function patchOptions(patch: Record<string, unknown>): Promise<{ error: string } | { options: ImOptions }> {
  const current = await readOptions();
  // 坏着的时候 current 是默认值（「只推标题」那张单子是空的）：改哪一项都会把空单子整份写回去、坏的记号跟着消掉，
  // 原来只推标题的项目再打开推送就推全文。先让他把单子核对一遍（改一次「只推标题」就存下整份），再改别的。
  if (corrupt && !("titleOnlyProjectIds" in patch)) {
    return { error: "存着的飞书选项读不懂：先在下面「只推标题」里把该勾的项目核对一遍（改动一次就会重新存下整份选项），再改别的。" };
  }
  const next: ImOptions = { ...current };
  if ("enabled" in patch) {
    if (typeof patch.enabled !== "boolean") return { error: "enabled 必须是布尔值" };
    next.enabled = patch.enabled;
  }
  if ("notifyCompleted" in patch) {
    if (typeof patch.notifyCompleted !== "boolean") return { error: "notifyCompleted 必须是布尔值" };
    next.notifyCompleted = patch.notifyCompleted;
  }
  if ("publicBaseUrl" in patch) {
    const value = patch.publicBaseUrl;
    if (value !== null && typeof value !== "string") return { error: "深链地址必须是字符串" };
    const trimmed = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
    if (trimmed && !URL_RE.test(trimmed)) return { error: "深链地址要是 http(s):// 开头的完整地址，如 http://mac.tailnet.ts.net:4317" };
    next.publicBaseUrl = trimmed || null;
  }
  if ("monthlyQuota" in patch) {
    const value = patch.monthlyQuota;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return { error: "月额度必须是正整数" };
    next.monthlyQuota = value;
  }
  if ("titleOnlyProjectIds" in patch) {
    if (!Array.isArray(patch.titleOnlyProjectIds) || patch.titleOnlyProjectIds.some((id) => typeof id !== "string")) {
      return { error: "titleOnlyProjectIds 必须是项目 id 数组" };
    }
    next.titleOnlyProjectIds = patch.titleOnlyProjectIds as string[];
  }
  const normalized = normalizeOptions(next);
  await writeMeta(OPTIONS_KEY, JSON.stringify(normalized));
  cached = normalized;
  corrupt = null;
  return { options: normalized };
}

/** 测试换库后清缓存用。 */
export function resetOptionsCache(): void {
  cached = null;
  corrupt = null;
}
