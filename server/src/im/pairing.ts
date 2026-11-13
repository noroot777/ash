// 新设备申请连进这台 ash 时（自用模式，auth/remote-pairing.ts），给机主的飞书单聊推一张带「允许 / 拒绝」的卡：
// 人不在电脑前也能把自己的另一台设备放进来。
//
// 卡和网页顶条说的是同一张申请，哪边先点算哪边。卡上那件事没了就把卡收起来，和任务的决策卡一个路数 —— 不按
// 「发生了什么」逐件改，按现状对：还开着的配对卡，申请已经不在等着的就收。三个时机对一次：有人做了决定、申请到期、
// 通道起来（申请只在内存里，重启之后上一次运行留下的卡全是废卡）。
//
// 点下去走 actions.ts confirmJob（payload.command = "pair"）→ commands.ts paired → 以绑定的那个人的身份调
// `/api/remote-access/requests/:id/approve|deny`。那一下正办着的卡这里不碰：结局由那一下自己落。
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { PairRequestView } from "@ash/shared";
import { isMultiUser } from "../auth/mode.js";
import { onPairEvent, PAIR_REQUEST_TTL_MS, pendingPairRequests, type PairEvent } from "../auth/remote-pairing.js";
import { db } from "../db/index.js";
import { imActions, imOutbox } from "../db/schema-im.js";
import { bindingsOfApp } from "./binding.js";
import { pairCard } from "./cards.js";
import { createEnvelope } from "./envelopes.js";
import { renderCard } from "./feishu/cards.js";
import type { Destination } from "./outbox.js";
import type { Reconciler } from "./reconcile.js";
import { scopeFor } from "./scope.js";

export const PAIR_KIND = "pair";
const OPEN_STATES = ["pending", "sent", "held"];

type Decision = Extract<PairEvent, { kind: "decided" }>;

export class PairingCards {
  private unsubscribe: (() => void) | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly deps: { appId: string; reconciler: Reconciler }) {}

  /** 开始跟着申请的动静。通道起来这一下先按现状对一次：此刻等着的补上卡，已经不在的收掉。 */
  start(): void {
    this.unsubscribe = onPairEvent((event) => {
      const work = event.kind === "opened" ? this.push(event.request) : this.settle(event);
      void work.catch((error) => console.error("[ash] 飞书配对卡出错:", error));
    });
    void (async () => {
      for (const request of pendingPairRequests()) await this.push(request);
      await this.settle();
    })().catch((error) => console.error("[ash] 飞书配对卡初次对账出错:", error));
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** 给每个机主绑定推一张（同一张申请同一个人只推一次）。按钮和申请一起过期。 */
  async push(request: PairRequestView): Promise<void> {
    if (await isMultiUser()) return;
    const expiresAt = Date.parse(request.createdAt) + PAIR_REQUEST_TTL_MS;
    const ttlMs = expiresAt - Date.now();
    if (ttlMs <= 0) return;
    const { appId, reconciler } = this.deps;
    for (const binding of await bindingsOfApp(appId)) {
      // 自用模式的机主绑定（channel.ts announce 同一个判据）。
      if (binding.userId) continue;
      const dest: Destination = { receiveType: "open_id", receiveId: binding.openId, recipientOpenId: binding.openId };
      const scope = await scopeFor(appId, dest, { kind: "instance" });
      await reconciler.run(async () => {
        const known = await db.select({ id: imOutbox.id }).from(imOutbox).where(and(
          eq(imOutbox.appId, appId), eq(imOutbox.receiveId, dest.receiveId), eq(imOutbox.kind, PAIR_KIND), eq(imOutbox.subject, request.id),
        ));
        // 走到这里之前读了几次库：这段时间里申请可能已经在别处处理掉，通道也可能已经拆了。那一次收卡
        // 排在这次入队前面、当时还没有卡可收 —— 现在再发就是一张没人收的废卡。
        if (known.length || this.stopped || !pendingPairRequests().some((waiting) => waiting.id === request.id)) return;
        const rowId = nanoid(20);
        const envelope = await createEnvelope({
          outboxId: rowId, taskId: null, action: "confirm", payload: { command: "pair", requestId: request.id },
          recipientOpenId: binding.openId, generation: "c", ttlMs,
        });
        await reconciler.insert({
          id: rowId, dest, taskId: null, kind: PAIR_KIND, subject: request.id,
          content: JSON.stringify(renderCard(pairCard(request, envelope))), scope,
        });
      });
    }
    reconciler.kick();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.settle().catch((error) => console.error("[ash] 飞书配对卡到期收卡出错:", error));
    }, ttlMs + 1_000);
    timer.unref?.();
    this.timers.add(timer);
  }

  /** 还开着的配对卡里，申请已经不在等着的都收起来。decided = 刚做的那个决定（卡上照实说是允许了还是拒绝了）。 */
  async settle(decided?: Decision): Promise<void> {
    const { appId, reconciler } = this.deps;
    await reconciler.run(async () => {
      const waiting = new Set(pendingPairRequests().map((request) => request.id));
      const open = await db.select().from(imOutbox).where(and(
        eq(imOutbox.appId, appId), eq(imOutbox.kind, PAIR_KIND), inArray(imOutbox.state, OPEN_STATES),
      ));
      for (const row of open) {
        if (waiting.has(row.subject)) continue;
        // 这张卡上的按钮正被点着（占着、还没结局）：决定就是它做的，卡面由那一下收（actions.ts settle）。
        const pressing = await db.select({ id: imActions.id }).from(imActions)
          .where(and(eq(imActions.outboxId, row.id), isNotNull(imActions.usedAt), isNull(imActions.result)));
        if (pressing.length) continue;
        const text = decided?.id !== row.subject ? "这张申请失效了：过期了，或者 ash 重启过。"
          : decided.approved ? "已在别处允许这台设备连接。" : "已在别处拒绝。";
        await reconciler.resolve(row, text, null);
      }
    });
    reconciler.kick();
  }
}
