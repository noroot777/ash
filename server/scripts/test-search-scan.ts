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

const [{ db, ensureSchema }, schema, search, { SINGLE_ACTOR }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/search.js"),
  import("../src/auth/context.js"),
]);
// searchAll 现在必须说明「谁在搜」(可见项目 + 随手记归属两条轴,见 search.ts 顶部)。
// 这条用例只关心扫描策略,统一以自用模式的隐式本地用户身份搜 —— 那一档两条轴都不设限,
// 与本轮改动之前的行为逐字节一致。可见性本身由 test:search-visibility 钉。
const searchAll = (query: string, options?: Parameters<typeof search.searchAll>[2]) =>
  search.searchAll(query, SINGLE_ACTOR, options);
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

  // ── 7. 本项目优先：先扫本项目、再扫别的项目，顺序与流式分界都要对 ──────────
  // 分段扫之所以成立，全靠 compareSearchHits 里「当前项目在前」排在字段之前：本项目的
  // 命中整体压过别的项目，所以先出本项目不会中途重排。谁把那把钥匙挪到字段后面，这条挂。
  await db.insert(projects).values({ id: "other", name: "别的项目", repoPath: root, apiKeys: null, createdAt: iso(0) });
  await db.insert(tasks).values([
    { ...taskRow("zeta-local", "zeta 在本项目", "", 300), projectId: "project" },
    // 更新时间比本项目那条**新**：没有「本项目优先」它就该排前面
    { ...taskRow("zeta-other", "zeta 在别的项目", "", 500), projectId: "other" },
  ]);

  const zetaPlain = await searchAll("zeta");
  assert.deepEqual(
    zetaPlain.map((hit) => hit.id),
    ["zeta-other", "zeta-local"],
    "不给 preferProjectId 时按老规矩排：同为标题档，新的在前",
  );

  const streamed: string[] = [];
  let markerAt = -1;
  const zetaLocal = await searchAll("zeta", {
    preferProjectId: "project",
    onHit: (hit) => streamed.push(hit.id),
    onLocalDone: () => { markerAt = streamed.length; },
  });
  assert.deepEqual(
    zetaLocal.map((hit) => hit.id),
    ["zeta-local", "zeta-other"],
    "本项目的命中排在别的项目前面，哪怕它更旧",
  );
  assert.deepEqual(streamed, ["zeta-local", "zeta-other"], "流式回调吐出的是同一批，且本项目先出");
  assert.equal(markerAt, 1, "local-done 这条分界正好落在本项目最后一条之后");

  // ── 8. 本项目自己就收满上限时，别的项目整个不用碰 ──────────────────────
  // 60 条 `alpha beta` 标题命中全在 project 里，上限 50 —— 别的项目再新也挤不进来。
  await db.insert(tasks).values([{ ...taskRow("alpha-other", "alpha beta 在别的项目", "", 900), projectId: "other" }]);
  const capped = await searchAll("alpha beta", { preferProjectId: "project" });
  assert.equal(capped.length, 50, "仍是 50 条");
  assert.ok(
    capped.every((hit) => hit.projectId === "project"),
    "本项目已经收满，别的项目那条（更新、且是标题档）不该出现 —— 这就是分段早停省下的那一大半扫描",
  );

  // ── 9. 流式与整份必须是同一次搜索 ─────────────────────────────────────
  // 两条路（`/search` 与 `/search/stream`）跑的是同一个 searchAll，但早停发生在扫描过程中，
  // 「回调吐过的」和「最终返回的」是两个不同时刻的集合。差了就是界面上多出/少掉几条。
  const pushed: string[] = [];
  const returned = await searchAll("alpha", { preferProjectId: "project", onHit: (hit) => pushed.push(hit.id) });
  const pushedSet = new Set(pushed);
  assert.ok(returned.length > 0, "这一查得有结果，不然下面这条断言是空转");
  assert.ok(
    returned.every((hit) => pushedSet.has(hit.id)),
    "整份返回的每一条都被回调吐过（回调可能多吐几条 —— settled 那批不早停，最终按上限切掉）",
  );

  // ── 10. 中断信号一到就停手 ────────────────────────────────────────────
  // ⌘K 每敲一个字就是一次新的全盘扫。不中断上一次，几十个扫描叠在一起会把事件循环占死。
  const aborted = new AbortController();
  aborted.abort();
  const nothing = await searchAll("omega", { signal: aborted.signal });
  assert.equal(nothing.length, 0, "已经取消的搜索不该再下盘扫会话");

  // 掐掉的那一刻就得停，**不能只停在批次边界**：一批是 SCAN_CONCURRENCY 个任务，
  // 单个任务目录实测能到 586 MB，「把这一批读完再说」就是旧查询继续占着 I/O。
  // 查询词故意超过 12 个字符：8-12 位的纯 [a-z0-9_-] 会被当成任务 id 候选，那条路根本不
  // 下盘（settled 档），测不到这里要测的东西。
  const abortRows = [];
  for (let i = 0; i < 40; i += 1) abortRows.push(taskRow(`abortrow-${i}`, `只在会话里 ${i}`, "", 600 + i));
  await db.insert(tasks).values(abortRows);
  for (const row of abortRows) writeRun(row.id, "这段会话里提到了 abortonlyinconversation。");
  const midway = new AbortController();
  let emitted = 0;
  const partialRun = await searchAll("abortonlyinconversation", {
    signal: midway.signal,
    onHit: () => { emitted += 1; midway.abort(); },
  });
  assert.ok(partialRun.length < abortRows.length, "掐掉之后不该把 40 个任务全扫完");
  assert.equal(emitted, 1, "第一条吐出去就被掐掉了，同一批里剩下的不该再吐（只在批次边界检查的话，这一批剩下的全会吐出去）");

  // ── 11. 按 id 命中只满足它自己那一个词，AND 语义不能被它绕过 ────────────
  // `<id> 另一个词` 是 AND。曾经把所有正向词的 id 候选拍平成全局集合、任一撞上就整条命中，
  // 于是 `<id> 根本不存在的词` 也会返回那个任务 —— 用户回车打开的是一个并不满足他查询的
  // 任务，界面还给它挂着「就是这个任务」。
  await db.insert(tasks).values([taskRow("abcdefgh1234", "id 快路径 kappa", "", 700)]);
  writeRun("abcdefgh1234", "这段会话里提到了 lambdaword。");

  const plainId = await searchAll("abcdefgh1234");
  assert.equal(plainId.length, 1, "光给 id 要能命中（任务自己的 id 不在自己的标题/正文里）");
  assert.equal(plainId[0]?.kind === "task" ? plainId[0].field : "", "id");

  const idAndMissing = await searchAll("abcdefgh1234 definitelyabsent");
  assert.equal(idAndMissing.length, 0, "同组另一个词哪儿都没有，就不该命中");

  const idAndTitle = await searchAll("abcdefgh1234 kappa");
  assert.equal(idAndTitle.length, 1, "同组另一个词在标题里，命中");
  assert.equal(idAndTitle[0]?.kind === "task" ? idAndTitle[0].field : "", "id", "按 id 那一档仍然钉在最前");

  // id 满足一个词、会话满足另一个词 —— 它必须落进 partial 全扫，不能因为「有 id」
  // 就被当成 settled 而不下盘（那样这条永远搜不到）。
  const idAndConversation = await searchAll("abcdefgh1234 lambdaword");
  assert.equal(idAndConversation.length, 1, "另一个词只在会话里，仍要读会话才能确认命中");

  const idExcluded = await searchAll("abcdefgh1234 -lambdaword");
  assert.equal(idExcluded.length, 0, "排除词命中会话时，按 id 钉也要让位");

  console.log("✓ search scan: 早停等价 + 跨字段 AND + 排除词 + 多词 + 纯排除 + 本项目优先 + 流式一致 + 中断即停 + id 不绕过 AND");
} finally {
  rmSync(root, { recursive: true, force: true });
}
