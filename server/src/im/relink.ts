// 链接策略变了以后，库里存着的卡片按新策略重写，并且保证飞书上那张最终也改过来（app-link.ts linkPolicy
// 说清了为什么会变）。
//
// 决策卡还在等人（pending / sent / held）的，对账时渲染指纹对不上会整张重渲染；可已经收尾的（已处理、
// 已点过、通知、汇总、配对……）不再经过对账，存着的就是飞书上那张的样子。所以这里不分种类，扫一遍
// im_outbox 里所有带打开链接动作的卡（content 与只推标题时换上的 brief），每个按钮重出一次链接
// （feishu/cards.ts relinkCard）：
//   · 还没发出去的：直接换掉内容，发出去就是新的；
//   · 已经发出去、14 天内的：换掉内容、排上改卡，并记下 link_due —— 「库里改好了」不等于「飞书上改好了」，
//     这笔账逐张记着，改卡送到了才清（outbox.ts patchOne / actions.ts 回执确认）。额度挡住只往后挪
//     （outbox.ts deferLinkDue），改卡放弃了（failed / skipped）、没等到回执确认就退出了（acking）的下次起通道在这里重新排上，往后挪着的当场就试；
//     排着撤回的只换内容：撤回成了这笔账跟着清，撤不回退回成改卡，改的是这份；
//   · 发出去超过 14 天的：飞书不让改了（ENVELOPE_TTL_MS），库里留着和飞书上一致的那份，不动、不记账；
//   · 已撤回、发不出去的（dead）：飞书上没有它，不管。
// 重写一遍全表只在策略变了时做（做完把策略记进 im_meta）；欠着的账每次起通道都过一遍。中途出错整个抛出去，
// 通道记成失败、过一会儿重来（重写是幂等的）。必须在发件队列开跑之前做完（channel.ts bringUp），
// 否则排着的旧卡会先按旧内容发出去。
import { and, eq, isNotNull, isNull, like, ne, notInArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { imOutbox } from "../db/schema-im.js";
import { now } from "../util.js";
import { linkPolicy } from "./app-link.js";
import { relinkCard } from "./feishu/cards.js";
import { readMeta, writeMeta } from "./meta.js";
import { linkDueAlive, RECALL, RECALLED } from "./outbox.js";
import { REPATCH } from "./reconcile.js";

const META_KEY = "link_policy";

/** 返回这次重写了几行（策略没变就是 0；重新排上的欠账不算在内）。 */
export async function relinkStoredCards(policy = linkPolicy(), at = Date.now()): Promise<number> {
  let changed = 0;
  if ((await readMeta(META_KEY)) !== policy) {
    changed = await rewrite(policy, at);
    await writeMeta(META_KEY, policy);
  }
  await rearm(at);
  return changed;
}

async function rewrite(policy: string, at: number): Promise<number> {
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
    if (sent && !linkDueAlive(row.sentAt, at)) continue;
    const done = await db.update(imOutbox).set({
      content, brief, updatedAt: now(),
      ...(sent ? { linkDue: policy } : {}),
      ...(sent && row.patchState !== RECALL ? { patchState: REPATCH, nextAt: null } : {}),
    }).where(and(
      eq(imOutbox.id, row.id), eq(imOutbox.content, row.content),
      row.brief === null ? isNull(imOutbox.brief) : eq(imOutbox.brief, row.brief),
    )).returning({ id: imOutbox.id });
    changed += done.length;
  }
  return changed;
}

/**
 * 欠着新链接的卡，起通道时一张张放回改卡队列。不变量：做完之后每一笔还没销的账都处在发件队列**当场就挑得到**的
 * 状态 —— PATCHING 里的一种、next_at 为空（outbox.ts nextPatch）。重启多半是因为额度调高了、网络好了，
 * 往后挪着的也不再干等一轮。只改 next_at 而不看状态会造出永远挑不到的行（acking 只按到点的期限挑，空期限永远不到点）。
 */
async function rearm(at: number): Promise<void> {
  const owed = await db.select({ id: imOutbox.id, sentAt: imOutbox.sentAt, patchState: imOutbox.patchState }).from(imOutbox)
    .where(and(isNotNull(imOutbox.linkDue), isNotNull(imOutbox.messageId)));
  for (const row of owed) {
    await db.update(imOutbox).set(linkDueAlive(row.sentAt, at) ? requeued(row.patchState) : { linkDue: null })
      .where(and(eq(imOutbox.id, row.id), row.patchState === null ? isNull(imOutbox.patchState) : eq(imOutbox.patchState, row.patchState)));
  }
}

/** 每一种改卡状态放回队列的样子；没列到的（skipped / failed / done / 空 / 以后新加的）一律当作改卡已经结了、重新排上。 */
export function requeued(patchState: string | null): Partial<typeof imOutbox.$inferInsert> {
  switch (patchState) {
    // 卡已经撤掉了：飞书上没有它，这笔账不用再还（gone() 照理已经连账一起清了，这里兜底）。
    case RECALLED: return { linkDue: null };
    // 结果卡随回执带回去了、没等到确认就退出了：照「到期没确认就当 result 改一次」的约定，现在就改。
    case "acking": return { patchState: "result", nextAt: null };
    case "pending":
    case "result":
    case RECALL: return { nextAt: null };
    default: return { patchState: "pending", attempts: 0, nextAt: null, updatedAt: now() };
  }
}
