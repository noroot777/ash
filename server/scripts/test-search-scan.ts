// ⌘K 搜索的**扫描策略**回归：早停必须不改结果，该下盘时不能偷懒。
//
// 背景：语料是 data/runs 下的会话文件，2026-08-26 实测 2.2 GB。原先每次查询都把所有
// 任务的全文读进内存（`Promise.all` 全量并发），一次 `?q=harness` 20 秒，还把事件循环
// 占死，用户表现为「⌘K 切完项目再点任务要等十几秒」。现在按「命中只可能落在哪一档」把
// 任务分成三堆：库里的字段就能定的不下盘，可能跨字段的全扫，只可能落会话档的按 updatedAt
// 倒序补、够 MAX_HITS 就停。
//
// 这条测试钉的是那个「省」不能省出错来 —— 排序等价、跨字段 AND 仍要命中、排除词仍要
// 看会话。性能本身在 server/src/search.ts 顶部有实测数字，不在这里量（会变成 flaky）。
// 跑：npm -w server run test:search-scan
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-search-scan-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const [{ db, ensureSchema }, schema, { searchAll }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/search.js"),
]);
const { projects, tasks } = schema;

await ensureSchema();
const iso = (minute: number) => new Date(Date.parse("2026-08-01T00:00:00.000Z") + minute * 60_000).toISOString();
const taskRow = (id: string, title: string, body: string, minute: number) => ({
  id,
  projectId: "project",
  groupId: null,
  parentId: null,
  title,
  body,
  mode: "single",
  status: "done",
  stage: null,
  reviewOf: null,
  reviewRound: null,
  reviewRequested: false,
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  agentType: "claude",
  executorId: null,
  autoTitle: false,
  duet: null,
  team: null,
  scheduleId: null,
  createdAt: iso(minute),
  updatedAt: iso(minute),
  useWorktree: false,
  worktreeBase: null,
  originTaskId: null,
});

const writeRun = (taskId: string, text: string) => {
  mkdirSync(join(root, "runs", taskId), { recursive: true });
  writeFileSync(join(root, "runs", taskId, "session.md"), text, "utf8");
};

try {
  await db.insert(projects).values({ id: "project", name: "search scan", repoPath: root, apiKeys: null, createdAt: iso(0) });

  const rows = [];
  // 60 条标题命中（够填满 MAX_HITS=50），时间越新的排越前
  for (let i = 0; i < 60; i += 1) rows.push(taskRow(`title-${String(i).padStart(2, "0")}`, `alpha 标题命中 ${i}`, "", 100 + i));
  // 只在会话里出现 alpha 的旧任务：全量扫也排在所有标题命中之后，被 50 条上限挤掉
  rows.push(taskRow("convo-old", "只在会话里", "", 1));
  // 标题里一个词、会话里另一个词 —— 跨字段 AND，只看库里的字段会漏判
  rows.push(taskRow("cross", "gamma 在标题", "", 200));
  // 排除词命中的是**会话**，库里的字段看不见它
  rows.push(taskRow("excluded", "delta 在标题", "", 201));
  await db.insert(tasks).values(rows);

  writeRun("convo-old", "这段会话里提到了 alpha。");
  writeRun("cross", "这段会话里提到了 omega。");
  writeRun("excluded", "这段会话里提到了 secretword。");

  // ── 1. 早停：标题命中填满上限时，结果与全量扫一致 ──────────────────────
  const alpha = await searchAll("alpha");
  assert.equal(alpha.length, 50, "上限就是 50 条");
  assert.ok(alpha.every((hit) => hit.field === "title"), "填满上限的这 50 条全是标题命中");
  assert.ok(
    !alpha.some((hit) => hit.kind === "task" && hit.id === "convo-old"),
    "会话命中排在所有标题命中之后，被上限挤掉 —— 早停与全量扫在这一点上必须一致",
  );
  // 挤掉的是最旧的那几条标题命中，不是随便哪几条
  assert.equal(alpha[0]?.kind === "task" ? alpha[0].id : "", "title-59", "最新的标题命中排第一");

  // ── 2. 命中不足上限时，该下盘还得下盘 ─────────────────────────────────
  const omega = await searchAll("omega");
  assert.equal(omega.length, 1, "只有会话里提过 omega");
  assert.equal(omega[0]?.kind === "task" ? omega[0].id : "", "cross");
  assert.equal(omega[0]?.kind === "task" ? omega[0].field : "", "conversation");

  // ── 3. 跨字段 AND：标题一个词 + 会话一个词，必须命中 ───────────────────
  // 这正是 partial 那一堆必须全扫的理由：它在库里的字段上只命中一半，却可能是标题档。
  // 谁把它并进「只可能落会话档」的 none 里按上限早停，这条就会挂。
  const cross = await searchAll("gamma omega");
  assert.equal(cross.length, 1, "跨字段 AND 必须命中");
  assert.equal(cross[0]?.kind === "task" ? cross[0].id : "", "cross");

  // ── 4. 排除词要看会话，不能只看库里的字段 ─────────────────────────────
  const kept = await searchAll("delta");
  assert.equal(kept.length, 1, "不带排除词时它就该在");
  const dropped = await searchAll("delta -secretword");
  assert.equal(dropped.length, 0, "排除词命中的是会话，仍要把这条剔掉");

  // ── 5. 多词查询的早停也要等价 ─────────────────────────────────────────
  // 60 条标题里同时有 alpha 和 beta（`alpha beta` 全在标题 = settled），会话里另有一条
  // 老任务两个词都有。早停必须把老的那条挤掉，且不能因为「多词」就退回全量扫。
  await db.insert(tasks).values([taskRow("convo-multi", "只在会话里(多词)", "", 2)]);
  writeRun("convo-multi", "这段会话里 alpha 和 beta 都出现了。");
  for (let i = 0; i < 60; i += 1) {
    await db.update(tasks).set({ title: `alpha beta 标题命中 ${i}` }).where(eq(tasks.id, `title-${String(i).padStart(2, "0")}`));
  }
  const multi = await searchAll("alpha beta");
  assert.equal(multi.length, 50, "多词同样收满 50 条");
  assert.ok(multi.every((hit) => hit.field === "title"), "全是标题命中");
  assert.ok(
    !multi.some((hit) => hit.kind === "task" && hit.id === "convo-multi"),
    "会话档的那条被上限挤掉 —— 与全量扫一致",
  );

  // ── 6. 纯排除查询：没有正向词，不能走会话档那套早停 ────────────────────
  // 它命中的是「所有没被排除的任务」，档位算标题档；照会话档的推导早停会漏人。
  const onlyExcluded = await searchAll("-secretword");
  assert.equal(onlyExcluded.length, 50, "纯排除查询照样能收满");
  assert.ok(
    !onlyExcluded.some((hit) => hit.kind === "task" && hit.id === "excluded"),
    "会话里带排除词的那条要被剔掉",
  );

  console.log("✓ search scan: 早停等价 + 跨字段 AND + 排除词 + 多词 + 纯排除");
} finally {
  rmSync(root, { recursive: true, force: true });
}
