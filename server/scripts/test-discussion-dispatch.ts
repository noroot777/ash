// 讨论走**真的派发链**（continueWhenIdle → orchestrator → 单飞回合 → 结算推进）时，每一段到底交给了谁、
// 带了什么。test-discussion.ts 一直占着回合、直接调结算，看得见规则，看不见这一条链上实际起跑的是谁。
//
// 只把外部 CLI 换成确定性的假事件流（GenericCliExecutor.run），别的全是真的。盯三件事：
//   · 发起后改了任务的执行器：后面主执行器那几段、连同合稿，照旧由发起时那一位说；
//   · 发起时附的文件，各方第一段都收到了（不只是第一个开口的人）；
//   · 讨论之前的背景是发起那一刻截下的副本：**每一方**拿到同一份完整清单（主执行器自己那份也在——它这一轮
//     不一定接上了原来那条会话），读不到的旧记录写明；第一轮不告诉它实时记录在哪，说完副本也没变；
//   · 第二轮起、合稿之前，本场前面各段的完整发言（含它自己的）有一份只读记录；
//   · 交卷认的是这一回合的身份（令牌 + 实际起跑的那一位），不按会话表里谁的时间最大认人：另一位的旧会话
//     时间领先（接力过来、校过时）也不会把正常发言拒掉。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-discussion-dispatch-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

let failure: unknown = null;
try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { discussionViews, startDiscussion, submitDiscussionStatement } = await import("../src/discussion.js");
  // 先经执行器注册表进来：直接先载 generic.ts 会撞上 catalog 的循环引用。
  await import("../src/executors/index.js");
  const { GenericCliExecutor } = await import("../src/executors/generic.js");

  type Call = { taskId: string; agent: string; prompt: string; seq: number | null };
  const calls: Call[] = [];
  // 起跑的每一回合都记下来：谁、拿到的整段话、是讨论的第几段（合稿为 null）。讨论中就照常交一段卷。
  GenericCliExecutor.prototype.run = function (this: InstanceType<typeof GenericCliExecutor>, options) {
    const agent = this.type;
    const taskId = options.env?.ASH_TASK_ID ?? "";
    const call: Call = { taskId, agent, prompt: options.prompt, seq: null };
    calls.push(call);
    return {
      sessionId: options.sessionId ?? `fake-${agent}-${taskId}`,
      commandLine: "fake discussion adapter",
      kill() {},
      events: (async function* () {
        const discussion = (await discussionViews(taskId)).at(-1);
        if (discussion?.status === "running") {
          call.seq = discussion.turns.at(-1)!.seq;
          // 第一段说着的时候，用户把这条任务的执行器改成了 qwen。
          if (taskId === "t-switch" && call.seq === 1) await db.update(tasks).set({ agentType: "qwen" }).where(eq(tasks.id, taskId));
          // 跟真 MCP 一样带上起跑时交给它的回合令牌。
          await submitDiscussionStatement(taskId, { summary: `${agent} 的看法`, statement: `${agent} 第 ${call.seq} 段：这么做，理由如下。` },
            { turnToken: options.env?.ASH_TURN_TOKEN ?? null });
          yield { kind: "text" as const, text: "交卷了。" };
        } else {
          yield { kind: "text" as const, text: "合稿：结论在这里；分歧：无。" };
        }
        yield { kind: "done" as const, exitStatus: 0 };
      })(),
    } as ReturnType<InstanceType<typeof GenericCliExecutor>["run"]>;
  };

  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "discussion-dispatch", repoPath: root, createdAt: at });
  const attachment = join(root, "原始材料.txt");
  writeFileSync(attachment, "两份独立看法都要考虑这份材料");

  /** 一条跑过的普通任务（主执行器 gemini），之前那份对话里有用户后来补的约束。 */
  async function seedTask(id: string) {
    await createTasks([{
      id, projectId: "p", title: id, body: "定一个方案", mode: "single", status: "done", stage: "verified",
      agentType: "gemini", autoTitle: false, workflowMode: "free", useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    await db.insert(sessions).values({ id: `${id}-gemini`, taskId: id, role: "single", agentType: "gemini", executor: "gemini",
      startedAt: at, turnStartedAt: at, endedAt: at, cwd: root });
    mkdirSync(join(root, "runs", id), { recursive: true });
    writeFileSync(join(root, "runs", id, `${id}-gemini.md`), "用户补充：别动数据库结构\n");
  }
  async function runThrough(id: string, guests: string[], rounds = 1) {
    await startDiscussion(id, { topic: "按哪条路做", attachments: [attachment], rounds, guests: guests.map((agentType) => ({ agentType })) },
      { holdTurn: true });
    const deadline = Date.now() + 30_000;
    let discussion = (await discussionViews(id)).at(-1)!;
    while (["running", "synthesizing"].includes(discussion.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      discussion = (await discussionViews(id)).at(-1)!;
    }
    assert.equal(discussion.status, "finished", `${id}：一场走完（${discussion.note ?? ""}）`);
    return { discussion, mine: calls.filter((call) => call.taskId === id) };
  }

  // ── ① 中途改了任务的执行器 ──
  await seedTask("t-switch");
  const switched = await runThrough("t-switch", ["opencode"]);
  assert.deepEqual(switched.mine.map((call) => [call.agent, call.seq]), [["opencode", 1], ["gemini", 2], ["gemini", null]],
    "主执行器那一段和合稿照旧是发起时的 gemini，不是改成的 qwen");
  assert.deepEqual(switched.discussion.turns.map((turn) => turn.speaker), ["opencode", "gemini"], "记录上写的就是实际说话的");
  const task = (await db.select().from(tasks).where(eq(tasks.id, "t-switch"))).at(0)!;
  assert.equal(task.status, "done", "讨论完任务还是原来的状态");
  assert.equal(task.stage, "verified");

  // ── ② 三方：附件与背景 ──
  await seedTask("t-three");
  const three = await runThrough("t-three", ["opencode", "qwen"]);
  const blind = three.mine.filter((call) => call.seq !== null && call.seq <= 3);
  assert.deepEqual(blind.map((call) => call.agent), ["opencode", "qwen", "gemini"]);
  for (const call of blind) {
    assert.ok(call.prompt.includes(attachment), `${call.agent} 第一段收到了发起时附的文件`);
    assert.ok(!call.prompt.includes("〔本任务还有其他智能体参与〕"), `${call.agent} 第一段不被告知实时记录在哪`);
  }
  const copy = join(root, "runs", "t-three", "discussions", three.discussion.id, "background", "gemini-t-three-gemini.md");
  for (const call of blind) {
    // gemini 那条旧会话没有 CLI 会话号（失效重开、接力搬来都是这样），这一轮接不上原来的上下文：它自己那份也得给它。
    assert.ok(call.prompt.includes(copy), `${call.agent} 拿到的背景是那份副本（主执行器自己的也给）`);
  }
  const synthesis = three.mine.find((call) => call.seq === null)!;
  const spoken = join(root, "runs", "t-three", "discussions", three.discussion.id, "spoken-before-synthesis.md");
  assert.ok(synthesis.prompt.includes(copy), "合稿同样带着背景");
  assert.ok(synthesis.prompt.includes(spoken), "合稿带着本场各段的完整记录");
  assert.ok(["opencode 第 1 段", "qwen 第 2 段", "gemini 第 3 段"].every((text) => readFileSync(spoken, "utf8").includes(text)),
    "那份记录里有每一段，包括主执行器自己说的");
  assert.equal(readFileSync(copy, "utf8"), "用户补充：别动数据库结构\n", "说完了副本还是发起那一刻的样子");
  assert.notEqual(readFileSync(join(root, "runs", "t-three", "t-three-gemini.md"), "utf8"), "用户补充：别动数据库结构\n",
    "实时记录照常往下写了（所以第一轮不能让它读）");
  assert.deepEqual(three.discussion.attachments, [attachment]);

  // ── ③ 另一位的旧会话时间领先（接力源机钟快 / 校过时）、还有一条读不到的旧记录；2 轮 ──
  await seedTask("t-clock");
  const ahead = new Date(Date.now() + 5 * 60_000).toISOString();
  await db.insert(sessions).values({ id: "t-clock-qwen", taskId: "t-clock", role: "single", agentType: "qwen", executor: "qwen",
    startedAt: ahead, turnStartedAt: ahead, endedAt: ahead, cwd: root });
  writeFileSync(join(root, "runs", "t-clock", "t-clock-qwen.md"), "qwen 之前说过的\n");
  await db.insert(sessions).values({ id: "t-clock-lost", taskId: "t-clock", role: "single", agentType: "kimi", executor: "kimi",
    startedAt: at, turnStartedAt: at, endedAt: at, cwd: root });
  const clock = await runThrough("t-clock", ["opencode"], 2);
  assert.deepEqual(clock.mine.map((call) => [call.agent, call.seq]),
    [["opencode", 1], ["gemini", 2], ["opencode", 3], ["gemini", 4], ["gemini", null]], "正常发言一段都没被拒，走完 4 段和合稿");
  for (const call of clock.mine.filter((item) => item.seq !== null && item.seq <= 2)) {
    assert.match(call.prompt, /读不到了[^\n]*kimi（会话 t-clock-lost）/, `${call.agent} 被告知哪条旧记录读不到`);
  }
  const before4 = clock.mine.find((call) => call.seq === 4)!;
  const record4 = join(root, "runs", "t-clock", "discussions", clock.discussion.id, "spoken-before-4.md");
  assert.ok(before4.prompt.includes(record4), "第二轮起带着本场前面各段的完整记录");
  assert.ok(["opencode 第 1 段", "gemini 第 2 段", "opencode 第 3 段"].every((text) => readFileSync(record4, "utf8").includes(text)),
    "记录里有它自己第 2 段说的");
  assert.ok(!existsSync(join(root, "runs", "t-clock", "discussions", clock.discussion.id, "spoken-before-2.md")),
    "第一轮各写各的，不写这一份");
  const runDir = join(root, "runs", "t-clock");
  const receipts = readdirSync(runDir).filter((name) => name.endsWith(".md")).map((name) => readFileSync(join(runDir, name), "utf8")).join("\n");
  assert.match(receipts, /之前有 1 份对话记录读不到/, "开始那一句写明背景不全");

  console.log("discussion dispatch ok");
} catch (error) {
  failure = error;
} finally {
  await releaseTmpDb().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
process.exit(0);
