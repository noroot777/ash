// 「默认规则」的个人面 / 实例面之分(§八)。
//
// app_settings 原本是一张扁平的全局表。多人模式下它必须裂成两半,因为里面躺着两类
// 完全不同的东西:
//  · **个人面**——worktree 默认、默认起手式。它们描述「我建任务时想要什么」,一人一份
//    才对;共用一份的话,A 关掉 worktree,B 下一次新建任务就莫名其妙不带 worktree 了。
//  · **实例面**——根目录、实例模式、技能扫描间隔、接力审批/加密/载荷上限。它们描述
//    **这台机器**的行为,一人一份没有意义,而且改了会影响所有人,所以只有实例管理员能改。
//
// 自用模式下这一层整个是透明的:读写都直接落 app_settings,与本功能上线前逐字节一致。
import { and, eq } from "drizzle-orm";
import type { AppSettings } from "@ash/shared";
import { getAppSettings, patchAppSettings } from "../app-settings.js";
import { db } from "../db/index.js";
import { userSettings } from "../db/schema.js";
import type { Actor } from "./context.js";
import { forbidden, isAdminActor, ownerIdOf } from "./context.js";
import { isMultiUser } from "./mode.js";

/** 一人一份的那几项。加一项就往这里加,读写两侧同时生效。 */
export const PERSONAL_SETTING_KEYS = ["worktreeDefault", "defaultWorkflowId"] as const;
export type PersonalSettingKey = (typeof PERSONAL_SETTING_KEYS)[number];

const isPersonalKey = (key: string): key is PersonalSettingKey =>
  (PERSONAL_SETTING_KEYS as readonly string[]).includes(key);

/**
 * 这个人看到的设置。个人面读他自己那份(没写过就落回全局那份当出厂值),实例面照读。
 * `ownerUserId` 为 null(自用模式、或后台没有具体发起人)时就是全局那份。
 */
export async function settingsFor(ownerUserId: string | null): Promise<AppSettings> {
  const base = await getAppSettings();
  if (!ownerUserId || !(await isMultiUser())) return base;
  const rows = await db.select().from(userSettings).where(eq(userSettings.userId, ownerUserId));
  const merged = { ...base };
  for (const row of rows) {
    if (!isPersonalKey(row.key)) continue;
    try {
      const value: unknown = JSON.parse(row.value);
      // 类型由写侧的 parseAppSettingsPatch 把关;这里只防手改过的库。
      if (row.key === "worktreeDefault" ? typeof value === "boolean" : typeof value === "string") {
        (merged as unknown as Record<string, unknown>)[row.key] = value;
      }
    } catch {
      // 坏值等同没写过:落回全局那份。
    }
  }
  return merged;
}

/** 设置页要按 actor 读。 */
export const settingsForActor = (actor: Actor): Promise<AppSettings> => settingsFor(ownerIdOf(actor));

/**
 * 写设置。个人面落自己那份;实例面要实例管理员;多人模式的接力目标机不走这条路
 * (它按人存,而且带凭证,见 auth/handoff-scope.ts)。
 */
export async function patchSettingsFor(actor: Actor, patch: Partial<AppSettings>): Promise<AppSettings> {
  if (!(await isMultiUser())) return patchAppSettings(patch);
  const owner = ownerIdOf(actor);
  const instancePart: Partial<AppSettings> = {};
  for (const [key, value] of Object.entries(patch) as [keyof AppSettings, unknown][]) {
    if (key === "handoffTargets") {
      throw forbidden("多人模式的接力目标机按人存，在「设置 → 默认规则 → 我的接力目标机」里改");
    }
    if (isPersonalKey(key)) {
      if (!owner) throw forbidden("请先登录");
      const encoded = JSON.stringify(value);
      await db
        .insert(userSettings)
        .values({ userId: owner, key, value: encoded })
        .onConflictDoUpdate({ target: [userSettings.userId, userSettings.key], set: { value: encoded } });
      continue;
    }
    (instancePart as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(instancePart).length) {
    if (!isAdminActor(actor)) throw forbidden("这几项是整台机器的设置，只有实例管理员能改");
    await patchAppSettings(instancePart);
  }
  return settingsFor(owner);
}

/** 删掉一条起手式后清掉指向它的个人默认。全局那份由调用方另外清。 */
export async function clearPersonalDefaultWorkflow(itemId: string): Promise<void> {
  if (!(await isMultiUser())) return;
  await db
    .delete(userSettings)
    .where(and(eq(userSettings.key, "defaultWorkflowId"), eq(userSettings.value, JSON.stringify(itemId))));
}
