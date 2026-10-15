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

async function main(): Promise<void> {
  try {
    await openTransactionIsNotABus();
    await adjacentWriteAndFailingDelete();
    await waitHasACeiling();
    await serialTransactionsDoNotCollide();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (bad) { console.error(`✗ 事务归属：${bad} 条断言不过`); process.exit(1); }
  console.log("✓ 共享连接的事务归属：别人的事务不是公交车 / 相邻的成功写与失败删各归各 / 等待有上限且不挂死 / 两笔长事务依次成立 均受回归保护");
}

await main();
