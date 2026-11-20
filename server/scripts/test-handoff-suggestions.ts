// 挂在回复框顶上的建议任务随任务接力（src/handoff-suggestions.ts）：
//   · 带着没处理的建议接力出去：对端任务上那几件还在、派得出去；交给谁里的执行器 id 不过机器，类型、模型、
//     智能水平、从哪开工原样；出发前的收回记录对端也读得到；
//   · 对端期间新挂的、派掉的、收回的，移回后原机上跟对端一致；原机存档里还留着的那一件接回原来选的执行器；
//     收回记录一条不少、也不重；
//   · 老版本对端的清单没有这两个键：第一次导入落成空的，移回时本机那两列一个字节都不动；
//   · 收回记录只增不减：对端带回来的比本机少（途中丢过），本机的不变少，新的接在后面；
//   · 对端攒下的收回记录再多也移得回来（追加那条 SQL 的参数个数不跟条数涨），本机空着和已有记录两种都接得上；
//   · 带了但不是 JSON 数组、或者数组里有认不出的条目：整份拒收，本机的不动；不认识的智能体类型按没指明交给谁落；
//   · 等着用户过目的那一批原样落；里面已经派出的那几件的了结记录单开一个键带（老版本对端认不出它），接回那一批的和
//     还没交给智能体的回执；
//   · 挂着的那几件前置指着的任务本机没有：整个拒收、什么都不落（本机有就照收，同批 key 不算缺）；
//   · 说明里引用的上传附件路径落地时改写成本机路径。
//
// 第一段起两台真服务走完整的接力与移回；后几段单进程直调 importHandoff 喂手写的清单（老版本对端、途中丢
// 记录、坏值都没法靠真服务造出来）。对端与本进程都把 NAVI_RUNS_DIR 指到临时目录：对端派出去的那条新任务
// 起跑时撞 guardAgentSpawn，不会真拉起 CLI。
//
// 跑：npm -w @navi/server run test:handoff-suggestions
import "./isolated-data.js";
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import type { Task } from "@navi/shared";
import type { DispatchSuggestion, WithdrawnSuggestion } from "@navi/shared/dispatch-suggestion";
import { api, makeRepo, startPeer } from "./handoff-test-utils.js";
import { releaseTmpDb } from "./tmp-db.js";
import { killOne, listenerPidsSync } from "../src/platform.js";

const root = mkdtempSync(join(tmpdir(), "navi-handoff-suggestions-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.NAVI_DB = join(root, "local.db");
process.env.NAVI_RUNS_DIR = join(root, "runs-local");
process.env.NAVI_UPLOADS_DIR = join(root, "uploads-local");
assert.ok(
  process.env.NAVI_ALLOW_REAL_AGENT !== "1",
  "本测试靠 guardAgentSpawn 拦真 CLI（对端会起跑派出去的那条任务）；拦截器一失效就会烧用户的真额度",
);

const children: ChildProcess[] = [];
const serverPorts: number[] = [];
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type Columns = { dispatch_suggestions: string | null; dispatch_withdrawals: string | null };

/** 直接读写另一台机器库里那两列：建议和收回本来由智能体在回合里写，这里只要「任务在那台机器上时列里是什么」。 */
function columnsOf(dbPath: string, taskId: string): Columns {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA busy_timeout=5000");
  try {
    return sqlite.prepare("SELECT dispatch_suggestions, dispatch_withdrawals FROM tasks WHERE id = ?").get(taskId) as Columns;
  } finally {
    sqlite.close();
  }
}

function setColumns(dbPath: string, taskId: string, suggestions: DispatchSuggestion[], withdrawals: WithdrawnSuggestion[]): void {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA busy_timeout=5000");
  try {
    sqlite.prepare("UPDATE tasks SET dispatch_suggestions = ?, dispatch_withdrawals = ? WHERE id = ?")
      .run(suggestions.length ? JSON.stringify(suggestions) : null, withdrawals.length ? JSON.stringify(withdrawals) : null, taskId);
  } finally {
    sqlite.close();
  }
}

const suggestion = (id: string, title: string, extra: Partial<DispatchSuggestion> = {}): DispatchSuggestion => ({
  id, title, body: `${title}的完整说明`, note: `${title}的一行为什么`, target: null, base: "trunk",
  proposedAt: "2026-11-18T01:00:00.000Z", batch: id, order: "parallel", wait: "none", ...extra,
});
// 老版本对端存的那一份：没有同一批、先后、等不等这三样。
const oldFormat = ({ batch: _batch, order: _order, wait: _wait, ...item }: DispatchSuggestion) => item;
const ids = (items: { id: string }[]) => items.map((item) => item.id);

const beforeLeaving: WithdrawnSuggestion = { id: "sgOldGone01", title: "出发前收回的那件", reason: "顺手做完了", at: "2026-11-18T02:00:00.000Z" };
const whileAway: WithdrawnSuggestion = { id: "sgAwayGone1", title: "到对端被收回的那件", reason: "情况变了，不用做了", at: "2026-11-18T05:00:00.000Z" };

try {
  // ── 1. 两台真服务：接力出去、在对端处理、移回 ────────────────────────────────────────────
  const repoA = makeRepo(join(root, "repo-a"));
  const repoB = join(root, "repo-b");
  execFileSync("git", ["clone", "--quiet", repoA, repoB]);
  const remember = (proc: ChildProcess) => children.push(proc);
  const machineA = await startPeer({
    NAVI_DB: join(root, "a.db"), NAVI_RUNS_DIR: join(root, "runs-a"), NAVI_UPLOADS_DIR: join(root, "uploads-a"),
  }, remember);
  const machineB = await startPeer({
    NAVI_DB: join(root, "b.db"), NAVI_RUNS_DIR: join(root, "runs-b"), NAVI_UPLOADS_DIR: join(root, "uploads-b"),
  }, remember);
  serverPorts.push(Number(new URL(machineA).port), Number(new URL(machineB).port));

  const projectA = await api<{ id: string }>(machineA, "/projects", json({ name: "harness", repoPath: repoA }));
  const projectB = await api<{ id: string }>(machineB, "/projects", json({ name: "harness", repoPath: repoB }));
  await api(machineA, "/settings", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ handoffTargets: [{ name: "B", url: machineB }] }),
  });
  await api(machineA, "/handoff/request", json({ targetUrl: machineB }));
  const identityA = await api<{ fingerprint: string }>(machineA, "/handoff/identity");
  await api(machineB, `/handoff/peers/${identityA.fingerprint}/approve`, { method: "POST" });

  const task = await api<Task>(machineA, "/tasks", json({
    projectId: projectA.id, title: "带着建议任务接力", body: "带着建议任务接力", mode: "single", workflowMode: "free", useWorktree: false,
  }));
  const kept = suggestion("sgKeepHere1", "一直没处理的那件", {
    target: { agentType: "claude", executorId: "executor-only-on-a", model: "model-one", reasoningEffort: "high" }, base: "here",
  });
  const launchedAway = suggestion("sgLaunchAw1", "到对端派出去的那件");
  const withdrawnAway = suggestion(whileAway.id, whileAway.title);
  setColumns(join(root, "a.db"), task.id, [kept, launchedAway, withdrawnAway], [beforeLeaving]);

  await api(machineA, `/tasks/${task.id}/handoff`, json({
    targetUrl: machineB, targetProjectId: projectB.id, targetName: "B", autoResume: false,
  }));
  const inbound = await api<Task>(machineB, `/tasks/${task.id}`);
  assert.equal(inbound.handoff?.direction, "in");
  assert.deepEqual(ids(inbound.dispatchSuggestions ?? []), [kept.id, launchedAway.id, withdrawnAway.id], "没处理的那几件要跟着任务到对端");
  const keptOnB = inbound.dispatchSuggestions!.find((item) => item.id === kept.id)!;
  assert.deepEqual(
    { title: keptOnB.title, body: keptOnB.body, note: keptOnB.note, base: keptOnB.base, proposedAt: keptOnB.proposedAt },
    { title: kept.title, body: kept.body, note: kept.note, base: "here", proposedAt: kept.proposedAt },
    "标题、说明、那一行为什么、从哪开工原样带到对端",
  );
  assert.deepEqual(
    keptOnB.target, { agentType: "claude", executorId: null, model: "model-one", reasoningEffort: "high" },
    "执行器 id 只在挂它的那台机器上有意义：到对端置空，类型、模型、智能水平原样",
  );
  assert.equal(inbound.dispatchSuggestions!.find((item) => item.id === launchedAway.id)!.target, null, "没指明交给谁的还是没指明");
  assert.deepEqual(inbound.dispatchWithdrawals, [beforeLeaving], "出发前收回的原因在对端也读得到");

  // 对端派得出去：照页面按「派出去」时交的样子，那一件摘掉、新任务挂在这条名下。
  const launched = await api<{ launched: boolean; tasks: { id: string; title: string }[] }>(
    machineB, `/tasks/${task.id}/dispatch-suggestions/launch`,
    json({
      order: "parallel",
      items: [{
        id: launchedAway.id, title: launchedAway.title, body: launchedAway.body, worktreeBase: null,
        target: { agentType: "claude", executorId: null, model: null, reasoningEffort: null },
      }],
    }),
  );
  assert.equal(launched.launched, true);
  const child = await api<Task>(machineB, `/tasks/${launched.tasks[0]!.id}`);
  assert.equal(child.dispatchedBy, task.id, "对端派出去的任务收在这条名下");
  assert.equal(child.title, launchedAway.title);
  assert.deepEqual(
    ids((await api<Task>(machineB, `/tasks/${task.id}`)).dispatchSuggestions ?? []), [kept.id, withdrawnAway.id],
    "派出去的那一件从对端的框顶摘掉，其余的还在",
  );

  // 任务在对端时智能体收回了一件、又新挂了一件（两样都由它在回合里同一笔落库，这里直接写成落完的样子）。
  const hungAway = suggestion("sgHungAway1", "在对端新挂的那件", {
    target: { agentType: "codex", executorId: "executor-only-on-b", model: null, reasoningEffort: null },
    proposedAt: "2026-11-18T05:00:00.000Z",
  });
  const onB = columnsOf(join(root, "b.db"), task.id);
  setColumns(
    join(root, "b.db"), task.id,
    [...(JSON.parse(onB.dispatch_suggestions!) as DispatchSuggestion[]).filter((item) => item.id !== withdrawnAway.id), hungAway],
    [...(JSON.parse(onB.dispatch_withdrawals!) as WithdrawnSuggestion[]), whileAway],
  );

  await api(machineB, `/tasks/${task.id}/handoff`, json({
    targetUrl: machineA, targetProjectId: projectA.id, targetName: "A", autoResume: false,
  }));
  const returned = await api<Task>(machineA, `/tasks/${task.id}`);
  assert.equal(returned.handoff?.direction, "returned");
  assert.deepEqual(
    ids(returned.dispatchSuggestions ?? []), [kept.id, hungAway.id],
    "移回后跟对端一致：没处理的还在、对端新挂的跟回来；对端派掉的、收回的不因为原机存档里还留着就回到框顶",
  );
  assert.equal(
    returned.dispatchSuggestions!.find((item) => item.id === kept.id)!.target?.executorId, "executor-only-on-a",
    "原机存档里还留着同一件、类型没变：接回原机当初选的执行器",
  );
  assert.deepEqual(
    returned.dispatchSuggestions!.find((item) => item.id === hungAway.id)!.target,
    { agentType: "codex", executorId: null, model: null, reasoningEffort: null },
    "对端新挂的那件带着对端的执行器 id：回到原机置空",
  );
  assert.deepEqual(returned.dispatchWithdrawals, [beforeLeaving, whileAway], "收回记录一条不少、也不重：出发前的还在，对端收回的接在后面");

  // ── 2. 单进程直调导入：老版本对端、途中丢记录、坏值 ──────────────────────────────────────
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { importHandoff } = await import("../src/handoff-import.js");
  const { exportSuggestions } = await import("../src/handoff-suggestions.js");
  const { HandoffError } = await import("../src/handoff-types.js");
  const { now } = await import("../src/util.js");
  type HandoffManifest = Awaited<ReturnType<typeof import("../src/handoff-import-payload.js")["validate"]>>;
  await ensureSchema();
  const projectDir = join(root, "plain-project");
  mkdirSync(projectDir, { recursive: true });
  const project = { id: "prjsuggest01", name: "plain", repoPath: projectDir, createdAt: now() };
  await db.insert(projects).values(project);
  const holderFp = "ab".repeat(32);

  /** 持有机发来的清单；`carried` 里没写的键就是清单里没有（老版本对端）。 */
  const manifestFor = (taskId: string, carried: Record<string, unknown>) => ({
    version: 1, sourceHost: "holder-machine", sourcePort: null, sourceFingerprint: holderFp, originFingerprint: null,
    targetProjectId: project.id, transferId: `transfer-${taskId}`, autoResume: false, sourceWorkspace: null,
    task: {
      id: taskId, title: "从持有机回来", body: "从持有机回来", status: "done", stage: null, labels: "[]",
      agentType: "claude", model: null, reasoningEffort: null, autoTitle: false, useWorktree: false, worktreeBase: null,
      workflow: null, workflowMode: "free", workflowAt: null, reviewStep: null, verifyRounds: 0, verifyStationRounds: 0,
      resumePrompt: null, question: null, questionOptions: null, questionItems: null,
      pinnedAt: null, createdAt: now(), startedAt: now(), endedAt: now(), ...carried,
    },
    sessions: [], freeWorkflow: null, git: null, uploads: [], messages: [], schedule: null, files: [],
  }) as unknown as HandoffManifest;

  /** 本机留着的历史存档：当初交给持有机的那一行，列里是出发前的样子。 */
  async function archiveOnLocal(taskId: string, suggestions: DispatchSuggestion[], withdrawals: WithdrawnSuggestion[]): Promise<void> {
    await db.insert(tasks).values({
      id: taskId, projectId: project.id, title: "交给持有机之前", body: "交给持有机之前", mode: "single", status: "canceled",
      workflowMode: "free", useWorktree: false, agentType: "claude", createdAt: now(), updatedAt: now(),
      dispatchSuggestions: suggestions.length ? JSON.stringify(suggestions) : null,
      dispatchWithdrawals: withdrawals.length ? JSON.stringify(withdrawals) : null,
      handoff: JSON.stringify({
        direction: "out", transferId: `out-${taskId}`, peerUrl: "http://holder.test:4317", peerName: "holder-machine",
        peerFp: holderFp, peerTaskId: taskId, at: now(), sessions: 0, git: "none",
      }),
    });
  }
  const localRow = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const local = suggestion("sgLocalOne1", "本机存档里挂着的那件", {
    target: { agentType: "claude", executorId: "executor-on-local", model: null, reasoningEffort: null },
  });

  // 老版本对端：清单里没有这两个键。第一次导入落成空的，不报错。
  await importHandoff(manifestFor("sgtlegacyin", {}), { sourceUrl: "http://holder.test:4317" });
  const legacyIn = await localRow("sgtlegacyin");
  assert.equal(legacyIn.dispatchSuggestions, null);
  assert.equal(legacyIn.dispatchWithdrawals, null);

  // 说明里引用的上传附件：附件本体随任务落到本机，说明里的源机路径改成本机路径（新任务照着它读得到）。
  const uploadName = "sgtupload01-shot.txt";
  const holderPath = `/Users/holder/navi/data/uploads/${uploadName}`;
  const withUpload = manifestFor("sgtuploaded", {
    dispatchSuggestions: JSON.stringify([suggestion("sgUpload001", "说明里带着一张图", { body: `照这张图改：${holderPath}` })]),
  });
  (withUpload as { uploads: unknown[] }).uploads = [{
    name: uploadName, sourcePath: holderPath, dataBase64: Buffer.from("附件内容\n").toString("base64"),
  }];
  await importHandoff(withUpload, { sourceUrl: "http://holder.test:4317" });
  const [uploaded] = JSON.parse((await localRow("sgtuploaded")).dispatchSuggestions!) as DispatchSuggestion[];
  assert.equal(uploaded!.body, `照这张图改：${join(root, "uploads-local", uploadName)}`, "建议说明里的附件路径要改写成本机路径");

  // 老版本对端移回：没带 ≠ 带了个空的，本机那两列一个字节都不动。
  await archiveOnLocal("sgtlegacybk", [local], [beforeLeaving]);
  const beforeLegacyReturn = await localRow("sgtlegacybk");
  await importHandoff(manifestFor("sgtlegacybk", {}), { sourceUrl: "http://holder.test:4317" });
  const afterLegacyReturn = await localRow("sgtlegacybk");
  assert.equal(afterLegacyReturn.title, "从持有机回来", "前提：这次移回确实覆盖了任务行");
  assert.equal(afterLegacyReturn.dispatchSuggestions, beforeLegacyReturn.dispatchSuggestions, "老清单移回不能清掉本机挂着的建议");
  assert.equal(afterLegacyReturn.dispatchWithdrawals, beforeLegacyReturn.dispatchWithdrawals, "老清单移回不能清掉本机的收回记录");

  // 持有机上全处理完了（带了 null），带回来的收回记录还比本机少一条：挂着的清空，收回记录不变少、新的接在后面。
  await archiveOnLocal("sgtshrunken", [local], [beforeLeaving]);
  await importHandoff(manifestFor("sgtshrunken", {
    dispatchSuggestions: null, dispatchWithdrawals: JSON.stringify([whileAway]),
  }), { sourceUrl: "http://holder.test:4317" });
  const afterShrunken = await localRow("sgtshrunken");
  assert.equal(afterShrunken.dispatchSuggestions, null, "带了 null = 持有机上一件都不剩：以它为准");
  assert.deepEqual(JSON.parse(afterShrunken.dispatchWithdrawals!), [beforeLeaving, whileAway], "收回记录只增不减");

  // 只带了挂着的、收回记录那个键没有：收回记录不动。
  await archiveOnLocal("sgtonlyhung", [], [beforeLeaving]);
  await importHandoff(manifestFor("sgtonlyhung", {
    dispatchSuggestions: JSON.stringify([{
      ...oldFormat(suggestion("sgForeign01", "带着本机不认识的东西")), turnToken: "对端库里多记的回合令牌",
      target: { agentType: "not-an-agent", executorId: "executor-elsewhere", model: "m", reasoningEffort: null },
    }]),
  }), { sourceUrl: "http://holder.test:4317" });
  const afterOnlyHung = await localRow("sgtonlyhung");
  assert.deepEqual(
    JSON.parse(afterOnlyHung.dispatchSuggestions!),
    [suggestion("sgForeign01", "带着本机不认识的东西")],
    "逐件按已知的几样重建：多出来的键不落库，不认识的智能体类型按没指明交给谁；老格式按不等的单件落",
  );
  assert.equal(afterOnlyHung.dispatchWithdrawals, JSON.stringify([beforeLeaving]));

  // 等着用户过目的那一批：绑的那一问随 question 一起走，同一批、先后、等不等、谁来审、标签、同批前置原样落。
  const waitingQuestion = "这 2 个任务等你过目";
  const waiting = [
    suggestion("sgWaitOne01", "等着的第一件", {
      batch: "batchW", order: "serial", wait: "continue", key: "one", labels: ["ui"], review: { reviewer: "alpha" },
    }),
    suggestion("sgWaitTwo01", "等着的第二件", { batch: "batchW", order: "serial", wait: "continue", key: "two", prerequisites: ["one"], review: "none" }),
  ];
  // 这一批里用户已经派出了一件（了结记录带着建好的任务号）：单开一个键带，处理完时交给智能体的清单要靠它；
  // 不是这一批的了结记录（那一批早就不在了）不落。
  const created = {
    ...suggestion("sgWaitDone1", "已经派出的那件", { batch: "batchW", order: "serial", wait: "continue", review: "default" }),
    question: waitingQuestion,
    settled: { at: "2026-11-18T03:00:00.000Z", task: { id: "taskBuiltAway", title: "已经派出的那件", target: { agentType: "claude", executorId: null, model: null, reasoningEffort: null } } },
  };
  const stale = { ...created, id: "sgStaleOne1", batch: "batchGone", settled: { at: created.settled.at, task: null } };
  const hung = waiting.map((item) => ({ ...item, question: waitingQuestion }));
  await archiveOnLocal("sgtwaiting", [], []);
  await importHandoff(manifestFor("sgtwaiting", {
    status: "paused", question: waitingQuestion,
    dispatchSuggestions: JSON.stringify(hung),
    dispatchSettled: JSON.stringify([created, stale]),
  }), { sourceUrl: "http://holder.test:4317" });
  const afterWaiting = await localRow("sgtwaiting");
  assert.equal(afterWaiting.question, waitingQuestion);
  assert.deepEqual(JSON.parse(afterWaiting.dispatchSuggestions!), [created, ...hung], "等着的那一批原样落，还绑着那一问；已经派出的那件的记录接上");
  const reExported = exportSuggestions(afterWaiting);
  assert.deepEqual(JSON.parse(reExported.dispatchSuggestions!), hung, "再往外接力：还挂着的那一列不混进了结记录（老版本对端认不出）");
  assert.deepEqual(JSON.parse(reExported.dispatchSettled!), [created], "了结记录单独那个键带着");
  await assert.rejects(importHandoff(manifestFor("sgtwaitbad", { dispatchSettled: JSON.stringify([hung[0]]) }), { sourceUrl: "http://holder.test:4317" }),
    (error: unknown) => error instanceof HandoffError && /dispatchSettled/.test(error.message), "了结记录那个键里混了没了结的：整份拒收");

  // 还没交给智能体的回执（那一批不等了、建了的任务还没告诉它）照样带着走；不再等的那一批里点叉的不带。
  const { question: _bound, ...unbound } = created;
  const receipt = { ...unbound, id: "sgReceipt01", batch: "batchOld", wait: "none" as const };
  const droppedOld = { ...stale, id: "sgDroppedO1", batch: "batchOld", wait: "none" as const };
  await importHandoff(manifestFor("sgtreceipt", {
    dispatchSuggestions: null, dispatchSettled: JSON.stringify([receipt, droppedOld]),
  }), { sourceUrl: "http://holder.test:4317" });
  assert.deepEqual(JSON.parse((await localRow("sgtreceipt")).dispatchSuggestions!), [receipt], "回执跟着走，下一回合开头在这台机器上交");

  // 挂着的那件要等的任务（同批先派出去的那件建出来的任务号）本机没有：接过来也派不出去，整个拒收、什么都不落；
  // 本机有那条任务就照收。同一批里还挂着、用 key 指的不算缺。
  const dependent = suggestion("sgNeedsTask", "要等原机任务的那件", { prerequisites: ["taskOnlyOnHolder"] });
  const inBatch = [
    suggestion("sgUpOne0001", "同批上游", { batch: "batchK", key: "up" }),
    suggestion("sgDownOne01", "同批下游", { batch: "batchK", prerequisites: ["up"] }),
  ];
  await assert.rejects(importHandoff(manifestFor("sgtdangling", { dispatchSuggestions: JSON.stringify([dependent]) }), { sourceUrl: "http://holder.test:4317" }),
    (error: unknown) => error instanceof HandoffError && /要等的任务 taskOnlyOnHolder 不在这台机器上/.test(error.message), "缺了就拒收，说清是哪件、缺哪条");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "sgtdangling"))).length, 0, "什么都没导入");
  await archiveOnLocal("taskOnlyOnHolder", [], []);
  await importHandoff(manifestFor("sgtdangling", { dispatchSuggestions: JSON.stringify([dependent, ...inBatch]) }), { sourceUrl: "http://holder.test:4317" });
  assert.deepEqual(ids(JSON.parse((await localRow("sgtdangling")).dispatchSuggestions!)), [dependent.id, ...ids(inBatch)], "本机有那条任务：照收");

  // 对端攒了很多条收回记录（挂了收、收了挂，条数没有上限）：一次移回全接上，顺序不乱；本机那一列空着的、已经
  // 有记录的两种都走一遍。3000 条 = 逐条给路径和值时 6001 个函数实参，SQLite 各版本的上限（127 / 1000）都过了。
  const manyAway: WithdrawnSuggestion[] = Array.from({ length: 3000 }, (_, at) => ({
    id: `sgMany${String(at).padStart(5, "0")}`, title: `对端收回的第 ${at + 1} 件`, reason: "对端攒下的",
    at: new Date(Date.UTC(2026, 10, 18, 6, 0, at)).toISOString(),
  }));
  await archiveOnLocal("sgtmanynone", [local], []);
  await importHandoff(manifestFor("sgtmanynone", {
    dispatchSuggestions: null, dispatchWithdrawals: JSON.stringify(manyAway),
  }), { sourceUrl: "http://holder.test:4317" });
  const afterManyNone = await localRow("sgtmanynone");
  assert.equal(afterManyNone.title, "从持有机回来", "收回记录再多，移回也要落得了库");
  assert.deepEqual(JSON.parse(afterManyNone.dispatchWithdrawals!), manyAway, "本机那一列空着：带回来的全部落下，照带来的先后");
  await archiveOnLocal("sgtmanysome", [local], [beforeLeaving]);
  await importHandoff(manifestFor("sgtmanysome", {
    dispatchSuggestions: null, dispatchWithdrawals: JSON.stringify([beforeLeaving, ...manyAway]),
  }), { sourceUrl: "http://holder.test:4317" });
  assert.deepEqual(
    JSON.parse((await localRow("sgtmanysome")).dispatchWithdrawals!), [beforeLeaving, ...manyAway],
    "本机已有记录：原来那条还在最前面，带回来的新记录一条不少接在后面",
  );

  // 带了但不是 JSON 数组、或者数组里有认不出的条目：整份拒收，本机的不动（当成「一件都没有」落下去、或者只落
  // 认得出的那几条，都是替用户悄悄少搬了几件）。
  await archiveOnLocal("sgtbadvalue", [local], [beforeLeaving]);
  const beforeBad = await localRow("sgtbadvalue");
  for (const carried of [
    { dispatchSuggestions: "{坏掉的" }, { dispatchSuggestions: "{}" }, { dispatchSuggestions: 42 },
    { dispatchWithdrawals: "\"不是数组\"" },
    { dispatchSuggestions: JSON.stringify([suggestion("sgGoodOne01", "认得出的那件"), { id: "sgNoBody001", title: "缺说明的那件" }]) },
    { dispatchWithdrawals: JSON.stringify([whileAway, { id: "sgNoAt00001", title: "缺时刻的那条", reason: "不知道什么时候收回的" }]) },
  ]) {
    await assert.rejects(
      importHandoff(manifestFor("sgtbadvalue", carried), { sourceUrl: "http://holder.test:4317" }),
      (error: unknown) => error instanceof HandoffError && /dispatch(Suggestions|Withdrawals) 非法/.test(error.message),
      `坏值必须拒收：${JSON.stringify(carried)}`,
    );
  }
  const afterBad = await localRow("sgtbadvalue");
  assert.equal(afterBad.title, beforeBad.title, "拒收的清单什么都没落");
  assert.equal(afterBad.dispatchSuggestions, beforeBad.dispatchSuggestions);
  assert.equal(afterBad.dispatchWithdrawals, beforeBad.dispatchWithdrawals);

  console.log("handoff suggestions: 接力带走 / 对端派得出去 / 移回带回 / 老清单不清本机 / 收回记录只增不减 / 记录再多也移得回 / 坏值拒收 / 附件路径改写 全部通过");
} finally {
  for (const port of serverPorts) {
    for (const pid of listenerPidsSync(port)) killOne(pid, "SIGKILL");
  }
  for (const proc of children) {
    try { proc.kill("SIGKILL"); } catch { /* 已经退了 */ }
  }
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
