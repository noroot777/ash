// 链接策略变了以后，库里存着的卡片按新策略重写（app-link.ts linkPolicy 说清了为什么会变）。
//
// 决策卡还在等人（pending / sent / held）的，对账时渲染指纹对不上会整张重渲染；可已经收尾的（已处理、
// 已点过、通知、汇总、配对……）不再经过对账，存着的就是飞书上那张的样子。所以这里不分种类，扫一遍
// im_outbox 里所有带打开链接动作的卡（content 与只推标题时换上的 brief），每个按钮重出一次链接
// （feishu/cards.ts relinkCard）：
//   · 还没发出去的：直接换掉内容，发出去就是新的；
//   · 已经发出去、14 天内的：换掉内容并排上改卡，飞书上那张随之改过来（排着撤回的只换内容：撤回不了时
//     退回成改卡，改的是这份）；
//   · 发出去超过 14 天的：飞书不让改了（envelopes.ts ENVELOPE_TTL_MS），库里留着和飞书上一致的那份，不动；
//   · 已撤回、发不出去的（dead）：飞书上没有它，不管。
// 做完把这次的策略记进 im_meta，同一个策略下次起通道不再扫；中途出错不记，下次起通道重来（重写是幂等的）。
// 必须在发件队列开跑之前做完（channel.ts bringUp），否则排着的旧卡会先按旧内容发出去。
import { and, eq, isNull, like, ne, notInArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { imOutbox } from "../db/schema-im.js";
import { now } from "../util.js";
import { linkPolicy } from "./app-link.js";
import { ENVELOPE_TTL_MS } from "./envelopes.js";
import { relinkCard } from "./feishu/cards.js";
import { readMeta, writeMeta } from "./meta.js";
import { RECALL, RECALLED } from "./outbox.js";
import { REPATCH } from "./reconcile.js";

const META_KEY = "link_policy";

/** 返回改了几行；策略没变（已经扫过）返回 0。 */
export async function relinkStoredCards(policy = linkPolicy(), at = Date.now()): Promise<number> {
  if ((await readMeta(META_KEY)) === policy) return 0;
  const rows = await db.select({
    id: imOutbox.id, content: imOutbox.content, brief: imOutbox.brief, messageId: imOutbox.messageId,
    sentAt: imOutbox.sentAt, patchState: imOutbox.patchState,
  }).from(imOutbox).where(and(
    eq(imOutbox.msgType, "interactive"), ne(imOutbox.state, "dead"),
    or(isNull(imOutbox.patchState), notInArray(imOutbox.patchState, [RECALLED])),
    or(like(imOutbox.content, "%open_url%"), like(imOutbox.brief, "%open_url%")),
  ));
  let changed = 0;
  for (const row of rows) {
    const content = relinkCard(row.content);
    const brief = row.brief === null ? null : relinkCard(row.brief);
    if (content === row.content && brief === row.brief) continue;
    const sent = row.messageId !== null;
    if (sent && row.sentAt && at - Date.parse(row.sentAt) > ENVELOPE_TTL_MS) continue;
    const done = await db.update(imOutbox).set({
      content, brief, updatedAt: now(),
      ...(sent && row.patchState !== RECALL ? { patchState: REPATCH, nextAt: null } : {}),
    }).where(and(
      eq(imOutbox.id, row.id), eq(imOutbox.content, row.content),
      row.brief === null ? isNull(imOutbox.brief) : eq(imOutbox.brief, row.brief),
    )).returning({ id: imOutbox.id });
    changed += done.length;
  }
  await writeMeta(META_KEY, policy);
  return changed;
}
