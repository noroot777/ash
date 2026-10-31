// 熔断判决**跨得过 server 重启**吗 —— 两个独立进程、同一个库,真 `consumeSingleRun`。
// 跑:npm -w server run test:stall-restart
//
// 起因(第 3 轮审查 F3,已实测):判决原先只活在进程内存里,而 **detached 的 agent 活得过 server
// 重启**(executors/detached.ts,ash 的既有能力)。于是有这样一条路 —— 看门狗判了熔断、终止请求
// 还没兑现(codex 的 kill 先发 interrupt、另设 2 秒回收)时 server 退出;重启接管那个仍然存活的
// 进程,新进程的 Map 空着;上游恰好恢复并正常答完,这一轮就按 `completed` 结算、任务落 `done`。
// 用户那边早已看到「已自动终止本回合并按失败结算」,而最后显示的是「已完成」。
//
// 退出码重建不出这个事实(被我们杀掉的进程多半 exit 0),所以判决本身必须按回合身份存住。
//
// **两个场景,差别只在第一段退出时库忙不忙**(第 4 轮审查 F1,它拦下的正是第二个):
//   ① 无竞争 —— 判决该存住,接管后结论和终止义务都还在。
//   ② 库被另一笔长事务占着 —— `dbClient` 的写要过 `whenIdle`(写不许借别人的事务),这条
//      UPDATE 排在队里,**既没抛错也没落盘**。判决作出之后紧接着就是不可撤销的两件事(时间线
//      诊断、终止请求),消费者在这段窗口退出,排着的写和内存判决一起消失。所以这一段额外钉:
//      熔断那一刻库里那一格**确实还是 NULL**(证明这个窗口真被走到了,不是测了条顺风路),
//      而判决**照样恢复得出来** —— 因为事实落在日志里(turn-stall-journal.ts),库那一格只是投影。
//
// 为什么非得两个进程:同进程里 `__resetStallFailures()` 只能模拟「内存没了」,**模拟不了
// 「模块级 Map 随进程一起消失、而盘上的东西还在」** —— 而这正是要测的那件事。所以这里真的
// spawn 两次,第一段在终止请求发出后当场退出(模拟 server 被杀),第二段全新进程接管同一行会话。
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
const HOLD_TX = "ASH_STALL_RESTART_HOLD_TX";

if (!phase) {
  // ── 调度:两个场景各一个临时库,每个场景两个独立进程依次跑 ──────────────────────
  for (const scene of [{ what: "无竞争", hold: false }, { what: "库被另一笔长事务占着", hold: true }]) {
    const stage = mkdtempSync(join(tmpdir(), "ash-stall-restart-"));
    const lines: string[] = [];
    for (const next of ["before-restart", "after-restart"]) {
      const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, next], {
        encoding: "utf8",
        env: { ...process.env, ASH_STALL_RESTART_STAGE: stage, ...(scene.hold ? { [HOLD_TX]: "1" } : {}) },
      });
      process.stderr.write(child.stderr ?? "");
      lines.push(...(child.stdout ?? "").split("\n").filter(Boolean));
      assert.equal(child.status, 0, `${scene.what}/${next} 阶段退出码 ${child.status}\n${child.stdout}`);
    }
    const say = (event: string) =>
      lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.event === event);
    const where = (why: string) => `[${scene.what}] ${why}\n${lines.join("\n")}`;

    // ① 第一段:看门狗真的熔断了,那一刻判决在内存里、而且**已经落盘**。
    const tripped = say("termination-requested");
    assert.ok(tripped, where("第一段没熔断 —— 夹具不对"));
    assert.equal(tripped.verdict, true, where("熔断那一刻内存里没有判决"));
    assert.equal(tripped.journaled, true, where("熔断那一刻判决没落盘 —— 不可撤销的终止抢在了落盘前面"));

    // ② 场景②专钉:那一刻库里那一格**还是 NULL**(写排在别人的事务后面)。
    // 这一条同时保证这个场景没有退化成顺风路 —— 真的走在「发起了写、但还没落库」的窗口里。
    if (scene.hold) {
      assert.equal(tripped.column, null, where("库那一格居然写进去了 —— 这一段没模拟出事务占用,场景失效"));
    }

    // ③ 第二段(全新进程)接管:**判决必须还在**。旧版这里是 false —— 那就是整条缺陷的起点。
    const resumed = say("resumed");
    assert.ok(resumed, where("第二段没跑起来"));
    assert.equal(resumed.verdict, true, where("重启接管后判决丢了 —— 上游一恢复,被我们熔断的那一轮就会按正常完成结算"));
    // 终止义务也要跟着恢复:判决已经作出、话已经说出去了,不能让它接着跑下去。
    assert.equal(resumed.killed, true, where("接管后没有继续兑现终止义务"));

    // ④ 最后显示成什么:这一段是上游**完全恢复、正常答完**(exit 0),没有任何退出码能提示
    // 出过问题 —— 结论只能来自那份判决。
    const settled = say("settled");
    assert.ok(settled, where("第二段没走到结算"));
    assert.equal(settled.task, "failed", where("任务落成了「已完成」—— 看门狗说过的话一句没兑现"));
    assert.equal(settled.turn, "failed", where("回合区间记成了 completed"));
  }
  console.log("test:stall-restart ok：判决落盘,库忙着排队也不影响,重启接管后结论与终止义务都还在");
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
  const { readStallVerdict } = await import("../src/turn-stall-journal.js");
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
  /** 库里那一格 —— 读不走 `whenIdle`,所以占着事务也问得出来。 */
  const column = async (): Promise<unknown> =>
    (await dbClient.execute("SELECT stall_reason FROM session_turns WHERE session_id = 'restart-session'"))
      .rows.at(0)?.stall_reason ?? null;

  let killed = false;
  const handle = {
    sessionId: "cli-restart",
    commandLine: "synthetic detached run across a consumer restart",
    kill() {
      killed = true;
      if (phase !== "before-restart") return;
      // 第一段:终止**请求**发出了,但进程还没真的没(codex 那条路是 interrupt + 2 秒回收)。
      // 就在这个窗口里把 server 杀掉 —— agent 仍然存活,等着被下一个进程接管。
      void column().then((stallReason) => {
        emit({
          event: "termination-requested",
          verdict: !!stallFailure("restart-session", AT),
          journaled: !!readStallVerdict("restart-session", AT),
          column: stallReason,
        });
        setTimeout(() => process.exit(0), 30);
      });
    },
    events: {
      async *[Symbol.asyncIterator]() {
        if (phase === "before-restart") {
          // 场景②:在这里占住连接。**不提交也不回滚** —— 进程马上就要没了,而这正是现场:
          // 判决的写排在这笔事务后面,一个字节都还没落库。
          if (process.env[HOLD_TX]) await dbClient.transaction("write");
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
