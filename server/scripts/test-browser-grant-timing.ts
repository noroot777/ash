/**
 * 浏览器授权的**时序**:读得太早 = 撤销无效,读得太晚 = 开出一个本不该起的执行器。
 *
 * 两条都不是纯函数能测出来的 —— 授权函数本身一直是对的,错的是「在哪一行调它」:
 *   ① 回合启动要经过好几个 await(runEnv / prepareResume / prepareCliInvocation)。
 *      在这些 await **之前**把授权拼进 prompt,用户在启动期间点「收回授权」就拦不住:
 *      撤销已经落库,发出去的第一条消息却还写着「已预先授权 x.com」(第 3 轮审查 P1)。
 *   ② 反过来,把 `await 读授权` 塞到「最后一次取消检查」与 `executor.run` 之间,
 *      停止请求就会落进那个窗口:stopTask 返回 true、已有执行器也被杀了,这一轮却照样
 *      起了一个新的,而它还没注册、谁也杀不到(第 3 轮审查 P2)。
 * 所以这里钉的是顺序本身:**所有 await 走完 → 读授权 → 查取消 → 启动**,中间不许再插
 * 异步。两条用例都确定性地在那个窗口里动手,不靠 sleep 赌时序。
 *
 * 跑:ASH_DB=/tmp/t.db npm -w server run test:browser-grant-timing
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("test-browser-grant-timing");
const stage = mkdtempSync(join(tmpdir(), "ash-grant-timing-"));
process.env.ASH_RUNS_DIR = join(stage, "runs");

const [{ db, ensureSchema }, schema, duet, runs, routes] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/duet/turn.js"),
  import("../src/runs.js"),
  import("../src/project-routes.js"),
]);
const { projects, tasks } = schema;
await ensureSchema();

const at = "2026-10-13T02:00:00.000Z";
const PROJECT = "grant-timing-project";
await db.insert(projects).values({
  id: PROJECT, name: "授权时序", repoPath: stage, apiKeys: null, createdAt: at,
  browserCdpDomains: ["x.com"],
});

const api = new Hono();
routes.mountProjectRoutes(api);
const setDomains = async (domains: string[]) => {
  const res = await api.request(`/projects/${PROJECT}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ browserCdpDomains: domains }),
  });
  assert.equal(res.status, 200, "PATCH 必须成功,否则下面的断言测的是别的东西");
  return (await res.json()) as { browserCdpDomains: string[] };
};
const ok = (m: string) => console.log("   ✓ " + m);

// ── 用例 1:授权读取期间收到停止,不许再起新执行器 ─────────────────────────────
// 确定性注入:把 stopTask 挂在「授权查询真的发起」那一刻(db.select 被调用时同步执行),
// 于是它必定落在读授权的 await 里 —— 正好是修复前那个检查不到的窗口。
const DUET_TASK = "grant-timing-duet";
await db.insert(tasks).values({
  id: DUET_TASK, projectId: PROJECT, groupId: null, parentId: null, title: "duet", body: "", mode: "duet",
  status: "running", labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: null, executorId: null,
  autoTitle: false, duet: null, team: null, scheduleId: null, createdAt: at, updatedAt: at,
  useWorktree: false, worktreeBase: null, originTaskId: null,
});

// 先登记一个「正在跑的参与者」,stopTask 才有东西可杀(没有活动 handle 时它直接返回 false)。
let voiceAKilled = false;
runs.trackRun(DUET_TASK, {
  sessionId: "voice-a", commandLine: "stub", kill() { voiceAKilled = true; },
  events: (async function* () { /* 一直不结束 */ await new Promise(() => {}); })(),
} as unknown as Parameters<typeof runs.trackRun>[1]);

let armed = false;
let stopAccepted = false;
const realSelect = db.select.bind(db);
(db as unknown as { select: typeof realSelect }).select = ((...args: Parameters<typeof realSelect>) => {
  if (armed) { armed = false; stopAccepted = runs.stopTask(DUET_TASK); }
  return realSelect(...args);
}) as typeof realSelect;

let voiceBStarted = false;
const voiceB = {
  type: "claude",
  label: "claude@stub",
  prepareResume: async () => { armed = true; },
  run: () => {
    voiceBStarted = true;
    return {
      sessionId: "voice-b", commandLine: "stub", kill() {},
      events: (async function* () { yield { kind: "done", exitStatus: 0 }; })(),
    };
  },
  resumeCommand: () => "stub",
  resumeFields: () => ({}),
} as unknown as Parameters<typeof duet.runTurn>[0]["executor"];

let canceled = false;
try {
  await duet.runTurn({
    taskId: DUET_TASK, role: "voiceB", speaker: "B", round: 1, runOwner: null,
    executor: voiceB, prompt: "该你说了", cwd: stage,
  });
} catch (error) {
  canceled = (error as Error).constructor.name === "CanceledRun" || /cancel/i.test(String(error));
}
(db as unknown as { select: typeof realSelect }).select = realSelect;

assert.equal(stopAccepted, true, "前置条件:停止请求必须被真的受理(否则这条用例什么都没测)");
assert.equal(voiceAKilled, true, "前置条件:已有执行器被杀,说明走的是真实停止路径");
assert.equal(voiceBStarted, false,
  "读授权期间收到停止,就不许再起新执行器 —— 它起来时还没注册,那次击杀覆盖不到它");
assert.equal(canceled, true, "这一轮应以取消收场");
ok("duet:授权读取期间收到停止,不会再启动新执行器");
runs.untrackRun(DUET_TASK);

// ── 用例 2:启动期间撤销授权,第一条消息就不该再带它 ───────────────────────────
// 不猴补丁时序:直接按「正文拼好之后」的真实顺序走一遍 —— 先拿一份启动早期的快照,
// 再撤销,然后看「起跑前那一刻现读」拿到的是哪个。读得太早的写法在这里必然露馅。
const policy = await import("../src/browser-verification-policy.js");
const early = await policy.browserGrantForProject(PROJECT);
assert.deepEqual(early?.domains, ["x.com"], "前置条件:启动早期确实是已授权的");
assert.deepEqual((await setDomains([])).browserCdpDomains, [], "启动期间用户收回了授权");
const late = await policy.browserGrantForProject(PROJECT);
assert.equal(late, null, "起跑前现读必须拿到撤销后的值");
assert.doesNotMatch(
  policy.withGlobalBrowserPolicy("正文", "full", late),
  /已由用户预先授权|x\.com/,
  "用现读的值拼出来的首条消息不得再写着已授权",
);
assert.match(
  policy.withGlobalBrowserPolicy("正文", "full", early),
  /已由用户预先授权/,
  "对照:用启动早期那份快照拼,就会把已撤销的授权发出去",
);
ok("撤销后现读与早期快照拼出的消息不同 —— 起跑前必须用前者");

// ── 用例 3:团队开台途中点「停止全组」,不许再把进程拉起来 ─────────────────────
// 开台要穿过 worktree 准备、prepareResume、授权现读几个 await,这期间 leads 里没有调度台、
// trackRun 也没发生 —— stopTask 空转、haltTeam 只把状态写成 idle,开台却照常起进程、
// beginTurn 再把状态写回 running:用户点了停止、刷新后还是「运行中」(第 4 轮审查 P1)。
// 注入点选 prepareResume:它在授权现读**之前**,所以 halt 必然落在开台途中。
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const team = await import("../src/team/session.js");

const TEAM_TASK = "grant-timing-team";
await db.insert(tasks).values({
  id: TEAM_TASK, projectId: PROJECT, groupId: null, parentId: null, title: "team", body: "带团队", mode: "team",
  status: "idle", labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: null, executorId: null,
  autoTitle: false, duet: null, team: null, scheduleId: null, createdAt: at, updatedAt: at,
  useWorktree: false, worktreeBase: null, originTaskId: null,
});

let residentStarted = false;
let haltDone = false;
const realPrepare = ClaudeExecutor.prototype.prepareResume;
const realOpen = ClaudeExecutor.prototype.openResident;
ClaudeExecutor.prototype.prepareResume = async function stubPrepare() {
  // 停止落在这里 = 开台途中:leads 还空、trackRun 还没发生,正是谁也杀不到的那一段。
  await team.haltTeam(TEAM_TASK);
  haltDone = true;
};
ClaudeExecutor.prototype.openResident = function stubResident() {
  residentStarted = true;
  return {
    sessionId: "lead-cli", commandLine: "stub", send: () => true, kill() {}, close() {},
    events: (async function* () { yield { kind: "done", exitStatus: 0 }; })(),
  } as unknown as ReturnType<NonNullable<typeof realOpen>>;
};
try {
  await team.startTeam(TEAM_TASK);
} finally {
  ClaudeExecutor.prototype.prepareResume = realPrepare;
  ClaudeExecutor.prototype.openResident = realOpen;
}

assert.equal(haltDone, true, "前置条件:停止必须在开台途中真的跑完");
assert.equal(residentStarted, false,
  "开台途中被「停止全组」撤回后,不许再启动调度台进程 —— 它起来时没人杀得到它");
assert.equal(team.teamIsLive(TEAM_TASK), false, "撤回之后团队不该还在线");
const teamRow = (await db.select().from(tasks).where(eq(tasks.id, TEAM_TASK))).at(0);
assert.equal(teamRow?.status, "idle",
  "状态必须停在 idle —— 写回 running 的话,用户刷新页面看到的就是「我停过的团队还在跑」");
ok("团队:开台途中点停止,不会再拉起调度台进程,状态停在 idle");

// ── 用例 3b:停止**完成之后**另发的新指令,不许跟着被撤回的那台一起蒸发 ───────────
// 停止把开台撤回了,但那台 promise 还挂在 opening 里:后来的新指令会排到它后面等,等来一个
// TeamOpenHalted,于是既没开台、也没退回待发列表,却被当成送达 —— 输入框清空、刷新找不到
// 原话,团队一直待命(第 5 轮审查 P1)。这里确定性地卡住第一次 prepareResume 造出那个窗口。
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
};
const statusOf = async (taskId: string) =>
  (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)?.status;
const waitFor = async (what: string, fn: () => Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`等不到:${what}`);
};
const newTeamTask = async (id: string) => {
  await db.insert(tasks).values({
    id, projectId: PROJECT, groupId: null, parentId: null, title: "team", body: "带团队", mode: "team",
    status: "idle", labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: null, executorId: null,
    autoTitle: false, duet: null, team: null, scheduleId: null, createdAt: at, updatedAt: at,
    useWorktree: false, worktreeBase: null, originTaskId: null,
  });
};

const TEAM_RESEND = "grant-timing-team-resend";
await newTeamTask(TEAM_RESEND);
const NEW_MSG = "停止已经完成，现在继续读取下一页并总结";
let firstPrepare = deferred();
let holdFirst = deferred();
let prepareCalls = 0;
const prompts: string[] = [];
ClaudeExecutor.prototype.prepareResume = async function stubPrepare() {
  if (++prepareCalls === 1) {
    firstPrepare.resolve();
    await holdFirst.promise; // 开台卡在这里 = leads 还空、trackRun 还没发生的那一段
  }
};
ClaudeExecutor.prototype.openResident = function stubResident(opts: { prompt: string }) {
  prompts.push(opts.prompt);
  return {
    sessionId: `lead-${prompts.length}`, commandLine: "stub", send: () => true, kill() {}, close() {},
    events: (async function* () { await new Promise(() => {}); })(), // 保持在线,状态停在 running
  } as unknown as ReturnType<NonNullable<typeof realOpen>>;
} as unknown as NonNullable<typeof realOpen>;

const haltedOpen = team.startTeam(TEAM_RESEND);
await firstPrepare.promise;
assert.equal(team.teamIsLive(TEAM_RESEND), true, "前置条件:这时确实有一台正在开");
await team.haltTeam(TEAM_RESEND);
assert.equal(team.teamIsLive(TEAM_RESEND), false,
  "停止之后,那台被撤回的开台不该还算在线 —— 算在线,新指令就会排到它后面");
const resent = await team.deliverToLead(TEAM_RESEND, NEW_MSG);
await waitFor("新的一台把状态写成 running", async () => (await statusOf(TEAM_RESEND)) === "running");
holdFirst.resolve(); // 放行被撤回的那一台,让它走到闸前抛 TeamOpenHalted
await haltedOpen;

assert.equal(resent, true, "停止完成后另发的新指令应当重新开台");
assert.equal(prompts.length, 1, "只该起一台:被撤回的那台一个进程都不许起");
assert.ok(prompts[0].includes(NEW_MSG), "新指令必须真的进了这台调度台的首条 prompt");
assert.equal(await statusOf(TEAM_RESEND), "running",
  "被撤回的那台不许把新一台的 running 盖回 idle —— 那会变成「指令在跑、界面写着待命」");
ok("团队:停止完成后另发的新指令会重新开台,原话真的送进去了");
runs.stopTask(TEAM_RESEND);

// ── 用例 3c:**排在**被撤回开台后面的那几条,不许谎报送达 ─────────────────────────
// 上一条是「停止已经结束后才发的」,这一条是「已经在等那台开完了,停止才到」。它们一个字都
// 没送出去:用户插话必须返回 false(上层据此退回待发送托盘),执行者汇报落进持久待送队列。
const TEAM_QUEUED = "grant-timing-team-queued";
await newTeamTask(TEAM_QUEUED);
const { pendingInbound } = await import("../src/team/inbound-queue.js");
firstPrepare = deferred();
holdFirst = deferred();
prepareCalls = 0;
const queuedOpen = team.startTeam(TEAM_QUEUED);
await firstPrepare.promise;
const queuedUser = team.deliverToLead(TEAM_QUEUED, "我排在那台开台后面");
const queuedInbound = team.sendInbound(TEAM_QUEUED, "执行者:第 3 项做完了");
await new Promise((r) => setImmediate(r)); // 让这两条真的 await 到那台开台上
await team.haltTeam(TEAM_QUEUED);
holdFirst.resolve();
await queuedOpen;
await queuedInbound;

assert.equal(await queuedUser, false,
  "排在被撤回开台后面的用户插话:一个字都没送出去,不许报送达(上层据此标 sent,原话就蒸发了)");
assert.equal(prompts.length, 1, "这一轮不该再起任何进程(上一条用例起的那台不算)");
assert.deepEqual((await pendingInbound(TEAM_QUEUED)).map((r) => r.text), ["执行者:第 3 项做完了"],
  "执行者汇报要落进持久待送队列,等下一台调度台认领 —— 它没有「退回托盘」那条路");
assert.equal(await statusOf(TEAM_QUEUED), "idle", "没有新的一台,状态就该停在 idle");
ok("团队:排在被撤回开台后面的消息,插话退回待发、汇报进持久队列,都不谎报送达");

// ── 用例 3d:撤回与新开台**交错**时,滞留的执行者汇报要交给已经在线的那台 ───────────
// 3c 测的是「撤回时没有台在线」,这一条是它的交错版:用户在停止之后另发一句,新的一台已经
// 开起来并跑完了 adoptInbound(整个消费循环里唯一一次从库里认领),旧开台才姗姗来迟地撤回。
// 这时只把汇报写进 team_inbound,它就要在库里躺到下一次换台(默认空闲回收 30 分钟),期间
// 用户继续对话也不补送 —— 调度者少了一份执行结果却毫不知情(第 5 轮审查 P1)。
const TEAM_LATE = "grant-timing-team-late-inbound";
await newTeamTask(TEAM_LATE);
const LATE_REPORT = "执行者:第 7 项做完了,请安排下一步";
firstPrepare = deferred();
holdFirst = deferred();
prepareCalls = 0;

const sends: string[] = [];
const events: unknown[] = [];
let wake: (() => void) | null = null;
const consuming = deferred();
const pushEvent = (e: unknown) => { events.push(e); wake?.(); wake = null; };
ClaudeExecutor.prototype.openResident = function stubLateResident() {
  return {
    sessionId: "late-lead", commandLine: "stub", kill() {}, close() {},
    send: (text: string) => { sends.push(text); return true; },
    events: (async function* () {
      consuming.resolve(); // 事件流被拉第一下 = 这台的 adoptInbound 已经做完了
      for (;;) {
        if (events.length) { yield events.shift() as never; continue; }
        await new Promise<void>((r) => { wake = r; });
      }
    })(),
  } as unknown as ReturnType<NonNullable<typeof realOpen>>;
} as unknown as NonNullable<typeof realOpen>;

const lateOpen = team.startTeam(TEAM_LATE);
await firstPrepare.promise;
const lateReport = team.sendInbound(TEAM_LATE, LATE_REPORT); // 排在那台开台后面
await new Promise((r) => setImmediate(r));
await team.haltTeam(TEAM_LATE);
await team.deliverToLead(TEAM_LATE, "停止完成,继续:下一页"); // 新的一台起来了
await consuming.promise;
assert.deepEqual(await pendingInbound(TEAM_LATE), [],
  "前置条件:新台认领那一刻,库里还没有这条汇报 —— 否则测的就不是「晚到」了");

holdFirst.resolve(); // 旧开台这才走到闸前抛 TeamOpenHalted
await lateOpen;
await lateReport;
pushEvent({ kind: "turnEnd" }); // 新台这一回合收尾:待送队列该在这时合并送出
await waitFor("滞留的汇报被交给已经在线的那台", async () => sends.some((t) => t.includes(LATE_REPORT)));
await waitFor("送出之后持久队列销账", async () => (await pendingInbound(TEAM_LATE)).length === 0);
ok("团队:撤回与新开台交错时,滞留的执行者汇报交给在线的那台,不必等下一次换台");
runs.stopTask(TEAM_LATE);

ClaudeExecutor.prototype.prepareResume = realPrepare;
ClaudeExecutor.prototype.openResident = realOpen;

// ── 用例 3e:冻结事实查库的工夫里收回授权,首条消息不许再带它 ─────────────────────
// 起跑前的最后一段是「查冻结事实 → 读授权 → 同步定论 → spawn」。授权要是读在查库**之前**,
// 那次查库的几十毫秒就是一个真窗口:撤销已经落库、PATCH 都 200 了,发出去的第一条消息却还
// 写着「本项目已由用户预先授权 x.com」(第 6 链第 1 轮审查 P1)。
// 注入点选冻结事实那次查询本身:把它的 then 包起来,先把真实 PATCH 撤销跑完再放行 —— 于是
// 撤销**必定**早于读授权,不靠 sleep 赌时序。
const { continueTask } = await import("../src/orchestrator.js");
const { runTask } = await import("../src/task-run.js");
const newSingleTask = async (taskId: string) => {
  await db.insert(tasks).values({
    id: taskId, projectId: PROJECT, groupId: null, parentId: null, title: "抓登录后的数据", body: "读取需要登录才能看到的内容",
    mode: "single", status: "done", labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude", executorId: null,
    autoTitle: false, duet: null, team: null, scheduleId: null, createdAt: at, updatedAt: at,
    useWorktree: false, worktreeBase: null, originTaskId: null,
  });
};
let captured = "";
const realRunSteerable = ClaudeExecutor.prototype.runSteerable;
ClaudeExecutor.prototype.prepareResume = async () => {};
ClaudeExecutor.prototype.runSteerable = function stubRun(opts: { prompt: string }) {
  captured = opts.prompt;
  return {
    sessionId: "grant-window-cli", commandLine: "stub", kill() {},
    events: (async function* () { yield { kind: "done", exitStatus: 0 }; })(),
  } as unknown as ReturnType<NonNullable<typeof realRunSteerable>>;
} as unknown as NonNullable<typeof realRunSteerable>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const plainSelect = db.select;
let hookFired = false;
// 只认 freezeFacts 那一次查询(它选的字段是 {archived, groupId},全库独一份)。
const revokingSelect = function (this: unknown, fields: unknown) {
  const builder: any = (plainSelect as any).call(this, fields);
  if (hookFired || !fields || typeof fields !== "object" || !("archived" in fields) || !("groupId" in fields)) return builder;
  hookFired = true;
  const realFrom = builder.from.bind(builder);
  builder.from = (table: unknown) => {
    const query = realFrom(table);
    const realWhere = query.where.bind(query);
    query.where = (cond: unknown) => {
      const selected = realWhere(cond);
      const realThen = selected.then.bind(selected);
      selected.then = (okFn: unknown, errFn: unknown) => setDomains([]).then(() => realThen(okFn, errFn));
      return selected;
    };
    return query;
  };
  return builder;
} as unknown as typeof db.select;
/* eslint-enable @typescript-eslint/no-explicit-any */

for (const [label, slug, domain, start] of [
  // taskId 里不许出现那个域名 —— prompt 一定带 taskId,带上就等于自己把断言喂饱了。
  ["续聊/召唤", "resume", "x.com", (taskId: string) => continueTask(taskId, "接着读下一页", { system: true, freezeGuard: true, throwOnSetupError: true })],
  ["fresh run", "fresh", "weibo.com", (taskId: string) => runTask(taskId, { freezeGuard: true })],
] as const) {
  const taskId = `grant-window-${slug}`;
  assert.deepEqual((await setDomains([domain])).browserCdpDomains, [domain], "前置条件:起跑前这个站点是已授权的");
  await newSingleTask(taskId);
  captured = "";
  hookFired = false;
  db.select = revokingSelect;
  try {
    await start(taskId);
  } finally {
    db.select = plainSelect;
  }
  assert.equal(hookFired, true, `${label}:前置条件 —— 撤销必须真的注在冻结事实那次查库上`);
  assert.deepEqual(
    (await db.select().from(projects).where(eq(projects.id, PROJECT))).at(0)?.browserCdpDomains, [],
    `${label}:前置条件 —— 撤销必须在起跑之前就已经落库`,
  );
  assert.ok(captured.length > 0, `${label}:前置条件 —— 执行器确实收到了首条消息`);
  assert.doesNotMatch(captured, /已由用户预先授权/, `${label}:已经收回的授权不许再出现在首条消息里`);
  assert.ok(!captured.includes(domain), `${label}:已经收回的站点名不许再出现在首条消息里`);
  runs.stopTask(taskId);
}
ClaudeExecutor.prototype.prepareResume = realPrepare;
ClaudeExecutor.prototype.runSteerable = realRunSteerable;
ok("启动末段撤销授权:续聊与 fresh run 两条入口的首条消息都不再带它");

// ── 用例 4:顺序不变量(防止下一次又把 await 插回窗口里)────────────────────────
// 行为用例盯的是「现在对不对」,这一条盯的是「以后还对不对」:启动点前最后一次取消检查
// 与 executor.run 之间,一个 await 都不许有。
const { readFileSync } = await import("node:fs");
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const duetSrc = src("../src/duet/turn.ts");
const grantAt = duetSrc.indexOf("await browserGrantForTask(");
const checkAt = duetSrc.indexOf("if (isCanceling(taskId)) throw new CanceledRun();", grantAt);
const runAt = duetSrc.indexOf("executor.run({", checkAt);
assert.ok(grantAt > 0 && checkAt > grantAt && runAt > checkAt,
  "duet:必须是「读授权 → 查取消 → 启动」的顺序");
assert.doesNotMatch(duetSrc.slice(checkAt, runAt), /await /,
  "duet:最后一次取消检查与 executor.run 之间不许有 await —— 停止会落进那个窗口");

for (const [label, rel] of [
  ["普通任务 fresh run", "../src/task-run.ts"],
  ["续聊/召唤", "../src/orchestrator.ts"],
] as const) {
  const text = src(rel);
  const factsAt = text.indexOf("await freezeFacts(");
  const grantAt = text.indexOf("await browserGrantForProject(", factsAt);
  const takeAt = text.indexOf("takeFreeze(", grantAt);
  const policyAt = text.indexOf("withGlobalBrowserPolicy(promptBody", takeAt);
  const startAt = text.indexOf("handle = run({", policyAt);
  assert.ok(factsAt > 0 && grantAt > factsAt && takeAt > grantAt && policyAt > takeAt && startAt > policyAt,
    `${label}:顺序必须是「查冻结事实 → 读授权 → 同步定论 → 贴策略 → spawn」`);
  // 授权要是**最后一个** await 读的。排在冻结事实查库之前,那次查库的工夫里用户收回授权
  // 就拦不住 —— 撤销已经落库,首条消息却还写着已授权(第 6 链第 1 轮审查 P1)。
  assert.doesNotMatch(text.slice(grantAt + 10, startAt).replace(/await abortFrozen\(/g, ""), /await /,
    `${label}:读授权之后到 spawn 之间只许有撤回那一个 await —— 别的 await 都会让这份授权过期`);
  // 反过来,停止标记必须留到同步段消费:takeFreeze 之后到 spawn 之间同样不许有别的 await。
  assert.doesNotMatch(text.slice(takeAt, startAt).replace(/await abortFrozen\(/g, ""), /await /,
    `${label}:消费停止标记之后到 spawn 之间不许有 await —— 停止会落进那个窗口(第 3 轮审查 P2)`);
}
const teamSrc = src("../src/team/session.ts");
assert.match(teamSrc, /await ex\.prepareResume[\s\S]{0,400}?await browserGrantForProject\(/,
  "团队开台:授权要读在 prepareResume 之后,否则开台期间撤销拦不住");
const teamGrantAt = teamSrc.indexOf("await browserGrantForProject(");
const teamGateAt = teamSrc.indexOf("if (cell.halted) throw new TeamOpenHalted();", teamGrantAt);
const teamStartAt = teamSrc.indexOf("openResident({", teamGateAt);
assert.ok(teamGrantAt > 0 && teamGateAt > teamGrantAt && teamStartAt > teamGateAt,
  "团队开台:必须是「读授权 → 消费停止标记 → 起进程」的顺序");
assert.doesNotMatch(teamSrc.slice(teamGateAt, teamStartAt), /await /,
  "团队开台:那道闸与 openResident 之间不许有 await,否则停止又会落进新窗口");
ok("顺序不变量:读授权 → 查取消/闸 → 启动,中间无 await");

rmSync(stage, { recursive: true, force: true });
releaseTmpDb();
console.log("browser grant timing tests passed");
