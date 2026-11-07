// 发件出口的核对（OutboxGuard 的实现）：发出、改卡前都过这里，卡片回调回执带回去的卡也借同一个判据
// （actions.ts）。判据本身在 scope.ts；这里负责「按判据处理这一行」：
//   · 决策卡先按现状对一次账（收件人此刻还在不在、内容是不是此刻该有的样子）—— 对账会重渲染或收卡；
//   · 汇总类（汇总卡、/todo 清单）列着的卡有几张已经不能再给他看了：只用剩下的重排，一张不剩就不发；
//   · 还不能发：发件的作废；改卡的换成一张中性的收起卡（原卡上的正文还留在对方飞书里，不改就一直露着）；
//     回给发话人的那一句（scope.ts reply）不作废，换成一句不含 ash 数据的固定说明再发：不然他只会以为没收到；
//   · 项目此刻设成了只推标题、这一行又带着只推标题版：换成那一版。
// 改卡时这两种换法是在收回已经露出去的内容，按回写结果（result）的用途改，额度见底也照改。
// 文字消息改不了（飞书只能改卡片），不排改卡。
// 换掉的内容写回库里（content 就是「飞书上应该长的样子」），按 content 做 CAS，中途被别处改过就这一圈不发。
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { imActions, imOutbox } from "../db/schema-im.js";
import { now } from "../util.js";
import type { Turn } from "./attention.js";
import { neutralCard, summaryCard, todoText } from "./cards.js";
import { renderCard } from "./feishu/cards.js";
import { readOptions } from "./meta.js";
import { cardHeaderOf, type OutboxGuard, type OutboxRow } from "./outbox.js";
import { admit, scopeOfRow, SYSTEM_SCOPE, type Admission } from "./scope.js";

const OPEN_STATES = ["pending", "sent", "held"];
const PATCHING = ["pending", "result", "acking"];

/** 对账器上这几样（避免与 reconcile.ts 互相引用实现）。 */
export interface ExitHost {
  appId: string;
  turnKinds: readonly string[];
  run<T>(job: () => Promise<T>): Promise<T>;
  reconcile(taskIds: string[]): Promise<void>;
}

export const NEUTRAL_CONTENT = (why?: string) => JSON.stringify(renderCard(neutralCard(why)));
/** 回复核不过时换上的那一句。why 只取 scope.ts 里的固定说法。 */
export const WITHHELD_TEXT = (why: string) => `这次操作的结果不在飞书里显示了（${why}），请到 ash 网页查看。`;

export class OutboxExits implements OutboxGuard {
  constructor(private readonly host: ExitHost) {}

  /** 这一行此刻的出口判定（只读）。 */
  async admission(row: OutboxRow): Promise<Admission> {
    return admit(this.host.appId, row, (await readOptions()).titleOnlyProjectIds);
  }

  async send(row: OutboxRow): Promise<OutboxRow | null> {
    if (row.taskId && this.host.turnKinds.includes(row.kind)) await this.host.run(() => this.host.reconcile([row.taskId!]));
    return this.host.run(async () => {
      if (scopeOfRow(row)?.kind === "digest") await this.redigest(row.id);
      const fresh = await rowOf(row.id);
      if (fresh?.state !== "pending") return null;
      const verdict = await this.admission(fresh);
      if (!verdict.ok) {
        if (scopeOfRow(fresh)?.kind === "reply" && fresh.msgType === "text") return withhold(fresh, verdict.why);
        await db.update(imOutbox).set({ state: "resolved", resolution: `不发了：${verdict.why}`, resolvedAt: now(), updatedAt: now() })
          .where(and(eq(imOutbox.id, fresh.id), eq(imOutbox.state, "pending")));
        return null;
      }
      return verdict.titleOnly && fresh.brief ? useBrief(fresh) : fresh;
    });
  }

  async patch(row: OutboxRow): Promise<OutboxRow | null> {
    if (row.taskId && this.host.turnKinds.includes(row.kind) && OPEN_STATES.includes(row.state)) {
      await this.host.run(() => this.host.reconcile([row.taskId!]));
    }
    return this.host.run(async () => {
      const fresh = await rowOf(row.id);
      if (!fresh?.messageId || fresh.msgType !== "interactive" || !PATCHING.includes(fresh.patchState ?? "")) return null;
      const verdict = await this.admission(fresh);
      if (!verdict.ok) return neutralize(fresh, verdict.why);
      return verdict.titleOnly && fresh.brief ? useBrief(fresh, true) : fresh;
    });
  }

  /** 卡片回调回执里直接带回去的卡（不经发件表）：同一个判据。 */
  async outward(row: OutboxRow, card: Record<string, unknown>, brief: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
    const verdict = await this.admission(row);
    if (!verdict.ok) return JSON.parse(NEUTRAL_CONTENT(verdict.why)) as Record<string, unknown>;
    return verdict.titleOnly && brief ? brief : card;
  }

  /** 汇总类：列着的卡逐张按它们自己的来源核，不能再列的拿掉、重排；一张不剩就不发。 */
  private async redigest(rowId: string): Promise<void> {
    const row = await rowOf(rowId);
    const scope = row && scopeOfRow(row);
    if (!row || row.state !== "pending" || scope?.kind !== "digest") return;
    const titleOnly = (await readOptions()).titleOnlyProjectIds;
    const listed = scope.rowIds.length ? await db.select().from(imOutbox).where(inArray(imOutbox.id, scope.rowIds)) : [];
    const keep: OutboxRow[] = [];
    for (const item of listed) if ((await admit(this.host.appId, item, titleOnly, true)).ok) keep.push(item);
    if (keep.length === scope.rowIds.length) return;
    if (!keep.length) {
      await db.update(imOutbox).set({ state: "resolved", resolution: "不发了：列出的卡都已无权查看", resolvedAt: now(), updatedAt: now() })
        .where(and(eq(imOutbox.id, row.id), eq(imOutbox.state, "pending")));
      return;
    }
    const content = row.kind === "summary"
      ? JSON.stringify(renderCard(summaryCard(summaryItems(keep), await envelopeOf(row.id))))
      : JSON.stringify({ text: todoText(keep.map((item) => cardHeaderOf(item.content).title), keep.length, "清单刚有变动，发 /todo 看最新的。") });
    await db.update(imOutbox).set({ content, scope: JSON.stringify({ ...scope, rowIds: keep.map((item) => item.id) }), updatedAt: now() })
      .where(and(eq(imOutbox.id, row.id), eq(imOutbox.content, row.content)));
  }
}

export function summaryItems(rows: OutboxRow[]): { title: string; kind: Turn["kind"]; projectName: string }[] {
  return rows.map((row) => {
    const header = cardHeaderOf(row.content);
    return { title: header.title, kind: row.kind as Turn["kind"], projectName: header.subtitle?.split(" · ")[0] ?? "" };
  });
}

async function rowOf(id: string): Promise<OutboxRow | null> {
  return (await db.select().from(imOutbox).where(eq(imOutbox.id, id))).at(0) ?? null;
}

async function envelopeOf(outboxId: string): Promise<string> {
  return (await db.select({ id: imActions.id }).from(imActions).where(eq(imActions.outboxId, outboxId))
    .orderBy(desc(imActions.createdAt)).limit(1)).at(0)?.id ?? "";
}

/** 换成只推标题版。redact = 改卡时换（卡上已经露着全文）：按回写结果的用途改。 */
async function useBrief(row: OutboxRow, redact = false): Promise<OutboxRow | null> {
  const swapped = await db.update(imOutbox).set({ content: row.brief!, brief: null, updatedAt: now(), ...(redact ? { patchState: "result" } : {}) })
    .where(and(eq(imOutbox.id, row.id), eq(imOutbox.content, row.content))).returning();
  return swapped.at(0) ?? null;
}

/** 回复核不过：原文不发，换成固定说明（来源随之改成 system —— 那句话里已经没有 ash 的数据）。 */
async function withhold(row: OutboxRow, why: string): Promise<OutboxRow | null> {
  const swapped = await db.update(imOutbox).set({
    content: JSON.stringify({ text: WITHHELD_TEXT(why) }), brief: null, scope: JSON.stringify(SYSTEM_SCOPE), updatedAt: now(),
  }).where(and(eq(imOutbox.id, row.id), eq(imOutbox.state, "pending"), eq(imOutbox.content, row.content))).returning();
  return swapped.at(0) ?? null;
}

/** 收件人已无权查看：卡面换成中性的收起卡（还开着的顺带作废，之后有资格了对账会重新推）。 */
async function neutralize(row: OutboxRow, why: string): Promise<OutboxRow | null> {
  const at = now();
  const swapped = await db.update(imOutbox).set({
    content: NEUTRAL_CONTENT(why), brief: null, updatedAt: at, patchState: "result",
    ...(OPEN_STATES.includes(row.state) ? { state: "resolved", resolution: `收起：${why}`, resolvedAt: at } : {}),
  }).where(and(eq(imOutbox.id, row.id), eq(imOutbox.content, row.content))).returning();
  return swapped.at(0) ?? null;
}
