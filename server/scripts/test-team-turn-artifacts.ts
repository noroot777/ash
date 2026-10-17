// 团队调度台的**回合身份 ↔ 产物归属**：插话之后新做出来的东西必须还在生成物清单里。
//
// 为什么要单独一条、而且非得走真实常驻泵：这两条路**一个故障都不需要**（第二条只需要一次
// 寻常的写库失败），.md、状态、trace 全是对的,库里也没有脏数据 —— 坏的只是「哪一轮在什么
// 时候跑过」这份账,而它唯一的出口就是生成物面板。所以判据只能架在 `readTaskArtifacts` 的
// 返回值上：图在不在清单里、面板说没说实话。
//
//   ① 用户插话:ash 先 interrupt 再 send,新一轮当场开跑,而被打断那一轮的进程过一会儿才吐
//      出它的 turnEnd。按「此刻的 lead.turnStart」结算那个结束事件,就等于把**新**回合提前
//      收口 —— 它真正干活那段落进两条记录之间的空洞,那一轮的图永久漏在清单外（第 1 轮 F1）。
//   ② 开始状态那次写库失败:活动身份已经登记在册,可会话行上还留着上一轮的 ended_at、任务
//      状态也还没刷成 running。读端拿这两个二手快照去否决一手的活动身份,正在写的这一轮就被
//      算成「崩了没收口」,区间夹回旧起点,此后落盘的图当场消失（第 1 轮 F3）。
//   ③ 两条要求撞在同一毫秒:时间字符串不是身份,队列、唯一键和活动册同时把两轮合成一轮,
//      后开那一轮被前一轮的结束事件提前收口 —— 它做好的海报永久漏在清单外（第 2 轮 F1）。
//   ④ 一轮结束之后迟到的开始信息:把已经终结的身份重新排进队列,下一次结束就关错人 —— 真正
//      刚结束的那一轮一直留在活动册上,读端把区间开到无穷,之后别人做的图全算成它的（第 2 轮 F2）。
//   ⑤ **正常关台**之后迟到的开始信息:这台没被接管,所以不摘牌,老判据（只看 retired）放它过去
//      —— 开出来的身份进了活动册,而关掉的台不会再有任何结束事件来注销它。读端于是从那个起点
//      开到无穷**且不标 approx**,停工之后别人在同一个目录里做的东西全算成它的（本轮第 1 条）。
//   ⑥ 换台（工作目录被抽走）：摘牌在接管那一瞬就发生,旧进程的 close 事件晚一步才到。收尾那
//      一下去读「手上攥着什么」时队列早空了,只补了一个单值,被打断和还排着的那几轮永远留在
//      `ended_at = NULL`,面板报假缺口、区间跟着放宽（本轮第 3 条）。
//   ⑦ 回合在「开始那半边还没写完」时就收口了:开始那半边继续往下写,把已经收口的身份塞回活动
//      册、把任务状态改回 running —— 又回到「从那个起点开到无穷」（本轮第 2 条）。
//
// 跑:npm -w server run test:turn-identity（链在它后面）
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("team-turn-artifacts");
const stage = realpathSync(mkdtempSync(join(tmpdir(), "ash-team-turn-artifacts-")));
process.on("exit", () => {
  try { rmSync(stage, { recursive: true, force: true }); } catch { /* 文件还开着就留给下次 */ }
});
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
process.env.ASH_TEAM_IDLE_MS = "600000"; // 别让空闲回收在断言中间把台收掉
process.env.ASH_TEAM_STATUS_RETRY_MS = "40";
mkdirSync(process.env.ASH_RUNS_DIR, { recursive: true });

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { freshTurnFields, nextTurnStart, openTurn, recordTurnSpan, activeTurnStarts } = await import("../src/session-turns.js");
const { heldTurns, releaseHeldTurn } = await import("../src/team/lead-turns.js");
const { createSessionConsumer } = await import("../src/team/session-consumer.js");
const { attachLead, deliverToLead, teamIsLive } = await import("../src/team/session.js");
const { openCodexResident } = await import("../src/executors/codex-resident.js");
const { readTaskArtifacts } = await import("../src/task-artifacts.js");
const { eq } = await import("drizzle-orm");

await ensureSchema();

const ok = (m: string) => console.log("   ✓ " + m);
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const until = async (check: () => boolean, what: string) => {
  for (let tries = 0; tries < 600; tries += 1) {
    if (check()) return;
    await pause(20);
  }
  throw new Error(`等不到：${what}`);
};
const svg = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180"><text y="90">${label}</text></svg>`;

/** 一个干净的 git 工作区（`output/` 不纳入版本管理,产物走「未纳入版本管理」那一档）。 */
function initRepo(name: string): string {
  const root = join(stage, name);
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "team turn artifacts");
  git("config", "user.email", "test@example.test");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", join(stage, "no-hooks"));
  writeFileSync(join(root, ".gitignore"), "output/\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  mkdirSync(join(root, "output"));
  return root;
}

const openedAt = new Date(Date.now() - 60_000).toISOString();

/** 种一条 team 任务 + 它的调度台会话行,返回工作区目录。 */
async function seed(name: string, taskId: string, sessId: string): Promise<string> {
  const root = initRepo(name);
  await db.insert(projects).values({ id: `project-${taskId}`, name, repoPath: root, createdAt: openedAt });
  await db.insert(tasks).values({
    id: taskId, projectId: `project-${taskId}`, title: name, body: "回合身份与产物归属回归",
    mode: "team", status: "running", agentType: "codex", autoTitle: false, useWorktree: false,
    team: JSON.stringify({ lead: "codex", worker: "codex" }),
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", createdAt: openedAt, updatedAt: openedAt,
  });
  await db.insert(sessions).values({
    id: sessId, taskId, role: "lead", agentType: "codex", executor: "fixture", cwd: root,
    cliSessionId: "fixture-thread", startedAt: openedAt, activeMs: 0, ...freshTurnFields(openedAt),
  });
  mkdirSync(join(stage, "runs", taskId), { recursive: true });
  return root;
}

const listing = (taskId: string, root: string) => readTaskArtifacts(taskId, {
  path: root, repo: root, projectId: `project-${taskId}`, branch: "main", gitRepo: true, source: "session",
} as never);
const paths = (result: { artifacts: { path: string }[] }) => result.artifacts.map((a) => a.path).sort();

/**
 * 一个由测试**按条推事件**的常驻句柄。
 *
 * ③④ 要验的是「一个匿名 `turnEnd` 到底关掉哪一轮」,所以必须精确控制结束事件的个数和先后；
 * 真实常驻泵（`openCodexResident`,用例 ① 用的就是它）只保证「一次被接受的投入对应一个
 * turnEnd」,而那正是这两条用例的**前提**而不是被测对象。投递口、所有权层、记账层和读端
 * 全是生产代码。
 */
function pushHandle() {
  const queued: AgentEvent[] = [];
  let wake = () => {};
  const push = (event: AgentEvent) => { queued.push(event); wake(); };
  const handle = {
    sessionId: "fixture-thread",
    commandLine: "fixture-codex",
    events: (async function* (): AsyncGenerator<AgentEvent> {
      for (;;) {
        // 这里到 await 之间没有别的 await,所以「刚判过空就被推进来一条」这个窗口不存在。
        if (!queued.length) await new Promise<void>((resolve) => { wake = resolve; });
        while (queued.length) {
          const event = queued.shift()!;
          yield event;
          if (event.kind === "done") return;
        }
      }
    })(),
    send: () => true,
    interrupt: () => {},
    dropSession: () => {},
    close: () => push({ kind: "done", exitStatus: 0 }),
    kill: () => push({ kind: "done", exitStatus: 0 }),
  };
  return { handle, push };
}

/** 手工组装一台调度台（生产路径是 openLead,它要解析项目与执行器,这里只要那台对象本身）。 */
function lead(taskId: string, sessId: string, root: string, handle: unknown, turnStart: string) {
  return {
    taskId, sessId, cliSessionId: "fixture-thread", agentType: "codex" as const, ownerUserId: null,
    executorId: null, model: null, reasoningEffort: null, cwd: root, handle,
    out: createWriteStream(join(stage, "runs", taskId, `${sessId}.md`), { flags: "a" }),
    busy: true, turnStart, pending: [], notices: [], pendingCredential: null,
    wantedStatus: null, statusTimer: null, retired: false, idleTimer: null, closing: null,
  };
}

try {
  // ── ① 真实常驻泵 + 真实插话：新一轮做出来的图必须在清单里（第 1 轮审查 F1）──────────
  {
    const taskId = "team-artifacts-interrupt";
    const sessId = "sess-interrupt";
    const root = await seed("interrupt", taskId, sessId);
    const started: string[] = [];
    let letUserSpeak = () => {};
    let letUserFinish = () => {};
    const userSpoke = new Promise<void>((resolve) => { letUserSpeak = resolve; });
    const userFinished = new Promise<void>((resolve) => { letUserFinish = resolve; });
    let killInitial = () => {};
    const initialKilled = new Promise<void>((resolve) => { killInitial = resolve; });
    // 真实的 codex 常驻泵：回合串行,打断 = 杀掉当前回合的进程,被杀那一轮退出时泵照样补一个
    // turnEnd,**然后**才起用户那一轮。只有最底层的「一个回合的事件源」换成了本地生成器。
    const resident = openCodexResident({
      initialSessionId: "fixture-thread",
      initialPrompt: "INITIAL",
      startTurn(prompt: string) {
        const name = prompt.includes("INITIAL") ? "INITIAL" : "USER";
        started.push(name);
        return {
          child: { name } as never,
          commandLine: "fixture-codex",
          lifecycle: { stopRequested: false },
          events: (async function* (): AsyncGenerator<AgentEvent> {
            if (name === "INITIAL") await initialKilled;
            else {
              await userSpoke;
              yield { kind: "text", text: "新要求的海报已经落盘。" };
              await userFinished;
            }
            yield { kind: "done", exitStatus: 0 };
          })(),
        };
      },
      killTurn(child: unknown) {
        if ((child as { name: string }).name === "INITIAL") killInitial();
        else letUserFinish();
      },
    });
    const desk = lead(taskId, sessId, root, resident, openedAt);
    writeFileSync(join(root, "output", "before-interrupt.svg"), svg("before"));
    attachLead(desk as never);
    await openTurn({ sessionId: sessId, taskId, cwd: root, startedAt: openedAt });
    assert.deepEqual([...activeTurnStarts(sessId)], [openedAt], "前置条件:首轮的身份在册");
    assert.equal(await deliverToLead(taskId, "先停下旧要求,按新要求画海报"), true, "前置条件:插话真进了调度台");
    await until(() => started.includes("USER"), "真实常驻泵起用户那一轮");
    // 落定余量（SETTLE_MS=2s）之后才落盘：这样它**只可能**靠插话那一轮自己的区间被认出来,
    // 旧回合的区间再怎么加宽限也盖不到。修复前这里是两条记录之间的空洞。
    await pause(2600);
    writeFileSync(join(root, "output", "new-user-poster.svg"), svg("after interrupt"));
    const during = await listing(taskId, root);
    assert(paths(during).includes("output/new-user-poster.svg"),
      `插话那一轮正在写,它刚做出来的图却不在清单里：${JSON.stringify(paths(during))} / ${JSON.stringify(during.incomplete)}`);
    letUserSpeak();
    await pause(100);
    letUserFinish();
    resident.close();
    await until(() => !teamIsLive(taskId), "这台收完台");
    const after = await listing(taskId, root);
    assert.deepEqual(paths(after), ["output/before-interrupt.svg", "output/new-user-poster.svg"],
      `收完台之后两张图都该在清单里,实际：${JSON.stringify(paths(after))}`);
    assert.deepEqual(after.incomplete, [],
      `两轮都正常收了口,面板不该说有缺口,实际：${JSON.stringify(after.incomplete)}`);
    assert.deepEqual([...activeTurnStarts(sessId)], [], "收完台一个活动身份都不该留");
    ok("用户插话:新一轮做出来的图在清单里,面板不报缺口");
  }

  // ── ② 开始状态写库失败：登记在册的那一轮不许被陈旧快照否决（第 1 轮审查 F3）──────────
  {
    const taskId = "team-artifacts-stale";
    const sessId = "sess-stale";
    const root = await seed("stale", taskId, sessId);
    let letLast = () => {};
    const last = new Promise<void>((resolve) => { letLast = resolve; });
    let letSecond = () => {};
    const second = new Promise<void>((resolve) => { letSecond = resolve; });
    const handle = {
      sessionId: "fixture-thread",
      commandLine: "fixture-codex",
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { kind: "turnEnd" }; // 上一轮正常收尾 —— 会话行上就此留下一个 ended_at
        await second;
        yield { kind: "turnEnd" };
        await last;
        yield { kind: "done", exitStatus: 0 };
      })(),
      send: () => true,
      interrupt: () => {},
      dropSession: () => {},
      close: () => { letLast(); },
      kill: () => { letLast(); },
    };
    const desk = lead(taskId, sessId, root, handle, openedAt);
    attachLead(desk as never);
    await openTurn({ sessionId: sessId, taskId, cwd: root, startedAt: openedAt });
    await until(() => !activeTurnStarts(sessId).size, "上一轮正常收尾");
    const settled = (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!;
    assert(settled.endedAt, "前置条件:上一轮的收尾时刻确实写在会话行上");
    // 寻常的一次写库失败：回合开始状态刷不上去（`ended_at` 没被清回 null、`turn_started_at`
    // 还是上一轮的）,而开始行与活动登记照常。任务状态也一起挡住,复现「状态还没刷成 running」
    // 的那个窗口 —— 两个都是二手快照,都不该否决一手的活动身份。
    await dbClient.executeMultiple(`
      CREATE TRIGGER stale_block_session BEFORE UPDATE OF turn_started_at ON sessions BEGIN SELECT RAISE(ABORT,'injected'); END;
      CREATE TRIGGER stale_block_task BEFORE UPDATE ON tasks WHEN NEW.id='${taskId}' BEGIN SELECT RAISE(ABORT,'injected'); END;
    `);
    try {
      assert.equal(await deliverToLead(taskId, "接着画第二张"), true, "前置条件:插话进了调度台");
      await until(() => activeTurnStarts(sessId).size === 1, "新一轮持有自己的身份");
      await pause(50);
      const row = (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!;
      assert.equal(row.endedAt, settled.endedAt, "前置条件:会话行上那个陈旧的收尾时刻确实没被清掉");
      writeFileSync(join(root, "output", "live.svg"), svg("live"));
      const live = await listing(taskId, root);
      assert(paths(live).includes("output/live.svg"),
        `这一轮正在写,它刚落盘的图却被排除了：${JSON.stringify(paths(live))} / ${JSON.stringify(live.incomplete)}`);
      assert(!live.incomplete.some((note) => note.includes("没留下收尾时刻")),
        `正在跑的那一轮被当成「崩了没收口」,实际提示：${JSON.stringify(live.incomplete)}`);
    } finally {
      await dbClient.executeMultiple("DROP TRIGGER IF EXISTS stale_block_session; DROP TRIGGER IF EXISTS stale_block_task;");
    }
    letSecond();
    letLast();
    await until(() => !teamIsLive(taskId), "这台收完台");
    ok("开始状态写库失败:登记在册的那一轮照样算在写,它的产物不被排除");
  }

  // ── ③ 两条要求撞在同一毫秒：各占一个位置,各自一份独立生命周期（第 2 轮审查 F1）────────
  {
    const taskId = "team-artifacts-collide";
    const sessId = "sess-collide";
    const root = await seed("collide", taskId, sessId);
    const { handle, push } = pushHandle();
    const desk = lead(taskId, sessId, root, handle, openedAt);
    attachLead(desk as never);
    await openTurn({ sessionId: sessId, taskId, cwd: root, startedAt: openedAt });
    // **怎么确定地复现「同一毫秒」**：把这条会话的分配水位推到一个还没到的时刻,于是接下来
    // 两次投递都会发现 `now()` 不晚于水位 —— 跟两条消息真撞在同一毫秒时走的是同一个分支。
    // （改全局时钟会把这条链上所有写库时刻一起钉死,反而测不出东西；审查那边是靠连发输入
    // 自然撞上的,这里要的是每次都撞。）
    const ahead = new Date(Date.now() + 500).toISOString();
    nextTurnStart(sessId, ahead);
    assert.equal(await deliverToLead(taskId, "先按第一条要求改"), true, "前置条件:第一条进了调度台");
    assert.equal(await deliverToLead(taskId, "不对,按第二条要求画海报"), true, "前置条件:第二条进了调度台");
    const held = heldTurns(desk as never);
    assert.equal(held.length, 3, `首轮 + 两条要求 = 三份生命周期,实际：${JSON.stringify(held)}`);
    assert.equal(new Set(held).size, 3, `三个身份必须互不相同,实际：${JSON.stringify(held)}`);
    assert(held[1] > ahead && held[2] > ahead,
      "投递口的起点必须是**身份层分配**的那个（严格晚于这条会话见过的全部起点）。直接取墙钟"
      + `就会落在水位之前,两条消息同毫秒时还会撞成一个：${JSON.stringify(held)} / 水位 ${ahead}`);
    assert.deepEqual([...activeTurnStarts(sessId)].sort(), [...held].sort(),
      "队列和活动册是同一份账（一边收下一边拒掉,下一次结束就关错人）");
    // 两个匿名 turnEnd：按 FIFO 关掉首轮和第一条要求那一轮。第二条要求那一轮还在跑。
    push({ kind: "turnEnd" });
    await until(() => activeTurnStarts(sessId).size === 2, "首轮收口");
    push({ kind: "turnEnd" });
    await until(() => activeTurnStarts(sessId).size === 1, "第一条要求那一轮收口");
    assert.deepEqual([...activeTurnStarts(sessId)], [held[2]],
      "还在跑的必须是第二条要求那一轮（起点一撞,这一轮就被前一轮的结束事件提前收口）");
    // 落定余量之后才落盘：这张海报只可能靠第二条要求那一轮自己的区间被认出来。
    await pause(3000);
    writeFileSync(join(root, "output", "second-request.svg"), svg("second request"));
    const during = await listing(taskId, root);
    assert(paths(during).includes("output/second-request.svg"),
      `第二条要求那一轮正在写,它刚做好的海报却不在清单里：${JSON.stringify(paths(during))} / ${JSON.stringify(during.incomplete)}`);
    push({ kind: "turnEnd" });
    await until(() => !activeTurnStarts(sessId).size, "第二条要求那一轮收口");
    push({ kind: "done", exitStatus: 0 });
    await until(() => !teamIsLive(taskId), "这台收完台");
    const after = await listing(taskId, root);
    assert.deepEqual(paths(after), ["output/second-request.svg"],
      `收完台之后那张海报仍该在清单里,实际：${JSON.stringify(paths(after))}`);
    assert.deepEqual(after.incomplete, [],
      `三轮各有一行完整记录,面板不该说有缺口,实际：${JSON.stringify(after.incomplete)}`);
    const rows = (await dbClient.execute(
      `SELECT started_at, ended_at FROM session_turns WHERE session_id='${sessId}' ORDER BY started_at`,
    )).rows;
    assert.equal(rows.length, 3, `库里也要三行（唯一键同样按起点认人）,实际：${JSON.stringify(rows)}`);
    assert(rows.every((row) => row.ended_at), `三行都该收过口,实际：${JSON.stringify(rows)}`);
    ok("同一毫秒的两条要求:各自一份生命周期,后一轮的海报不漏列");
  }

  // ── ④ 结束之后迟到的开始信息：不许重开一个已经终结的所有权（第 2 轮审查 F2）──────────
  {
    const taskId = "team-artifacts-late-begin";
    const sessId = "sess-late-begin";
    const root = await seed("late-begin", taskId, sessId);
    const { handle, push } = pushHandle();
    const desk = lead(taskId, sessId, root, handle, openedAt);
    attachLead(desk as never);
    await openTurn({ sessionId: sessId, taskId, cwd: root, startedAt: openedAt });
    // 首轮正常结束。生产里这一下完全可能落在开台那两次写库和它下面那句 `beginTurn` 之间
    //（库忙一下就够了）—— 那就是「迟到的开始信息」的来路。
    push({ kind: "turnEnd" });
    await until(() => !activeTurnStarts(sessId).size, "首轮收口");
    const settled = (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!;
    assert(settled.endedAt, "前置条件:首轮的收尾时刻确实写在会话行上");
    // 迟到的那一句 `beginTurn`,用的是**真正**从 `createSessionConsumer` 拿到的那一个（开台
    // 路径调的就是它）。自己的 leads 映射里放着这台,免得它走进「已经被接管」那条岔路。
    const consumer = createSessionConsumer({
      leads: new Map([[taskId, desk]]) as never,
      adoptInbound: async () => {},
      flushUnqueued: async () => {},
      releasePending: () => {},
    });
    await consumer.beginTurn(desk as never, openedAt);
    assert.deepEqual(heldTurns(desk as never), [],
      "已经结束的身份不许被迟到的开始信息重新排进队列（那个幽灵队首会把下一次结束吃掉）");
    assert.deepEqual([...activeTurnStarts(sessId)], [], "也不许回到活动册");
    assert.equal(desk.busy, false, "这台确实空着——迟到的开始信息不该把它说成在忙");
    const again = (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!;
    assert.equal(again.endedAt, settled.endedAt,
      "迟到的开始信息只补持久记录,不许把会话行改回「正在跑」");
    // 接着来真的一轮并让它正常结束：结束事件必须关掉**它**。
    assert.equal(await deliverToLead(taskId, "接着画一张"), true, "前置条件:插话进了调度台");
    const second = heldTurns(desk as never);
    assert.equal(second.length, 1, `手上只该有刚投进去那一轮,实际：${JSON.stringify(second)}`);
    push({ kind: "turnEnd" });
    await until(() => !activeTurnStarts(sessId).size,
      "第二轮的结束事件关掉它自己那一轮（幽灵队首一旦存在,被关掉的就是它,真正结束的这一轮会永远留在活动册上）");
    // 它停工之后,别的任务在同一个目录里画一张。
    await pause(2600);
    writeFileSync(join(root, "output", "another-task.svg"), svg("another task"));
    const after = await listing(taskId, root);
    assert.deepEqual(paths(after), [],
      `这台停工之后别人做的东西不该算成它的,实际清单：${JSON.stringify(paths(after))}`);
    assert.deepEqual(after.incomplete, [],
      `两轮都正常收了口,面板不该说有缺口,实际：${JSON.stringify(after.incomplete)}`);
    push({ kind: "done", exitStatus: 0 });
    await until(() => !teamIsLive(taskId), "这台收完台");
    ok("结束之后迟到的开始信息:不重开所有权,下一次结束关的是它自己那一轮");
  }

  // 迟到的开始信息走的是真正的 `beginTurn`（开台路径调的就是它）。自己的 leads 映射里放着
  // 这台,免得它走进「已经被接管」那条岔路。
  const consumerFor = (taskId: string, desk: unknown) => createSessionConsumer({
    leads: new Map([[taskId, desk]]) as never,
    adoptInbound: async () => {},
    flushUnqueued: async () => {},
    releasePending: () => {},
  });
  const turnRows = async (sessId: string) => (await dbClient.execute(
    `SELECT started_at, ended_at FROM session_turns WHERE session_id='${sessId}' ORDER BY started_at`,
  )).rows;

  // ── ⑤ 正常关台之后迟到的开始信息：不留一个没人注销的活动身份（本轮审查第 1 条）──────────
  {
    const taskId = "team-artifacts-closed-desk";
    const sessId = "sess-closed-desk";
    const root = await seed("closed-desk", taskId, sessId);
    const { handle, push } = pushHandle();
    const desk = lead(taskId, sessId, root, handle, openedAt);
    attachLead(desk as never);
    await openTurn({ sessionId: sessId, taskId, cwd: root, startedAt: openedAt });
    push({ kind: "turnEnd" });
    await until(() => !activeTurnStarts(sessId).size, "首轮收口");
    push({ kind: "done", exitStatus: 0 });
    await until(() => !teamIsLive(taskId), "这台正常关台");
    // **这就是老判据拦不住它的原因**：正常关台没有人来接管,所以不摘牌。
    assert.equal(desk.retired, false, "前置条件:正常关台不摘牌");
    const closed = (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!;
    assert(closed.endedAt, "前置条件:关台时把收尾时刻写在了会话行上");
    // 开台那条链上排在后面的异步回调（库忙一下就够）这才轮到它这一句。
    const late = nextTurnStart(sessId);
    await consumerFor(taskId, desk).beginTurn(desk as never, late);
    assert.deepEqual([...activeTurnStarts(sessId)], [],
      "关了的台不许再往活动册里塞身份：这台再也不会有结束事件来注销它,读端会把区间从那个起点开到无穷");
    const again = (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!;
    assert.equal(again.endedAt, closed.endedAt, "也不许把会话行改回「正在跑」");
    assert.deepEqual((await turnRows(sessId)).map((row) => row.started_at), [openedAt, late],
      "那一行持久记录照落——开过就是开过,只是它不算「正在跑」");
    // 停工之后别人在同一个目录里画一张（落定余量之外）。
    await pause(3200);
    writeFileSync(join(root, "output", "after-close.svg"), svg("after close"));
    const after = await listing(taskId, root);
    assert.deepEqual(paths(after), [],
      `这台关了之后别人做的东西不该算成它的,实际清单：${JSON.stringify(paths(after))} / ${JSON.stringify(after.incomplete)}`);
    assert(after.incomplete.some((line) => line.includes("收尾时刻")),
      `那一行迟到的开始记录确实没有收尾,面板得照实说出来,实际：${JSON.stringify(after.incomplete)}`);
    ok("正常关台之后迟到的开始信息:只落行、不进活动册,之后别人的产出不被收进来");
  }

  // ── ⑥ 换台：手上攥着的每一轮都要补上自己的区间（本轮审查第 3 条）────────────────────────
  {
    const taskId = "team-artifacts-takeover";
    const sessId = "sess-takeover";
    const root = await seed("takeover", taskId, sessId);
    const { handle, push } = pushHandle();
    const old = lead(taskId, sessId, root, handle, openedAt);
    attachLead(old as never);
    await openTurn({ sessionId: sessId, taskId, cwd: root, startedAt: openedAt });
    assert.equal(await deliverToLead(taskId, "插话改方向"), true, "前置条件:插话进了调度台");
    await until(() => heldTurns(old as never).length >= 2,
      "手上同时攥着两轮（首轮还没收口,插话那一轮已经开跑）");
    const held = heldTurns(old as never);
    // 工作目录被抽走那条路：新台当场接管同一行会话,旧台**这一刻**就被摘牌,而旧进程的
    // close 事件还在路上 —— 所以收尾那一下再去读 `held` 已经什么都没有了。
    const fresh = lead(taskId, sessId, root, pushHandle().handle, nextTurnStart(sessId));
    attachLead(fresh as never);
    assert.equal(old.retired, true, "前置条件:旧台被摘牌");
    assert.deepEqual(heldTurns(old as never), [], "前置条件:摘牌当场清空了队列");
    push({ kind: "done", exitStatus: 0 }); // 旧进程这才退出
    for (let tries = 0; tries < 300; tries += 1) {
      if (!(await turnRows(sessId)).some((row) => !row.ended_at)) break;
      await pause(20);
    }
    const rows = await turnRows(sessId);
    assert.deepEqual(rows.map((row) => row.started_at), [...held].sort(),
      `手上那两轮都该有自己的一行,实际：${JSON.stringify(rows)}`);
    assert(rows.every((row) => row.ended_at),
      "换台收尾必须把它手上攥着的**每一轮**都补上区间（只补一个单值的话,被打断/还排着的那几轮"
      + `永远留在 ended_at = NULL,面板报假缺口、区间跟着放宽）,实际：${JSON.stringify(rows)}`);
    ok("换台：摘牌时交回的身份在收尾时全部补上区间,一个都不漏");
  }

  // ── ⑦ 开始那半边还没写完,这一轮就收口了（本轮审查第 2 条）──────────────────────────────
  {
    const taskId = "team-artifacts-begin-race";
    const sessId = "sess-begin-race";
    const root = await seed("begin-race", taskId, sessId);
    const { handle, push } = pushHandle();
    const desk = lead(taskId, sessId, root, handle, openedAt);
    attachLead(desk as never);
    await openTurn({ sessionId: sessId, taskId, cwd: root, startedAt: openedAt });
    push({ kind: "turnEnd" });
    await until(() => !activeTurnStarts(sessId).size, "首轮收口");
    // 这一轮收尾之后任务落了终态。开始那半边要是继续往下写,它会把状态改回 running。
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, taskId));
    const at = nextTurnStart(sessId);
    // **不 await**：同步段跑到第一次写库（`updateOwnSession`）就停在那儿。
    const begin = consumerFor(taskId, desk).beginTurn(desk as never, at);
    assert.deepEqual([...activeTurnStarts(sessId)], [at], "前置条件:这一轮已经登记在册");
    // 结束事件在**这一刻**到达。`endTurn` 开头那两句就是下面这两句,所以这里直接调它们:靠推
    // 事件只能碰运气撞上这个窗口,而这两个都是生产函数,状态迁移跟真结束一模一样。
    const endIso = new Date().toISOString();
    assert.equal(releaseHeldTurn(desk as never), at, "前置条件:结束事件关掉的就是这一轮");
    await recordTurnSpan({ sessionId: sessId, taskId, cwd: root, startedAt: at, endedAt: endIso });
    await begin;
    assert.deepEqual([...activeTurnStarts(sessId)], [],
      "已经收口的身份不许被开始那半边塞回活动册（那之后谁都不会再来注销它,读端从它的起点开到无穷）");
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
    assert.equal(task.status, "paused", "也不许把已经收尾的任务状态改回 running");
    const rows = await turnRows(sessId);
    assert(rows.every((row) => row.ended_at),
      `两轮都收过口（开始那半边只补行,不会把收口抹掉）,实际：${JSON.stringify(rows)}`);
    // 它停工之后别人在同一个目录里画一张。
    await pause(3200);
    writeFileSync(join(root, "output", "after-race.svg"), svg("after race"));
    const after = await listing(taskId, root);
    assert.deepEqual(paths(after), [],
      `这一轮早收口了,之后别人做的东西不该算成它的,实际清单：${JSON.stringify(paths(after))} / ${JSON.stringify(after.incomplete)}`);
    assert.deepEqual(after.incomplete, [],
      `两轮都有完整记录,面板不该说有缺口,实际：${JSON.stringify(after.incomplete)}`);
    push({ kind: "done", exitStatus: 0 });
    await until(() => !teamIsLive(taskId), "这台收完台");
    ok("开始那半边撞上收口:不塞回活动册、不改回 running");
  }

  console.log("test:team-turn-artifacts ok");
} finally {
  try { dbClient.close(); } catch { /* 已经关了 */ }
  await releaseTmpDb();
}
