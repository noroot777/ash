// 讨论走**真的派发链**（continueWhenIdle → orchestrator → 单飞回合 → 结算推进）时，每一段到底交给了谁、
// 带了什么。test-discussion.ts 一直占着回合、直接调结算，看得见规则，看不见这一条链上实际起跑的是谁。
//
// 只把外部 CLI 换成确定性的假事件流（GenericCliExecutor.run），别的全是真的。盯三件事：
//   · 发起后改了任务的执行器：后面主执行器那几段、连同合稿，照旧由发起时那一位说；
//   · 发起时附的文件，各方第一段都收到了（不只是第一个开口的人）；
//   · 讨论之前的背景是发起那一刻截下的副本：各方拿到同一份，第一轮不告诉它实时记录在哪，说完副本也没变。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
          await submitDiscussionStatement(taskId, { summary: `${agent} 的看法`, statement: `${agent}：这么做，理由如下。` });
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
  async function runThrough(id: string, guests: string[]) {
    await startDiscussion(id, { topic: "按哪条路做", attachments: [attachment], rounds: 1, guests: guests.map((agentType) => ({ agentType })) },
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
  for (const call of blind.filter((item) => item.agent !== "gemini")) {
    assert.ok(call.prompt.includes(copy), `${call.agent} 拿到的背景是那份副本`);
  }
  assert.equal(readFileSync(copy, "utf8"), "用户补充：别动数据库结构\n", "说完了副本还是发起那一刻的样子");
  assert.notEqual(readFileSync(join(root, "runs", "t-three", "t-three-gemini.md"), "utf8"), "用户补充：别动数据库结构\n",
    "实时记录照常往下写了（所以第一轮不能让它读）");
  assert.deepEqual(three.discussion.attachments, [attachment]);

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
