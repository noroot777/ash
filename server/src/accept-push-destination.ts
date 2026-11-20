// 推送目的地对外的样子（GET /tasks/:id/accept-push 发出去、确认层原样发回、门禁续做存进库里的那一份）。
//
// 不变量：**推送地址里的认证信息不出服务端**（审查第 4 轮）。仓库地址里内嵌令牌（`https://user:ghp_xxx@…`、
// `git clone https://token@…` 留下的 `https://ghp_xxx@…`）并不罕见，而这份目的地会进浏览器、进报错、进任务记录。
// 所以对外只给抹掉整段认证信息的地址（git-identity.ts redactUrlsIn，用户名位置也可能是令牌）供人看，「确认的就是这一处」
// 靠指纹核：服务端用自己的密钥对真实目的地算 HMAC，执行时按那一刻解析出的真实地址重算一遍比对 —— 客户端
// 拿不到真实地址，也算不出另一处地址的指纹。密钥存在库里（app_settings 里一个不对外的键），重启之后存下来的
// 门禁续做照样核得上。
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AcceptPushDestination } from "@navi/shared/accept-gate";
import { db } from "./db/index.js";
import { appSettings } from "./db/schema.js";
import { redactUrlsIn } from "./git-identity.js";
import type { PushTarget } from "./git-accept-remote.js";

/** 服务端内部的推送目的地：`url` 是真实推送地址（可能带凭证），只用来推和拉，不往外送。 */
export type PushPlan = PushTarget & { branch: string };

const KEY_ROW = "accept_push.destination_key";
let cachedKey: Buffer | null = null;

async function destinationKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  await db.insert(appSettings).values({ key: KEY_ROW, value: JSON.stringify(randomBytes(32).toString("base64")) }).onConflictDoNothing();
  const row = (await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY_ROW))).at(0);
  cachedKey = Buffer.from(JSON.parse(row!.value) as string, "base64");
  return cachedKey;
}

const fingerprintOf = async (plan: PushPlan) => createHmac("sha256", await destinationKey())
  .update(JSON.stringify([plan.branch, plan.remote, plan.remoteBranch, plan.url])).digest("base64url");

/** 发出去的那一份：地址脱敏，带指纹。 */
export async function publicDestination(plan: PushPlan): Promise<AcceptPushDestination> {
  return { branch: plan.branch, remote: plan.remote, remoteBranch: plan.remoteBranch, url: redactUrlsIn(plan.url),
    fingerprint: await fingerprintOf(plan) };
}

/** 发回来的那一份是不是此刻这一处真实目的地。 */
export async function confirmsDestination(confirmed: AcceptPushDestination, plan: PushPlan): Promise<boolean> {
  const expected = Buffer.from(await fingerprintOf(plan));
  const given = Buffer.from(confirmed.fingerprint);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 给人看的「推到哪」：`main → origin/main（https://***@host/r.git）`，不带凭证。 */
export const describeDestination = (plan: { branch: string; remote: string; remoteBranch: string; url: string }) =>
  `${plan.branch} → ${plan.remote}/${plan.remoteBranch}（${redactUrlsIn(plan.url)}）`;
