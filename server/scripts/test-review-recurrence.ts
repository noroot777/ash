// 同类问题熔断（review-recurrence.ts）：承接声明的校验、谱系计数、熔断指令只在触发轮出现、
// 熔断状态刷新后可见，以及熔断路径上选择题的硬格式校验（choice-question-check.ts）。
//
// 集成那几段走的是真实链路：派审任务书（落下这一轮实际发出去的清单编号）→ report_stage 的业务入口
// （承接在这里校验落库）→ 审查回合收流结算 → 收尾排空把修复交接放进待发送队列。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentEvent } from "@ash/shared";
import type { AgentExecutor, RunHandle } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-recurrence-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_LAX_DONE;

try {
  const { parseCarries, lineageLengths, recurrenceBreakerActive, recurrenceLabel, RECURRENCE_THRESHOLD } =
    await import("../src/review-recurrence.js");
  const { checkChoiceQuestion, sentenceCount } = await import("../src/choice-question-check.js");

  // ① 承接校验：匹配的计入；没填、填错、对不上的一律忽略，且从不抛错。
  {
    const sent = new Set(["1.1.1", "1.1.2", "2.3.1"]);
    assert.deepEqual(parseCarries({ "1": "1.1.1", "2": "[2.3.1]" }, 2, sent),
      [{ finding: 1, from: "1.1.1" }, { finding: 2, from: "2.3.1" }], "字段说明教的写法、照抄行首方括号都认");
    assert.deepEqual(parseCarries([{ finding: 1, from: "1.1.2" }], 1, sent), [{ finding: 1, from: "1.1.2" }]);
    assert.deepEqual(parseCarries('{"1":"1.1.1"}', 1, sent), [{ finding: 1, from: "1.1.1" }], "被序列化成字符串也认");
    for (const raw of [undefined, null, "", "不是 JSON", 42, { "1": "9.9.9" }, { "3": "1.1.1" }, { "0": "1.1.1" },
      { "第1条": "1.1.1" }, { "1": 111 }, [{ finding: "x", from: "1.1.1" }], ["1.1.1"]]) {
      assert.deepEqual(parseCarries(raw, 2, sent), [], `读不懂的一律按没填算：${JSON.stringify(raw)}`);
    }
    assert.deepEqual(parseCarries({ "1": "9.9.9", "2": "1.1.2" }, 2, sent), [{ finding: 2, from: "1.1.2" }],
      "一条对不上不连累同一份里对得上的那条");
    assert.deepEqual(parseCarries({ "1": "1.1.1" }, 0, sent), [], "这份报告一条发现都没抽到时，「本轮第 1 条」不存在");
  }

  // ② 谱系计数：按承接链传递、只认紧挨着的上一轮、跨链照算。
  {
    const vf = "verify_failed";
    const chain = lineageLengths([
      { key: "a1", refBase: "1.1", conclusion: vf, carries: [] },
      { key: "a2", refBase: "1.2", conclusion: vf, carries: [{ finding: 1, from: "1.1.2" }] },
      { key: "a3", refBase: "1.3", conclusion: vf, carries: [{ finding: 2, from: "1.2.1" }] },
      // 跨链：第 2 条审查链的第 1 轮承接第 1 条链的最后一轮。
      { key: "b1", refBase: "2.1", conclusion: vf, carries: [{ finding: 1, from: "1.3.2" }] },
    ]);
    assert.equal(chain.get("a1"), undefined);
    assert.deepEqual(chain.get("a2"), { length: 2, findings: [1] }, `连续 ${RECURRENCE_THRESHOLD} 轮就触发`);
    assert.deepEqual(chain.get("a3"), { length: 3, findings: [2] }, "第 N 轮 F2 承接 N-1 轮 F1，N-1 轮 F1 承接 N-2 轮 F2：同一谱系");
    assert.deepEqual(chain.get("b1"), { length: 4, findings: [1] }, "用户另开的审查链照样接着算");

    const broken = lineageLengths([
      { key: "a1", refBase: "1.1", conclusion: vf, carries: [] },
      { key: "a2", refBase: "1.2", conclusion: "verified", carries: [] },
      { key: "a3", refBase: "1.3", conclusion: vf, carries: [{ finding: 1, from: "1.1.1" }] },
    ]);
    assert.equal(broken.size, 0, "中间断一轮（承接的不是紧挨着的上一轮）不触发");
    const gap = lineageLengths([
      { key: "a1", refBase: "1.1", conclusion: vf, carries: [] },
      { key: "a2", refBase: "1.2", conclusion: vf, carries: [] },
      { key: "a3", refBase: "1.3", conclusion: vf, carries: [{ finding: 1, from: "1.2.1" }] },
    ]);
    assert.deepEqual(gap.get("a3"), { length: 2, findings: [1] }, "上一轮那条自己没有承接：谱系从它算起");
    assert.equal(lineageLengths([
      { key: "a1", refBase: "1.1", conclusion: vf, carries: [] },
      { key: "a2", refBase: "1.2", conclusion: "verified", carries: [{ finding: 1, from: "1.1.1" }] },
    ]).size, 0, "通过的那一轮不算「被标为拦验收」");
  }

  // ③ 选择题硬格式：含路径 / 标识符 / 分支 / commit / 轮次的被拒并说明；合规的放行。
  {
    const good = {
      question: "这类问题按点修了两次都没收口，需要你定方案。现有做法在三个系统上各要一套判断。",
      options: [
        "统一改成由服务端判断：选它你会多等一天，但以后不会再冒同类问题",
        "保留现在的做法，只补齐剩下的系统：今天就能验收，代价是以后新增系统还得再补",
      ],
    };
    assert.deepEqual(checkChoiceQuestion(good), [], "合规的放行");
    assert.equal(sentenceCount("一句。两句！三句？"), 3);
    const cases: Array<[string, Partial<typeof good>, RegExp]> = [
      ["路径", { question: "要改 server/src/review-history.ts 的判断。" }, /文件路径/],
      ["文件名", { question: "要改 review-history.ts 的判断。" }, /文件路径/],
      ["驼峰标识符", { options: ["改 parseCarries：你会少一轮", good.options[1]!] }, /代码标识符「parseCarries」/],
      ["蛇形标识符", { options: ["加一列 history_refs：会多一次迁移", good.options[1]!] }, /代码标识符「history_refs」/],
      ["分支名", { options: ["合进 ash/FVo81m14：会快一点", good.options[1]!] }, /分支名/],
      ["commit", { question: "回到 773f06a2 那一版。" }, /commit「773f06a2」/],
      ["轮次", { question: "第 3 轮审查又报了这条。" }, /第 N 轮/],
      ["背景超过两句", { question: "第一句。第二句。第三句。" }, /3 句/],
      ["选项太少", { options: ["只有一个：会怎样"] }, /1 个选项/],
      ["选项太多", { options: ["一会", "二会", "三会", "四会", "五会"] }, /5 个选项/],
      ["没有后果句", { options: ["统一改成服务端判断", good.options[1]!] }, /第 1 个没有后果句/],
    ];
    for (const [what, patch, expected] of cases) {
      const problems = checkChoiceQuestion({ ...good, ...patch });
      assert.ok(problems.some((problem) => expected.test(problem)), `${what} 应被拒：${problems.join(" | ")}`);
    }
    assert.deepEqual(checkChoiceQuestion({ ...good, question: "macOS 和 iPhone 上表现不一样，需要你定。" }), [],
      "产品名不算代码标识符");
    assert.ok(checkChoiceQuestion({ question: "两件事要定。", options: [],
      items: [{ question: "先定哪个系统。", options: ["先做 macOS：会快"] }] }).some((p) => /第 1 个问题的选项有 1 个选项/.test(p)),
    "多问题时每个子问题各自是一道选择题");
  }

  // ── 集成：真实链路 ──────────────────────────────────────────────────────────────
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, projects, reviewerProfiles, scheduledMessages, sessions, tasks } =
    await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { consumeSingleRun } = await import("../src/single-run.js");
  const { freeWorkflowState, reportFreeReviewConclusion } = await import("../src/free-workflow.js");
  const { freeManualRepairPrompt, freeReviewPrompt } = await import("../src/free-review-prompts.js");
  const { freeReviewEvidenceDir, freeReviewReportPath } = await import("../src/free-review-files.js");
  const { evidenceState } = await import("../src/regression-evidence-lifecycle.js");
  const { claimOwnTurn, releaseTurn, turnRole } = await import("../src/runs.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { mountTaskQuestionRoutes } = await import("../src/task-question-routes.js");
  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "recurrence", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "test", type: "codex", model: "test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "reviewer", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });
  const id = "recur";
  await createTasks([{
    id, projectId: "p", title: id, body: "test", mode: "single", status: "done",
    agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
    useWorktree: false, createdAt: at, updatedAt: at,
  }]);
  // 审查回合的 turn **整场只占一次、不放开**：放开的那一刻，结算放进待发送队列的修复交接就会被
  // 投递、真把执行者拉起来（`pending-messages.ts` 的 whenTurnIdle）。这里只验「交接里写了什么」。
  let owner = claimOwnTurn(id, "reviewer");
  assert.ok(owner, "审查回合占得到 turn");
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const report = (lines: string[]) => "## 结论\n\n**能不能验收**：不能。\n\n**必须修的问题**：\n\n" +
    lines.map((line, index) => `### ${index + 1}\n- 你会遇到：${line}\n- 为什么：机制。\n- 建议怎么修：修法。\n`).join("\n");

  /** 开一轮审查（审查回合占着 turn），并按真实派审拼一次任务书 —— 那一刻落下清单编号。 */
  async function openRound(runId: string, round: number, createdAt: string, retryLimit: number) {
    const existing = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId)))[0];
    if (existing) {
      await db.update(freeReviewRuns).set({ currentRound: round, status: "reviewing" }).where(eq(freeReviewRuns.id, runId));
    } else {
      await db.insert(freeReviewRuns).values({
        id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
        executorId: "ex", checkMode: "logic", retryLimit, currentRound: round, status: "reviewing",
        targetKind: "workspace", createdAt, updatedAt: createdAt,
      });
    }
    await db.insert(freeReviewRounds).values({ id: `${runId}-${round}`, runId, round, status: "reviewing", startedAt: at });
    const sessId = `${runId}-${round}-reviewer`;
    await db.insert(sessions).values({
      id: sessId, taskId: id, role: "reviewer", agentType: "codex", executor: "test", cwd: root, startedAt: at, turnStartedAt: at,
    });
    await evidenceState(id, freeReviewEvidenceDir(id, runId, round), await taskRow());
    const run = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId)))[0]!;
    const prompt = await freeReviewPrompt(await taskRow(), run, round, root);
    return { sessId, prompt };
  }

  /** 审查者交卷（报告 + 带承接的结论）后正常退出，走真实收流与结算。 */
  async function finishRound(
    runId: string, round: number, opened: { sessId: string },
    findings: string[], recurs?: unknown,
  ) {
    const { sessId } = opened;
    const path = freeReviewReportPath(id, runId, round);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, report(findings));
    await reportFreeReviewConclusion(id, "verify_failed", { recurs });
    const transcript = sessionTranscriptPath(id, sessId);
    mkdirSync(dirname(transcript), { recursive: true });
    const out = createWriteStream(transcript, { flags: "a" });
    const closed = once(out, "close");
    const handle: RunHandle = {
      sessionId: "", commandLine: "fixture", kill() {},
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { kind: "text", text: "审查完毕。" };
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
    const executor: AgentExecutor = {
      type: "codex", label: "fixture", run: () => handle,
      resumeCommand: () => "", resumeFields: () => ({ resumeCommand: "", resumeEnv: null, resumeArgs: null }),
    };
    await consumeSingleRun({
      taskId: id, sessId, agentType: "codex", ex: executor, cwd: root, handle, out,
      turnStart: at, cliSessionId: "", autoTitle: false, role: "reviewer",
    });
    await closed;
  }
  const repairs = async () => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, id)))
    .filter((row) => row.origin?.startsWith("review-settlement:"));
  const timeline = () => readdirSync(dirname(sessionTranscriptPath(id, "x")))
    .filter((name) => name.endsWith(".md") || name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(dirname(sessionTranscriptPath(id, "x")), name), "utf8")).join("\n");
  const label = (length: number) => recurrenceLabel(length);

  // 第 1 条链第 1 轮：没有历史，清单为空、也就没有可引用的编号；照常修复，交接里没有熔断指令。
  const first = await openRound("run-a", 1, "2026-11-01T00:00:00.000Z", 3);
  assert.ok(!first.prompt.includes("recurs"), "第一轮没有清单，审查者侧一个字都不多发");
  await finishRound("run-a", 1, first, ["保存后列表没刷新", "切换项目时筛选丢失"], { "1": "1.0.1" });
  assert.equal((await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, "run-a-1")))[0]!.carries, null,
    "引用对不上：按不是复发处理，结论照收");
  assert.equal((await repairs()).length, 1);
  assert.ok(!(await repairs())[0]!.text.includes("已熔断"), "没熔断的那一轮，修复交接里没有熔断指令");
  assert.equal(await recurrenceBreakerActive(id), false);

  // 第 2 轮：清单里带编号；承接第 1 轮第 2 条 → 连续 2 轮 → 熔断。
  const second = await openRound("run-a", 2, "2026-11-01T00:00:00.000Z", 3);
  assert.ok(second.prompt.includes("[1.1.2]") && second.prompt.includes("recurs"), "清单行首有编号，紧跟一句怎么填");
  assert.deepEqual((await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, "run-a-2")))[0]!.historyRefs,
    ["1.1.1", "1.1.2"], "这一轮实际发出去的编号落库");
  await finishRound("run-a", 2, second, ["切换项目后筛选还是丢", "导出按钮无反应"], { "1": "1.1.2", "2": "1.1.9" });
  assert.deepEqual((await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, "run-a-2")))[0]!.carries,
    [{ finding: 1, from: "1.1.2" }], "只落校验通过的那一条");
  const breakerRepair = (await repairs()).at(-1)!;
  assert.equal((await repairs()).length, 2);
  assert.ok(breakerRepair.text.includes(`【${label(2)}】报告第 1 条`), `熔断轮的修复交接带指令：${breakerRepair.text}`);
  assert.ok(breakerRepair.text.includes("ask_question") && breakerRepair.text.includes("dispute_review"),
    "二选一的出路在，驳回的权利也照旧在");
  assert.ok(timeline().includes(label(2)), "时间线上留了一条");
  assert.equal(await recurrenceBreakerActive(id), true, "执行者此刻处在熔断修复里");

  // 刷新后可见：重新读状态接口，审查记录那一轮带着熔断状态，没熔断的轮次没有。
  const state = await freeWorkflowState(id);
  const rounds = state.reviews.find((run) => run.id === "run-a")!.rounds;
  assert.equal(rounds.find((round) => round.round === 2)?.recurrence, 2);
  assert.equal(rounds.find((round) => round.round === 1)?.recurrence, undefined);

  // 熔断路径上的 ask_question：不合格的被退回并说明，合格的放行（过了格式闸才轮到回合身份那几道）。
  // 提问来自执行者回合，所以先把审查回合放开 —— 放开之前把待发送的修复交接清掉（内容上面已经验过），
  // 否则那一刻它就会被投递、真把执行者拉起来。
  {
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, id));
    releaseTurn(id, owner!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(turnRole(id), null, "没有别的回合趁机占上");
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, id));
    const api = new Hono();
    mountTaskQuestionRoutes(api);
    const { activeTurnToken, activeDirectionToken } = await taskRow();
    const ask = (body: unknown) => api.request(`/tasks/${id}/ask`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(activeTurnToken ? { "x-ash-turn-token": activeTurnToken } : {}),
        ...(activeDirectionToken ? { "x-ash-direction-token": activeDirectionToken } : {}),
      },
      body: JSON.stringify(body),
    });
    const bad = await ask({ question: "第 2 轮又报了 parseCarries 的问题。", options: ["改掉"] });
    assert.equal(bad.status, 400);
    const error = ((await bad.json()) as { error: string }).error;
    assert.match(error, /第 N 轮/);
    assert.match(error, /parseCarries/);
    assert.match(error, /后果句/);
    const fine = await ask({
      question: "这类问题按点修了两次都没收口，需要你定方案。",
      options: ["统一改成服务端判断：选它你会多等一天", "只补齐剩下的地方：今天就能验收，代价是以后还得补"],
    });
    assert.notEqual(fine.status, 400, "合规的选择题不被格式闸拦");
    await db.update(tasks).set({ status: "done", question: null, questionOptions: null, questionItems: null }).where(eq(tasks.id, id));
    owner = claimOwnTurn(id, "reviewer");
    assert.ok(owner, "审查回合重新占得到 turn");
  }

  // 用户另开一条审查链（「再审一轮」）：清单跨链，承接第 1 条链第 2 轮第 1 条 → 第 3 轮未收口。
  // 这条链轮数为 0，没有自动修复；手动「按意见修复」那条交接同样带指令。
  const third = await openRound("run-b", 1, "2026-11-02T00:00:00.000Z", 0);
  assert.ok(third.prompt.includes("[1.2.1]"), "跨链的条目照样带编号");
  await finishRound("run-b", 1, third, ["切换项目后筛选仍然丢失"], [{ finding: 1, from: "1.2.1" }]);
  assert.equal((await repairs()).length, 0, "轮数用完：不自动投递修复");
  assert.ok(timeline().includes(label(3)), "跨链熔断同样写进时间线");
  const runB = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "run-b")))[0]!;
  assert.ok((await freeManualRepairPrompt(id, runB)).includes(`【${label(3)}】`), "手动修复交接也带熔断指令");
  const manualA = await freeManualRepairPrompt(id,
    (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "run-a")))[0]!, { round: 1 });
  assert.ok(!manualA.includes("已熔断"), "修的是没熔断的那一轮时不带");
  assert.equal((await freeWorkflowState(id)).reviews.find((run) => run.id === "run-b")!.rounds[0]!.recurrence, 3);

  // 下一轮审查一开，最近一轮换成新的那一轮，提问格式闸自然落下。
  await openRound("run-b", 2, "2026-11-02T00:00:00.000Z", 1);
  assert.equal(await recurrenceBreakerActive(id), false, "新一轮审查在跑：不再处在熔断修复里");

  console.log("✓ 同类问题熔断：承接只认发出去的编号、错填按没填；谱系按紧邻轮次传递且跨链；熔断指令只在触发轮出现并留痕；熔断提问过硬格式校验");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
