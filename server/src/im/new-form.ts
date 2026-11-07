// /new 表单上带的图片、文件。飞书卡片的表单没有上传控件，附件只能从消息里来：发 /new 时那条消息里带的（富文本里插的图），
// 和回复这张表单发过来的。转存后的路径记在表单信封的 payload.attachments 上，提交时随正文一起建任务（同网页上传）。
//
// 信封一旦被占（提交那一下）就不再收：追加按「还没被占、payload 还是读到的那份」做 CAS，提交那一边在占上之后才读附件
// （commands.ts submitted），所以回过「收下了」的附件一定赶得上那次提交；赶不上的照实说没带上。
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { imActions, imOutbox } from "../db/schema-im.js";

/** 一张表单最多带几个附件（与一条消息的上限相同，attachments.ts）。 */
export const FORM_ATTACHMENTS_MAX = 10;

/** 回复的那张表单：还能提交（open）、已经提交或过期（closed）、是别人发起的（not_yours）。 */
export type FormReply =
  | { kind: "open"; envelopeId: string; attachments: string[] }
  | { kind: "closed" }
  | { kind: "not_yours" };

const attachmentsIn = (payload: Record<string, unknown>): string[] =>
  Array.isArray(payload.attachments) ? payload.attachments.filter((path): path is string => typeof path === "string") : [];

function parse(raw: string): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(raw) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * 这条消息回复的是不是一张建任务表单（单聊的 /new、群里的 /new、/tasks 卡上换出来的那张都算）；null = 不是。
 * 卡上配过表单信封的就是表单卡（/tasks 卡换出表单后翻看按钮就作废了，换不回去）。还能提交的只认卡上此刻显示着的
 * 那个信封、没被占、没过期。
 */
export async function formReplyOf(appId: string, parents: string[], openId: string): Promise<FormReply | null> {
  if (!parents.length) return null;
  const rows = await db.select().from(imOutbox).where(and(eq(imOutbox.appId, appId), inArray(imOutbox.messageId, parents)));
  for (const row of parents.flatMap((id) => rows.filter((item) => item.messageId === id && !item.taskId))) {
    const forms = (await db.select().from(imActions).where(and(eq(imActions.outboxId, row.id), eq(imActions.action, "confirm")))
      .orderBy(desc(imActions.createdAt))).filter((envelope) => parse(envelope.payload)?.command === "newform");
    if (!forms.length) continue;
    const shown = forms.find((envelope) => row.content.includes(envelope.id));
    if (!shown || shown.usedAt || Date.parse(shown.expiresAt) <= Date.now()) return { kind: "closed" };
    if (shown.recipientOpenId && shown.recipientOpenId !== openId) return { kind: "not_yours" };
    return { kind: "open", envelopeId: shown.id, attachments: attachmentsIn(parse(shown.payload)!) };
  }
  return null;
}

/** 附件挂到表单上。返回挂上之后一共几个；null = 表单刚被提交（或作废）了，没挂上。 */
export async function attachToForm(envelopeId: string, paths: string[]): Promise<number | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const envelope = (await db.select().from(imActions).where(eq(imActions.id, envelopeId))).at(0);
    const payload = envelope && !envelope.usedAt ? parse(envelope.payload) : null;
    if (!envelope || !payload) return null;
    const attachments = [...new Set([...attachmentsIn(payload), ...paths])].slice(0, FORM_ATTACHMENTS_MAX);
    const written = await db.update(imActions).set({ payload: JSON.stringify({ ...payload, attachments }) })
      .where(and(eq(imActions.id, envelopeId), isNull(imActions.usedAt), eq(imActions.payload, envelope.payload)))
      .returning({ id: imActions.id });
    if (written.length) return attachments.length;
  }
  return null;
}

/** 提交那一下表单上挂着的附件：占上信封之后读库里那份（payload 是点下去之前读的，那之后回复进来的不在里面）。 */
export async function formAttachments(envelopeId: string): Promise<string[]> {
  const envelope = (await db.select({ payload: imActions.payload }).from(imActions).where(eq(imActions.id, envelopeId))).at(0);
  const payload = envelope ? parse(envelope.payload) : null;
  return payload ? attachmentsIn(payload) : [];
}
