// 熔断判决**跨得过 server 重启**吗 —— 两个独立进程、同一个库,真 `consumeSingleRun`。
// 跑:npm -w server run test:stall-restart
//
// 起因(审查 F3,已实测):判决原先只活在进程内存里,而 **detached 的 agent 活得过 server 重启**
// (executors/detached.ts,ash 的既有能力)。于是有这样一条路 —— 看门狗判了熔断、终止请求还没
// 兑现(codex 的 kill 先发 interrupt、另设 2 秒回收)时 server 退出;重启接管那个仍然存活的
// 进程,新进程的 Map 空着;上游恰好恢复并正常答完,这一轮就按 `completed` 结算、任务落 `done`。
// 用户那边早已看到「已自动终止本回合并按失败结算」,而最后显示的是「已完成」。
//
// 退出码重建不出这个事实(被我们杀掉的进程多半 exit 0),所以判决本身必须按回合身份落库。
//
// 为什么非得两个进程:同进程里 `__resetStallFailures()` 只能模拟「内存没了」,**模拟不了
// 「模块级 Map 随进程一起消失、而库还在」** —— 而这正是要测的那件事。所以这里真的 spawn
// 两次,第一段在终止请求发出后当场退出(模拟 server 被杀),第二段全新进程接管同一行会话。
//
// 两段都用合成上游(不起真 CLI、不连模型、不碰生产库)。第二段刻意让上游**完全恢复、正常
// 答完**:那是对判决最严格的考验 —— 没有任何退出码能提示这一轮出过问题。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const phase = process.argv[2];
const AT = "2026-10-31T01:00:00.000Z";

if (!phase) {
  // ── 调度:同一个临时库,两个独立进程依次跑 ───────────────────────────────────
  const stage = mkdtempSync(join(tmpdir(), "ash-stall-restart-"));
  const lines: string[] = [];
  for (const next of ["before-restart", "after-restart"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, next], {
      encoding: "utf8",
      env: { ...process.env, ASH_STALL_RESTART_STAGE: stage },
    });
    process.stderr.write(child.stderr ?? "");
    lines.push(...(child.stdout ?? "").split("\n").filter(Boolean));
    assert.equal(child.status, 0, `${next} 阶段退出码 ${child.status}\n${child.stdout}`);
  }
  const say = (event: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.event === event);

  // ① 第一段:看门狗真的熔断了,而且那一刻判决在内存里。
  const tripped = say("termination-requested");
  assert.ok(tripped, `第一段没熔断 —— 夹具不对\n${lines.join("\n")}`);
  assert.equal(tripped.verdict, true, "熔断那一刻内存里没有判决");

  // ② 第二段(全新进程)接管:**判决必须还在**。旧版这里是 false —— 那就是整条缺陷的起点。
  const resumed = say("resumed");
  assert.ok(resumed, `第二段没跑起来\n${lines.join("\n")}`);
  assert.equal(
    resumed.verdict,
    true,
    "重启接管后判决丢了 —— 上游一恢复,被我们熔断的那一轮就会按正常完成结算",
  );
  // 终止义务也要跟着恢复:判决已经作出、话已经说出去了,不能让它接着跑下去。
  assert.equal(resumed.killed, true, "接管后没有继续兑现终止义务");

  // ③ 最后显示成什么:这一段是上游**完全恢复、正常答完**(exit 0),没有任何退出码能提示
  // 出过问题 —— 结论只能来自那份判决。
  const settled = say("settled");
  assert.ok(settled, `第二段没走到结算\n${lines.join("\n")}`);
  assert.equal(settled.task, "failed", "任务落成了「已完成」—— 看门狗说过的话一句没兑现");
  assert.equal(settled.turn, "failed", "回合区间记成了 completed");
  console.log("test:stall-restart ok：判决按回合身份落库,重启接管后结论与终止义务都还在");
} else {
  // ── 两段共用的一段:合成上游 + 真 consumeSingleRun ───────────────────────────
  const stage = process.env.ASH_STALL_RESTART_STAGE!;
  process.env.ASH_DB = join(stage, "restart.db");
  process.env.HARNESS_DB = process.env.ASH_DB;
  process.env.ASH_RUNS_DIR = join(stage, "runs");
  process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
  process.env.ASH_STALL_WARN_ERRORS = "3";
  process.env.ASH_STALL_WARN_MS = "80";
  process.env.ASH_STALL_TRIP_MS = "160";
  process.env.ASH_STALL_POLL_MS = "20";

  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { sessions, tasks } = await import("../src/db/schema.js");
  const { openTurn } = await import("../src/session-turns.js");
  const { consumeSingleRun } = await import("../src/single-run.js");
  const { stallFailure } = await import("../src/turn-stall-verdict.js");
  await ensureSchema();

  const cwd = join(stage, "workspace");
  if (phase === "before-restart") {
    await db.insert(tasks).values({
      id: "restart", projectId: "isolated", title: "熔断后消费者重启", body: "",
      status: "running", mode: "single", workflowMode: "free", createdAt: AT, updatedAt: AT,
    });
    await db.insert(sessions).values({
      id: "restart-session", taskId: "restart", role: "single", agentType: "codex",
      executor: "codex@smoke", cwd, startedAt: AT, turnStartedAt: AT, cliSessionId: "cli-restart",
    });
    await openTurn({ taskId: "restart", sessionId: "restart-session", cwd, startedAt: AT });
  }
  mkdirSync(join(stage, "runs", "restart"), { recursive: true });
  const out = createWriteStream(join(stage, "runs", "restart", "restart-session.md"), { flags: "a" });
  const emit = (row: Record<string, unknown>) => console.log(JSON.stringify({ phase, ...row }));

  let killed = false;
  const handle = {
    sessionId: "cli-restart",
    commandLine: "synthetic detached run across a consumer restart",
    kill() {
      killed = true;
      if (phase !== "before-restart") return;
      // 第一段:终止**请求**发出了,但进程还没真的没(codex 那条路是 interrupt + 2 秒回收)。
      // 就在这个窗口里把 server 杀掉 —— agent 仍然存活,等着被下一个进程接管。
      emit({ event: "termination-requested", verdict: !!stallFailure("restart-session", AT) });
      setTimeout(() => process.exit(0), 30);
    },
    events: {
      async *[Symbol.asyncIterator]() {
        if (phase === "before-restart") {
          // 上游一直连不上:只有重试提示,一条正文都没有 —— 看门狗该熔断。
          for (;;) {
            yield { kind: "error", message: "Reconnecting: upstream offline", level: "notice", affectsTurn: false };
            await new Promise((done) => setTimeout(done, 20));
          }
        }
        // 第二段:接管时判决该已经装回来了(此刻 `restoreStallVerdict` 已跑过)。
        emit({ event: "resumed", verdict: !!stallFailure("restart-session", AT), killed });
        yield { kind: "text", text: "上游恢复后,原执行器正常收口。\n" };
        yield { kind: "done", exitStatus: 0 };
      },
    },
  };

  await consumeSingleRun({
    taskId: "restart", sessId: "restart-session", agentType: "codex",
    ex: { type: "codex", name: "smoke", model: null } as never,
    cwd, handle: handle as never, out, turnStart: AT, cliSessionId: "cli-restart", autoTitle: false,
  });
  const task = (await dbClient.execute("SELECT status FROM tasks WHERE id = 'restart'")).rows.at(0)?.status;
  const turn = (await dbClient.execute("SELECT outcome FROM session_turns WHERE session_id = 'restart-session'")).rows.at(0)?.outcome;
  emit({ event: "settled", task, turn });
  process.exit(0);
}
