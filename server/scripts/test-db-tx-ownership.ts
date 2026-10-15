// 共享连接上的**事务归属**：一笔写返回成功，到底算不算「已经提交」。
//
// 第 7 轮审查的 F1：全进程共用一条 `node:sqlite` 连接，而连接「正在某笔事务里」的时候，**任何**
// 别的语句都会落进那笔事务。上一版的 `batch` 只问 `db.isTransaction`、不问事务是谁的就借道跑，
// 于是删一个任务那一批中途失败时，连另一个任务刚写好的监听卡片一起回滚 —— 写方拿到的却是
// fulfilled，于是按「写成功了」把读取位置推到了文件末尾，那张卡此后刷新也补不回来。
//
// 所以这一组钉的是一句话：**batch / 写 execute 返回成功 ⇒ 它自己那一批已经提交，别人回滚拿它
// 没办法**；等不到就报错交回重试责任，绝不借道、也绝不挂死。
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "../src/db/node-sqlite-client.js";

const root = mkdtempSync(join(tmpdir(), "ash-db-tx-"));
let bad = 0;
const check = (ok: boolean, what: string, got = ""): void => {
  if (!ok) bad += 1;
  console.log(`   ${ok ? "✓" : "✗"} ${what}${ok || !got ? "" : ` —— ${got}`}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const open = (name: string, txWaitMs?: number): Client => {
  const client = createClient({ url: join(root, `${name}.db`), txWaitMs });
  return client;
};
const rows = async (client: Client): Promise<string[]> =>
  (await client.execute(`SELECT id FROM t ORDER BY id`)).rows.map((r) => String(r.id));
const seed = async (client: Client, ids: string[]): Promise<void> => {
  await client.execute(`CREATE TABLE t (id TEXT PRIMARY KEY)`);
  for (const id of ids) await client.execute({ sql: `INSERT INTO t (id) VALUES (?)`, args: [id] });
};
const insert = (id: string) => ({ sql: `INSERT INTO t (id) VALUES (?)`, args: [id] });
const del = (id: string) => ({ sql: `DELETE FROM t WHERE id = ?`, args: [id] });
/** 必然在 prepare 阶段就失败：拿它当「这一批里有一条跑不过去」。 */
const BOOM = { sql: `SELECT INJECTED_FAILURE_NO_SUCH_COLUMN` };

async function openTransactionIsNotABus(): Promise<void> {
  const client = open("not-a-bus");
  await seed(client, ["old"]);
  const tx = await client.transaction();
  await tx.execute(insert("tx-row"));

  const batched = client.batch([insert("batch-row")]);
  const executed = client.execute(insert("exec-row"));
  // 读照常放过去（它看到的是这笔事务的中间状态，一条连接本来就是这个语义）。
  const seen = await rows(client);
  check(seen.includes("tx-row"), "①事务自己的写在它自己眼里是可见的", seen.join(","));
  check(!seen.includes("batch-row") && !seen.includes("exec-row"),
    "①别人的 batch / 写 execute **没有**借道挤进这笔事务（它们在等）", seen.join(","));

  // 事务回滚：它只能抹掉自己的写。
  await tx.rollback();
  await batched;
  await executed;
  const after = await rows(client);
  check(!after.includes("tx-row"), "①回滚抹掉了事务自己的写", after.join(","));
  check(after.includes("batch-row"), "①**batch 的写活下来了**（成功就等于已提交）", after.join(","));
  check(after.includes("exec-row"), "①写 execute 的那条也活下来了", after.join(","));
  client.close();
}

async function adjacentWriteAndFailingDelete(): Promise<void> {
  for (const writeFirst of [true, false]) {
    const tag = writeFirst ? "写在前" : "删在前";
    const client = open(`adjacent-${writeFirst}`);
    await seed(client, ["keep-me"]);
    // 「成功写」与「失败删」相邻下发：删那一批尾部注一条失败语句（前面几条真的执行过）。
    const write = () => client.batch([insert("written")]);
    const doomed = () => client.batch([del("keep-me"), BOOM]);
    const [a, b] = await Promise.allSettled(writeFirst ? [write(), doomed()] : [doomed(), write()]);
    const written = writeFirst ? a! : b!;
    const failed = writeFirst ? b! : a!;
    const why = (r: PromiseSettledResult<unknown>): string =>
      r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason) : "fulfilled";
    check(written.status === "fulfilled", `②${tag}：写那一批成功`, why(written));
    check(failed.status === "rejected", `②${tag}：失败的删除整批回滚（返回失败）`, why(failed));
    const after = await rows(client);
    check(after.includes("written"), `②${tag}：成功的写没被别人的回滚带走`, after.join(","));
    check(after.includes("keep-me"), `②${tag}：失败的删除一行也没删掉`, after.join(","));
    client.close();
  }
}

async function waitHasACeiling(): Promise<void> {
  const client = open("ceiling", 60);
  await seed(client, []);
  const tx = await client.transaction();
  const started = Date.now();
  await assert.rejects(client.batch([insert("never")]), /请重试/, "等不到就报错");
  const waited = Date.now() - started;
  check(waited >= 60 && waited < 3000, "③等不到时在上限附近报错（不挂死）", `${waited}ms`);
  await assert.rejects(client.execute(insert("never-2")), /请重试/, "写 execute 同一道闸");
  // 回执类写（atomicBatch）不等：立刻把重试责任交回调用方。
  const fast = Date.now();
  await assert.rejects(client.atomicBatch([insert("never-3")]), /草稿仍保留/);
  check(Date.now() - fast < 50, "③atomicBatch 冲突时立刻交回责任（不等）", `${Date.now() - fast}ms`);
  await tx.rollback();
  const after = await rows(client);
  check(after.length === 0, "③报错的那几条写一行都没落下", after.join(","));
  check((await client.batch([insert("now-ok")])).length === 1, "③事务收尾后照常写得进去");
  client.close();
}

async function serialTransactionsDoNotCollide(): Promise<void> {
  const client = open("serial-tx");
  await seed(client, []);
  // 两笔长事务并排开：上一版第二个 BEGIN 当场报错，而任一方 ROLLBACK 会抹掉另一方的写。
  const first = await client.transaction();
  const second = client.transaction();
  await first.execute(insert("from-first"));
  await first.commit();
  const tx2 = await second;
  await tx2.execute(insert("from-second"));
  await tx2.commit();
  const after = await rows(client);
  check(after.join(",") === "from-first,from-second", "④两笔长事务依次成立，各自的写都在", after.join(","));
  client.close();
}

/**
 * 两笔 transaction() **同时**发出（谁都还没拿到句柄）。
 *
 * 上一版「先等、回来再登记」的写法在这里就破了：两个申请者都判到空，第二个覆盖账目、BEGIN
 * 失败、又按自己的名义把账清掉 —— 连接里还开着第一笔，账上却没人，邻接的根写于是借道进去
 * 被确认成功，最后被第一笔的回滚带走（第 8 轮审查 F1）。
 */
async function simultaneousAcquire(): Promise<void> {
  const client = open("simultaneous");
  await seed(client, []);
  const first = client.transaction();
  const second = client.transaction();          // 同一拍里发出，没有任何 await 分隔
  const txA = await first;
  await txA.execute(insert("owner-only"));
  const rootWrite = client.execute(insert("foreign"));   // 邻接的根写：必须在等
  await sleep(20);
  const during = await rows(client);
  check(during.includes("owner-only") && !during.includes("foreign"),
    "⑤第一笔拿到了连接，邻接的根写在等（没被确认进它的事务）", during.join(","));
  await txA.rollback();
  const txB = await second;                     // 第二笔这时才拿到，不是直接失败
  await txB.execute(insert("from-second"));
  await txB.commit();
  await rootWrite;
  const after = await rows(client);
  check(!after.includes("owner-only"), "⑤第一笔的回滚只抹掉了它自己的写", after.join(","));
  check(after.includes("foreign"), "⑤**根写没被第一笔的回滚带走**", after.join(","));
  check(after.includes("from-second"), "⑤第二笔排在后面照常成立", after.join(","));
  client.close();
}

/** 同一次收尾**唤醒好几个等待者**：也只能一个一个来。 */
async function manyWaitersOneWake(): Promise<void> {
  const client = open("many-waiters");
  await seed(client, []);
  const held = await client.transaction();
  const w1 = client.transaction();
  const w2 = client.transaction();
  const w3 = client.execute(insert("root-after"));
  await held.execute(insert("held"));
  await held.commit();                           // 一次收尾，三个等待者同时醒
  const t1 = await w1; await t1.execute(insert("w1")); await t1.commit();
  const t2 = await w2; await t2.execute(insert("w2")); await t2.commit();
  await w3;
  const after = await rows(client);
  check(after.join(",") === "held,root-after,w1,w2",
    "⑥三个等待者各自拿到连接，写的东西一条不少也不互相回滚", after.join(","));
  client.close();
}

/**
 * COMMIT **失败**之后：连接还在事务里，所以账不许提前摘，句柄也必须还能 rollback。
 *
 * 用延迟外键约束造一次真实的 COMMIT 失败（不是注入假错）。
 */
async function failedCommitKeepsOwnership(): Promise<void> {
  const client = open("failed-commit", 2000);
  await seed(client, []);
  await client.execute(`CREATE TABLE parent (id TEXT PRIMARY KEY)`);
  await client.execute(
    `CREATE TABLE child (id TEXT PRIMARY KEY, pid TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`,
  );
  const tx = await client.transaction();
  await tx.execute({ sql: `INSERT INTO child (id, pid) VALUES (?, ?)`, args: ["c1", "missing"] });
  await assert.rejects(tx.commit(), /FOREIGN KEY/i, "延迟外键在 COMMIT 这一刻才失败");

  // 连接此刻仍在那笔事务里：邻接的根写必须**还在等**，不许被确认成功。
  const rootWrite = client.execute(insert("after-failed-commit"));
  let settledEarly = false;
  void rootWrite.then(() => { settledEarly = true; }, () => { settledEarly = true; });
  await sleep(20);
  check(!settledEarly, "⑦COMMIT 失败后连接还被占着，邻接的根写没有被提前确认");

  // 句柄还能用：真的回滚掉那笔没提交的事务。
  await tx.rollback();
  await rootWrite;
  const child = (await client.execute(`SELECT id FROM child`)).rows.length;
  check(child === 0, "⑦rollback 真的生效了（没提交的子行没留下）", `${child} 行`);
  const after = await rows(client);
  check(after.includes("after-failed-commit"), "⑦等到的那条根写自己提交了，没被回滚带走", after.join(","));
  client.close();
}

async function main(): Promise<void> {
  try {
    await openTransactionIsNotABus();
    await adjacentWriteAndFailingDelete();
    await waitHasACeiling();
    await serialTransactionsDoNotCollide();
    await simultaneousAcquire();
    await manyWaitersOneWake();
    await failedCommitKeepsOwnership();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (bad) { console.error(`✗ 事务归属：${bad} 条断言不过`); process.exit(1); }
  console.log("✓ 共享连接的事务归属：别人的事务不是公交车 / 相邻的成功写与失败删各归各 /"
    + " 等待有上限且不挂死 / 两笔长事务依次成立 / 同时申请与同一次唤醒都只放一个进去 /"
    + " COMMIT 失败后账不早放、句柄还能回滚 均受回归保护");
}

await main();
