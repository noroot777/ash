import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, root, schema, teardown, until } from "./monitors-fixture.js";
import { setupRegression } from "./regression-fixture.js";

const { regressionEvidenceReference } = await import("../src/regression-checks.js");
const { ensureRegressionChecksSchema } = await import("../src/db/schema-regression-checks.js");
const { createClient } = await import("../src/db/node-sqlite-client.js");

try {
  const { task, repo, evidenceDir, manifest, start, wait } = await setupRegression();
  const command = "node -e \"process.exit(Number(process.env.ASH_TEST_ORDER_FAIL||0))\"";
  const at = async (time: string, fail: boolean) => {
    const originalDate = globalThis.Date;
    globalThis.Date = class extends originalDate {
      constructor(value?: string | number) { super(value ?? time); }
    } as DateConstructor;
    process.env.ASH_TEST_ORDER_FAIL = fail ? "1" : "0";
    try {
      return await start(command);
    } finally {
      globalThis.Date = originalDate;
      delete process.env.ASH_TEST_ORDER_FAIL;
    }
  };
  const collisionTime = new Date().toISOString();
  const passed = await at(collisionTime, false);
  await wait(passed);
  const failed = await at(collisionTime, true);
  await wait(failed);
  await regressionEvidenceReference(task, repo, evidenceDir);
  let records = manifest().records;
  assert.deepEqual(records.map((entry) => entry.monitorId), [failed, passed]);
  assert.equal(records[0]!.createdAt, records[1]!.createdAt);
  assert.equal(records[0]!.exitCode, 1);
  assert.equal(records[0]!.latest, true);
  assert.equal(records[1]!.supersededBy, failed);
  assert.ok(records[0]!.generation > records[1]!.generation);

  const rollback = await at(new Date(Date.parse(collisionTime) - 2_000).toISOString(), true);
  await wait(rollback);
  await regressionEvidenceReference(task, repo, evidenceDir);
  records = manifest().records;
  assert.equal(records[0]!.monitorId, rollback, "墙钟回拨不能改变登记顺序");
  assert.equal(records.filter((entry) => entry.exitCode === 1).length, 2, "两个失败都要完整呈现");

  const ready = join(root, "ready");
  const release = join(root, "release");
  writeFileSync(join(repo, "concurrent.cjs"), `
    const fs = require('node:fs');
    if (process.env.ASH_TEST_ORDER_FAIL === '1') process.exit(1);
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer);
      process.exit(0);
    }, 20);
  `);
  const concurrentCommand = "node concurrent.cjs";
  const older = await start(concurrentCommand);
  await until("较早的执行已阻塞", async () => existsSync(ready));
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records.find((entry) => entry.monitorId === older)?.passed, null);
  process.env.ASH_TEST_ORDER_FAIL = "1";
  let newer: string;
  try { newer = await start(concurrentCommand); } finally { delete process.env.ASH_TEST_ORDER_FAIL; }
  await wait(newer);
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records.find((entry) => entry.monitorId === newer)?.latest, true);
  writeFileSync(release, "release");
  await wait(older);
  await regressionEvidenceReference(task, repo, evidenceDir);
  const concurrent = manifest().records.filter((entry) => entry.command === concurrentCommand);
  assert.deepEqual(concurrent.map((entry) => [entry.monitorId, entry.exitCode, entry.latest]), [[newer, 1, true], [older, 0, false]],
    "较早命令晚结束不能覆盖较新失败");
  const failedLog = (await db.select().from(schema.regressionChecks).where(eq(schema.regressionChecks.monitorId, newer)))[0]!.logPath;
  assert.equal(readFileSync(failedLog, "utf8"), "");
  rmSync(release);
  const pending = await start(concurrentCommand);
  await until("最新代次已启动但还未完成", async () => Boolean(
    (await db.select().from(schema.regressionChecks).where(eq(schema.regressionChecks.monitorId, pending)))[0]?.startedAt));
  await regressionEvidenceReference(task, repo, evidenceDir);
  const pendingRecords = manifest().records.filter((entry) => entry.command === concurrentCommand);
  assert.equal(pendingRecords[0]!.monitorId, pending);
  assert.equal(pendingRecords[0]!.latest, true);
  assert.equal(pendingRecords[0]!.passed, null, "最新未完成记录不能回退成旧通过");
  assert.equal(pendingRecords.find((entry) => entry.monitorId === older)?.latest, false);
  writeFileSync(release, "release");
  await wait(pending);
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records.find((entry) => entry.monitorId === newer)?.exitCode, 1,
    "后续通过也不删除历史失败");

  let client = createClient({ url: join(root, "migration.db") });
  try {
    await client.executeMultiple(`CREATE TABLE regression_checks (
      monitor_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, command TEXT NOT NULL,
      cwd TEXT NOT NULL, log_path TEXT NOT NULL, log_digest TEXT, before_snapshot TEXT, after_snapshot TEXT,
      exit_code INTEGER, error TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
    ); CREATE INDEX regression_checks_task_idx ON regression_checks(task_id, created_at);`);
    for (const monitorId of ["legacy-pass", "legacy-fail"]) {
      await client.execute({ sql: "INSERT INTO regression_checks(monitor_id,task_id,role,command,cwd,log_path,created_at,exit_code) VALUES(?,?,?,?,?,?,?,?)",
        args: [monitorId, task.id, "single", command, repo, "legacy.log", "same-time", monitorId === "legacy-pass" ? 0 : 1] });
    }
    await ensureRegressionChecksSchema(client);
    await ensureRegressionChecksSchema(client);
    const legacy = (await client.execute("SELECT * FROM regression_checks ORDER BY generation")).rows;
    assert.deepEqual(legacy.map((entry) => [entry.monitor_id, entry.generation, entry.exit_code, entry.input_identity]),
      [["legacy-pass", 1, 0, null], ["legacy-fail", 2, 1, null]], "旧表迁移保留原始记录且不伪造输入证明");
    await client.execute("DELETE FROM regression_checks");
    client.close();
    client = createClient({ url: join(root, "migration.db") });
    await ensureRegressionChecksSchema(client);
    await client.execute({ sql: "INSERT INTO regression_checks(monitor_id,task_id,role,command,cwd,log_path,created_at) VALUES(?,?,?,?,?,?,?)",
      args: ["after-restart", task.id, "single", command, repo, "new.log", "earlier-time"] });
    assert.equal((await client.execute("SELECT generation FROM regression_checks")).rows[0]!.generation, 3,
      "重启和清空历史后数据库代次仍不回退");
  } finally {
    client.close();
  }
  console.log("✓ regression generations: same millisecond, clock rollback, overlapping workers, complete failure history and durable migration");
} finally {
  delete process.env.ASH_TEST_ORDER_FAIL;
  await teardown();
}
