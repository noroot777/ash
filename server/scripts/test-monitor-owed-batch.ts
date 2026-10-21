// 一批行的**归宿**:已交付 / 已明确放弃 / 已持久移交,三者之一（消费层文件头 ⑤）。
//
// 单开一份是因为这一类在四轮审查里连着出现了三次,每次换一个出口 ——
//  · F1-A「排干推一次就不管」:最后那一批里正是 `FINAL_DONE`,通知那一笔失败一次就地蒸发
//  · F1「空行快进越过没交付的那一批」:游标走到日志结尾,重启再也读不回来
//  · F1「收尾拿空缓冲当成没东西要交接」:**这一份钉的就是它**
// 三次的共同形状不是「某个回调写错了」,而是「责任在两个生命周期出口上答得不一样」,所以回归
// 也按那个形状组织:**在途 × 自退/到期 × 成功/失败**交叉着验,而不是只复测某一条触发路径。
//
// 台子（临时库、真模块、真子进程）与 test-monitors.ts 共用，见 monitors-fixture.ts。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { readSource } from "../../scripts/read-source.mjs";
import {
  HERE, root, db, dbClient, monitorEvents, isPidAlive,
  startMonitor, monitors, sleep, until, makeTask, pendingOf, teardown,
} from "./monitors-fixture.js";

/**
 * 让「正文里带着 `marker` 的那一笔消息入库」**挂在半空中**。
 *
 * 挂住的那一刻这一批就是「在途」:`flushBuffer` 一开头就把它从缓冲里 `splice` 走了 —— 缓冲
 * 空着,而一个字节都还没落库。挂的是底层 DB 客户端那一笔**真实语句**,产品里的收尾、消费、
 * 推送一个都没被替换。
 *
 * `after` 决定放开之后怎么走:`fail-once` = 在途那一笔失败、重试照常（行最终送出去）;
 * `fail-always` = 这几行怎么都送不出去（于是只剩「持久移交」这一条归宿）。
 */
function hangMessageInsert(marker: string, after: "fail-once" | "fail-always") {
  const real = dbClient.execute.bind(dbClient);
  let hanging = false;
  let hits = 0;
  let fire: (() => void) | null = null;
  const held = new Promise<void>((resolve) => { fire = resolve; });
  (dbClient as unknown as { execute: unknown }).execute = async (stmt: unknown) => {
    const text = typeof stmt === "string" ? stmt : String((stmt as { sql?: unknown })?.sql ?? "");
    const args = JSON.stringify((stmt as { args?: unknown })?.args ?? "");
    if (/insert into "scheduled_messages"/i.test(text) && args.includes(marker)) {
      hits += 1;
      if (hits === 1) { hanging = true; await held; }
      if (after === "fail-always" || hits === 1) throw new Error(`INJECTED_MESSAGE_INSERT_FAILURE(${marker})`);
    }
    return real(stmt as never);
  };
  return {
    hanging: () => hanging,
    hits: () => hits,
    release: () => fire!(),
    restore: () => { (dbClient as unknown as { execute: unknown }).execute = real; },
  };
}

const rowOf = async (monitorId: string) =>
  (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;

// ── Ⓐ 自退 × 在途那一批:**终态不许在它结清之前落**（第 4 轮审查 F1）────────────────
// 现场（审查实测）：命令打完 `FINAL_INFLIGHT=0` 就睡,那一笔事件 INSERT 挂在半空中（缓冲已
// 空、`inflight=1`）,命令随后自己退出 —— 收尾看一眼空缓冲就认定「没什么要交接」,结束通知
// 里一个字都没附、终态当场落定;再让那笔 INSERT 失败,行被放回一个已经撤掉、而且 closing 的
// 运行时:不排重试、接回只枚举 running、通知里也没有它（实测 status=exited、events=0、
// offset=0、待发里只有【哨兵结束】，而日志里那一行完好）。
{
  const taskId = await makeTask();
  const feed = join(root, "inflight-exit.mjs");
  // 吐一行就退:它要在那一笔 INSERT 挂住**期间**自己结束，收尾才会撞上在途窗口。
  writeFileSync(feed, `console.log("FINAL_INFLIGHT=0");
setTimeout(() => process.exit(0), 900);
`);
  const inject = hangMessageInsert("FINAL_INFLIGHT=0", "fail-once");
  let monitorId = "";
  try {
    const started = await startMonitor({
      taskId,
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
      description: "在途批次撞上自退收尾",
    });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    monitorId = started.ok ? started.monitor.id : "";
    const pid = started.ok ? started.monitor.pid ?? 0 : 0;
    await until("那一笔事件 INSERT 真的挂住了", async () => inject.hanging());
    await until("命令自己退出了（收尾这一路已经开跑）", async () => !isPidAlive(pid));
    await sleep(700);
    const mid = await rowOf(monitorId);
    // **这一条就是修的那件事**:在途那一批还没结清,终态一个字都不许落 —— 落了就等于把
    // 「还欠着几行」这件事从账上抹掉（结束通知是它们唯一的持久交接凭证）。
    assert.equal(
      mid.status, "running",
      `在途那一批没结清之前不许落终态（实际 ${mid.status}；上一版这里已经是 exited 了）`,
    );
    assert.equal(mid.events, 0, "台子前提：这一刻一个字都还没交付");
    inject.release();
    await until("终态落定", async () => (await rowOf(monitorId)).status !== "running");
    const after = await rowOf(monitorId);
    assert.equal(after.status, "exited", "命令自己跑完了 ⇒ exited");
    assert.ok(inject.hits() >= 2, `在途那一笔失败之后必须真的重试过（实际 ${inject.hits()} 次）`);
    assert.ok(after.events > 0, "重试送成了 ⇒ 事件数跟着前进");
    assert.ok(after.offset > 0, "……游标也跟着前进");
    const text = (await pendingOf(taskId)).map((m) => m.text).join("\n");
    assert.match(text, /FINAL_INFLIGHT=0/, "那一行必须真的到了 agent 手上");
    assert.match(text, /【哨兵结束】/, "结束通知照旧有");
  } finally {
    inject.restore();
  }
  console.log("✓ 自退撞上在途批次：终态等它结清之后才落，行经重试送达");
}

// ── Ⓑ 到期 × 怎么都送不出去:**附在结束通知里持久移交**（第 4 轮审查 F1）──────────────
// 同一个窗口的另一半:那几行最终一次都没送成。归宿就只剩「持久移交」——跟终态同一条 UPDATE
// 落库的那份凭证（`result_handoff_at`/`result_handoff_text`，完成闸看得见、补发扫描会接着
// 送）。游标那一侧照旧不动,所以日志里的原文还对得上。
{
  const taskId = await makeTask();
  const feed = join(root, "inflight-expiry.mjs");
  // 这一条**自己不结束**:到期那条路来收它（交叉的另一个维度）。
  writeFileSync(feed, `console.log("FINAL_OWED=0");
setInterval(() => {}, 1000);
`);
  const inject = hangMessageInsert("FINAL_OWED=0", "fail-always");
  let monitorId = "";
  let pid = 0;
  try {
    const started = await startMonitor({
      taskId,
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
      description: "在途批次撞上到期收尾",
      // 够那一行走完 tail(250ms)+批量窗口(300ms)并挂住，又早到不必干等。
      timeoutMs: 1_500,
    });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    monitorId = started.ok ? started.monitor.id : "";
    pid = started.ok ? started.monitor.pid ?? 0 : 0;
    await until("那一笔事件 INSERT 真的挂住了", async () => inject.hanging());
    await sleep(1_400);
    assert.equal((await rowOf(monitorId)).status, "running", "到期收尾也要等在途那一批结清");
    inject.release();
    await until("终态落定", async () => (await rowOf(monitorId)).status !== "running", 20_000);
    const after = await rowOf(monitorId);
    assert.equal(after.status, "expired", "盯满了时长 ⇒ expired");
    assert.equal(after.events, 0, "一次都没送成 ⇒ 事件数不许虚报");
    assert.equal(after.offset, 0, "没交付的那一批不许推游标：日志里的原文还要对得上");
    assert.match(readFileSync(after.logPath, "utf8"), /FINAL_OWED=0/, "原文还在日志里");
    assert.ok(after.resultHandoffAt, "结束通知的凭证必须在（完成闸据它拦住「结果还没交」）");
    assert.match(
      after.resultHandoffText ?? "", /FINAL_OWED=0/,
      "送不出去的那几行必须附在结束通知里 —— 这是它们唯一的持久归宿",
    );
    assert.match(after.resultHandoffText ?? "", /没能单独送出来/, "而且要说清它们为什么在这儿");
    // 持久移交不是「写进一列就算完」:凭证在场 ⇒ 送得出去的时候真的送得出去。
    inject.restore();
    await monitorEvents.deliverResultHandoff(monitorId);
    await until("那几行最终还是到了 agent 手上", async () =>
      (await pendingOf(taskId)).some((m) => m.text.includes("FINAL_OWED=0")));
  } finally {
    inject.restore();
  }
  if (pid) await until("进程被收掉", async () => !isPidAlive(pid));
  console.log("✓ 到期撞上送不出去的批次：附在结束通知里持久移交，游标不动，补发真能送出去");
}

// ── Ⓒ 这一问归消费层,收尾那一层不许自己判（结构锁）──────────────────────────────────
// 上面两节都是时序,而时序回归只保护**跑到过的那一条路**。这一条管的是形状:哪天有人在收尾
// 里再写一次「缓冲空了就没东西要交接」,时序未必再撞上,形状一定对不上。
{
  const src = readSource(join(HERE, "../src/monitors.ts"));
  assert.match(src, /owed = await drainOwed\(/, "排干与「还欠哪几行」归消费层一处回答");
  assert.doesNotMatch(
    src, /while \(rt\.buffer\.length\)/,
    "收尾里不许按缓冲长度循环:在途那一批已经从缓冲里取走了（见消费层文件头 ⑤）",
  );
  console.log("✓ 结构锁：收尾不自己判「还有没有东西要交接」");
}

await teardown();
console.log("✅ 一批行的归宿：交付 / 明确放弃 / 持久移交，三者之一");
