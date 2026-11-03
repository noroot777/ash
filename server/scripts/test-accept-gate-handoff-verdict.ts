// 门禁红了交回修复(`handOffGateFailure`)按协议三档裁决交代:收下 / 拒收 / 说不清。
//
// 为什么要有这一份:这条交接是在 main 上按旧契约写的 —— 把销账函数当成 `onDelivered` 传给
// `continueWhenIdle`,「回调被调到」就等于「送到了」。本分支把那一层改成三态之后,合并时要逐档
// 重新交代:协议层明确拒收的那一次不许被记成交接成功,说不清的那一次不许被说成没送到、也不自动
// 重发(与 `resolveInterruptedHandoff` 同一口径),迟到的定论覆盖先前那句。
//
//  H1 收下:交接落地,没有错误,欠账清掉;
//  H2 拒收:记成交接失败、说清「一个字都没送进去」,时间线给出「再交一次」的出路,欠账清掉;
//  H3 说不清 → 迟到的收下:先如实记「没给回执、没自动重发」,回执落定成收下后撤掉那句错误。
//
// 跑:npm -w server run test:accept-gate-handoff-verdict
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { InputAcceptance, RunHandle } from "../src/executors/types.js";
import { root, startHarness } from "./free-review-dispatch-harness.js";
import { releaseTmpDb } from "./tmp-db.js";

process.env.ASH_TURN_INPUT_ACK_MS = "100";

let acceptance: Promise<InputAcceptance> = Promise.resolve("accepted");

try {
  const { db, tasks, freeTask, timeline, until, turnIdentity } = await startHarness();
  const { acceptGateRuns } = await import("../src/db/schema.js");
  const { gateView } = await import("../src/accept-gate-state.js");
  const { handOffGateFailure } = await import("../src/accept-gate-handoff.js");
  const { CodexExecutor } = await import("../src/executors/codex.js");
  const run = (): RunHandle => ({
    sessionId: "gate-handoff-stub", commandLine: "gate handoff stub", kill() {},
    inputAccepted: acceptance,
    events: (async function* () { yield { kind: "done" as const, exitStatus: 0 }; })(),
  });
  CodexExecutor.prototype.run = run;
  CodexExecutor.prototype.runSteerable = run;

  mkdirSync(join(root, "logs"), { recursive: true });
  const seed = async (id: string) => {
    await freeTask(id);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, id));
    const logPath = join(root, "logs", `${id}.log`);
    writeFileSync(logPath, "test failed\n");
    const at = new Date().toISOString();
    await db.insert(acceptGateRuns).values({
      id: `${id}-gate`, taskId: id, projectId: "p", command: "npm test", cwd: root, status: "failed", exitCode: 1,
      logPath, startedAt: at, finishedAt: at, settlement: JSON.stringify({ owed: true }),
    });
    return (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, `${id}-gate`))).at(0)!;
  };
  const gate = async (id: string) => (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, `${id}-gate`))).at(0)!;
  const turnOver = (id: string) => () => !turnIdentity(id);

  // ── H1 收下 ────────────────────────────────────────────────────────────────────────
  {
    const id = "gate-handoff-accepted";
    acceptance = Promise.resolve("accepted");
    const row = await seed(id);
    await handOffGateFailure(row, gateView(row), true);
    await until("交接落地、欠账清掉", async () => (await gate(id)).settlement === null);
    await until("回合结束", turnOver(id));
    const after = await gate(id);
    assert.equal(after.handoffError, null, "收下了就没有错误");
    assert.ok(after.handoffAt, "交接时刻记着");
    assert.doesNotMatch(timeline(id), /拒收|没给回执/);
    console.log("✓ H1 收下:交接落地,没有错误,欠账清掉");
  }

  // ── H2 拒收 ────────────────────────────────────────────────────────────────────────
  {
    const id = "gate-handoff-refused";
    acceptance = Promise.resolve("refused");
    const row = await seed(id);
    await handOffGateFailure(row, gateView(row), true);
    // 先记错误、再销账(同一档里的两笔),所以等的是后一笔。
    await until("拒收记成交接失败、欠账清掉", async () => (await gate(id)).settlement === null);
    assert.match((await gate(id)).handoffError ?? "", /拒收/, "记成交接失败,不是交接成功");
    assert.match(timeline(id), /门禁交接失败：协议层明确拒收.*「再交一次」/, "时间线说清没送进去、怎么办");
    console.log("✓ H2 拒收:记成交接失败、说清没送进去,给出「再交一次」");
  }

  // ── H3 说不清 → 迟到的收下 ──────────────────────────────────────────────────────────
  {
    const id = "gate-handoff-unknown";
    let resolveLate!: (value: InputAcceptance) => void;
    acceptance = new Promise<InputAcceptance>((resolve) => { resolveLate = resolve; });
    const row = await seed(id);
    await handOffGateFailure(row, gateView(row), true);
    await until("说不清如实记下、欠账清掉", async () => (await gate(id)).settlement === null);
    assert.match((await gate(id)).handoffError ?? "", /没给回执/, "说不清如实记下");
    assert.match(timeline(id), /为免重复没有自动重发/, "说不清不许说成没送到,也不自动重发");
    assert.doesNotMatch(timeline(id), /门禁交接失败/, "说不清不是失败");
    resolveLate("accepted");
    await until("迟到的收下撤掉那句错误", async () => (await gate(id)).handoffError === null);
    console.log("✓ H3 说不清 → 迟到的收下:先如实记、不重发,收下后撤掉错误");
  }

  await until("回合都退干净", () => ["gate-handoff-accepted", "gate-handoff-refused", "gate-handoff-unknown"]
    .every((id) => !turnIdentity(id)));
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
