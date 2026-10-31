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
// **九个场景**(前两个差别只在第一段退出时库忙不忙,第 4 轮审查 F1 拦下的正是第二个):
//   ① 无竞争 —— 判决该存住,接管后结论和终止义务都还在。
//   ② 库被另一笔长事务占着 —— `dbClient` 的写要过 `whenIdle`(写不许借别人的事务),这条
//      UPDATE 排在队里,**既没抛错也没落盘**。判决作出之后紧接着就是不可撤销的两件事(时间线
//      诊断、终止请求),消费者在这段窗口退出,排着的写和内存判决一起消失。所以这一段额外钉:
//      熔断那一刻库里那一格**确实还是 NULL**(证明这个窗口真被走到了,不是测了条顺风路),
//      而判决**照样恢复得出来** —— 因为事实落在日志里(turn-stall-journal.ts),库那一格只是投影。
//   ③ 判决日志读不出来(第 5 轮审查 F1,已实测):库那一格排队没落、日志又被改成不可读,于是
//      这一轮的结局**核实不了**。那时不许把它升级成成功 —— 但也不该杀:我们并不知道它熔断过
//      没有。所以这一段钉的是「只说不杀、照样落 failed」。
//   ④ **全新起跑的回合 + 日志读不出来**:这一档必须**什么都不发生**。「核实不了」只对上一个
//      进程留下来的回合成立 —— 全新起跑的身份此刻刚生成,盘上不可能有它的判决,读不出来推不出
//      任何结论。少了这一条,一次日志权限故障就会把这台 ash 上每一轮都打成失败。
//      「是不是留下来的」由事实认(本进程开过那一行开始记录没有,见 session-turn-registry.ts 的
//      `openedHere`),不由调用方申报 —— 申报的默认值落在不安全那一侧,忘了传就退回 F1。
//   ⑤ 原进程**没活到接管**,走启动对账(第 5 轮审查 F3,已实测):持续目标原先在这条路上被
//      写成「因服务中断已暂停」,界面显示暂停中 + 继续,回合区间 `outcome` 留空 —— 而判决明明
//      还在日志里读得出来。两个结算入口共用同一句问话之后,这条路落 failed 并把区间收口。
//   ⑦ **区间已经收口、任务还没落位**时进程退出(第 1 轮审查 F1,已实测):单飞那条链先落区间,
//      之后还要补录 MCP、保存持续目标,隔着好几个 await 才轮到任务结算。盘上于是留下「区间已
//      failed、任务仍 running」。上一版压缩按「`ended_at` 非空 ⇒ 没人要了」把判决删掉,恢复又只
//      枚举还开着的区间 —— 一个已经提示过「已自动终止」的持续目标回来显示「暂停中 + 继续」。
//   ⑧ **开始行压根没落下**(同一条 F1 的第二个实例):`openTurn` 那一批写失败,而看门狗照样
//      熔断并把判决落了盘。恢复身份集合如果只由「现有的开放区间」决定,这一类压根没人问。
//   ⑨ **已完成任务的一次失败续聊**(第 1 轮审查 F2,已实测):正常收尾保住 `done`(续聊只能变好
//      不会变差),而启动对账原先另写了一行三元表达式,无条件把整个任务降成 failed —— 用户那边
//      唯一的区别只是 ash 有没有重启。
//
// 为什么非得两个进程:同进程里 `__resetStallFailures()` 只能模拟「内存没了」,**模拟不了
// 「模块级 Map 随进程一起消失、而盘上的东西还在」** —— 而这正是要测的那件事。所以这里真的
// spawn 两次,第一段在终止请求发出后当场退出(模拟 server 被杀),第二段全新进程接管同一行会话。
//
// 两段都用合成上游(不起真 CLI、不连模型、不碰生产库)。第二段刻意让上游**完全恢复、正常
// 答完**:那是对判决最严格的考验 —— 没有任何退出码能提示这一轮出过问题。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const phase = process.argv[2];
const AT = "2026-10-31T01:00:00.000Z";
const HOLD_TX = "ASH_STALL_RESTART_HOLD_TX";
const UNREADABLE = "ASH_STALL_RESTART_UNREADABLE";

if (!phase) {
  // ── 调度:两个场景各一个临时库,每个场景两个独立进程依次跑 ──────────────────────
  const scenes = [
    { what: "无竞争", hold: false, unreadable: false, mode: "consume", expectTask: "failed", phases: ["before-restart", "after-restart"] },
    { what: "库被另一笔长事务占着", hold: true, unreadable: false, mode: "consume", expectTask: "failed", phases: ["before-restart", "after-restart"] },
    { what: "判决日志读不出来", hold: true, unreadable: true, mode: "consume", expectTask: "failed", phases: ["before-restart", "after-restart"] },
    // 这一个只有一段:全新起跑、日志从一开始就读不出来,看它会不会被冤枉。
    { what: "全新起跑遇上日志读不出来", hold: false, unreadable: true, mode: "fresh-unreadable", expectTask: "failed", phases: ["before-restart"] },
    { what: "原进程没活到接管,走启动对账", hold: false, unreadable: false, mode: "reconcile", expectTask: "failed", phases: ["before-restart", "after-restart"] },
    // 同一条路 + 判决核实不了:对账**不许**拿熔断那套措辞去念一份「核实不了」的记录。
    // 这是上一版「并列三档返回」留下的假话:接管失败转对账时对账第二次来问,内存里已经有那份
    // unverified 记录,于是它走「有判决」那一支,被说成「已被判定上游连不上并按失败结算」。
    { what: "走启动对账,且判决核实不了", hold: true, unreadable: true, mode: "reconcile", expectTask: "failed", phases: ["before-restart", "after-restart"] },
    // ⑦ 中间多一段 `close-span`:它**只**落回合区间、不碰任务状态 —— 那正是单飞那条链在
    // `recordTurnSpan` 与 `settleTaskStatus` 之间被打断时盘上留下的样子(区间 failed、任务 running)。
    { what: "区间已收口、任务还没落位时退出", hold: false, unreadable: false, mode: "reconcile", expectTask: "failed", phases: ["before-restart", "close-span", "after-restart"] },
    // ⑧ 开始行压根没落下:库里一条回合行都没有,判决只在日志里。
    { what: "开始行没落下,只有判决在日志里", hold: false, unreadable: false, mode: "no-turn-row", expectTask: "failed", phases: ["before-restart", "after-restart"] },
    // ⑨ 已完成任务的失败续聊:任务那一行**必须保住 done**,失败记在回合区间上。
    { what: "已完成任务的失败续聊走启动对账", hold: false, unreadable: false, mode: "follow-up", expectTask: "done", phases: ["before-restart", "after-restart"] },
  ] as const;
  for (const scene of scenes) {
    const stage = mkdtempSync(join(tmpdir(), "ash-stall-restart-"));
    const lines: string[] = [];
    for (const next of scene.phases) {
      const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, next], {
        encoding: "utf8",
        env: {
          ...process.env, ASH_STALL_RESTART_STAGE: stage, ASH_STALL_RESTART_MODE: scene.mode,
          ...(scene.hold ? { [HOLD_TX]: "1" } : {}),
          ...(scene.unreadable ? { [UNREADABLE]: "1" } : {}),
        },
      });
      process.stderr.write(child.stderr ?? "");
      lines.push(...(child.stdout ?? "").split("\n").filter(Boolean));
      assert.equal(child.status, 0, `${scene.what}/${next} 阶段退出码 ${child.status}\n${child.stdout}`);
    }
    // 产品自己的日志也走 stdout(「从判决日志装回 N 条」之类),不是 JSON 的一律跳过。
    const say = (event: string) =>
      lines.flatMap((l) => {
        try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
      }).find((r) => r.event === event);
    const where = (why: string) => `[${scene.what}] ${why}\n${lines.join("\n")}`;

    // ④ 全新起跑那一档:一个字都不该发生 —— 这一轮正常答完就该落「已完成」。
    if (scene.mode === "fresh-unreadable") {
      const settledFresh = say("settled");
      assert.ok(settledFresh, where("这一段没走到结算"));
      assert.equal(settledFresh.kindAtConsume, null,
        where("全新起跑的回合被登记成「结局核实不了」—— 一次日志故障会把这台 ash 上每一轮都打成失败"));
      // **这一轮自己的结局**才是判据:`completed`。任务那一行照 ash 的完成协议落 `failed`
      // (这个合成回合没调过 complete_task,exit 0 ≠ done),跟日志故障无关 —— 所以这里不拿它
      // 当断言,免得测出一个假的「没被冤枉」。
      assert.equal(settledFresh.turn, "completed",
        where("全新起跑、正常答完的一轮,回合区间被记成了 failed —— 它被日志故障冤枉了"));
      assert.doesNotMatch(String(settledFresh.trace ?? ""), /核实不了/,
        where("全新起跑的一轮被告知「上次中断的结局核实不了」—— 它压根没有上一次"));
      continue;
    }

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

    // ③ 第二段(全新进程)接管:**结论必须还在**。旧版这里是 false —— 那就是整条缺陷的起点。
    if (scene.mode === "consume") {
      const resumed = say("resumed");
      const settled = say("settled");
      assert.ok(resumed, where("第二段没跑起来"));
      if (scene.unreadable) {
        // 核实不了那一档:登记的是「不许按成功结算」,**不是**熔断 —— 所以不杀。
        assert.equal(resumed.kind, "unverified",
          where("日志读不出来,这一轮却被当成了「没判决」(会升级成成功)或者「确凿熔断」(会被误杀)"));
        assert.equal(resumed.killed, false, where("只是核实不了就把一个可能完全健康的 agent 杀了"));
        // 用户看得见的那一句:落在会话的 `.md` 里(`emitTurnError` 的三处之一)。判决记的是
        // **原始起因**(EACCES 那句),措辞由 turn-stall.ts 按收场挑 —— 所以这一条要看产物,
        // 不是看判决里存了什么。
        assert.match(String(settled.trace ?? ""), /核实不了/, where("用户那边一个字都没说"));
      } else {
        assert.equal(resumed.kind, "tripped", where("重启接管后判决丢了 —— 上游一恢复,被我们熔断的那一轮就会按正常完成结算"));
        // 终止义务也要跟着恢复:判决已经作出、话已经说出去了,不能让它接着跑下去。
        assert.equal(resumed.killed, true, where("接管后没有继续兑现终止义务"));
      }
    }

    // ⑤ 最后显示成什么:consume 那三个场景里上游**完全恢复、正常答完**(exit 0),没有任何
    // 退出码能提示出过问题 —— 结论只能来自那份判决(或者「核实不了」这个事实本身)。
    const settled = say("settled");
    assert.ok(settled, where("第二段没走到结算"));
    assert.equal(settled.task, scene.expectTask, scene.expectTask === "done"
      ? where("一次失败续聊把整个已完成的任务降成了失败 —— 续聊的契约是「只能变好,不会变差」,"
        + "而正常收尾那一侧保住了 done:同一个事实按进了哪个入口给出两种结论")
      : where("任务落成了「已完成」/「暂停中」—— 看门狗说过的话一句没兑现"));
    assert.equal(settled.turn, "failed", where("回合区间记成了 completed 或者留空「不知道」"));
    if (scene.mode === "no-turn-row") {
      // 判决是靠**它自己**给出的身份被找回来的(会话行反查任务),不是靠「现有的开放区间」。
      assert.match(String(settled.timeline ?? ""), /按失败结算|按失败收尾/,
        where("库里没有回合行,于是对账压根没问过那条判决 —— 持续目标回来显示「暂停中 + 继续」"));
    }
    if (scene.mode === "reconcile" || scene.mode === "no-turn-row") {
      // 持续目标那一支原先在这里写「因服务中断已暂停」:那句话替用户表达了「它在等你」。
      assert.match(String(settled.timeline ?? ""), /按失败结算|按失败收尾/,
        where("对账把熔断过的那一轮说成了暂停 —— 用户看到的那个结论说它在等人"));
      assert.doesNotMatch(String(settled.timeline ?? ""), /因服务中断已暂停/,
        where("「因服务中断已暂停」还在"));
      if (scene.unreadable) {
        assert.match(String(settled.timeline ?? ""), /核实不了/,
          where("对账没说清这一轮是「核实不了」"));
        assert.doesNotMatch(String(settled.timeline ?? ""), /已被判定上游连不上并按失败结算/,
          where("对账拿熔断的措辞念了一份「核实不了」的记录 —— 那是句假话,我们并不知道它熔断过"));
      }
      assert.equal(settled.goalTurn, 0, where("持续目标没收尾"));
      assert.equal(settled.stallFlag, null, where("旧会话的停滞标记没人撤 —— 下一轮会让红环凭空亮起来"));
      // 压缩**不许**把这条判决扔掉:上一版的判据是「区间收口了 ⇒ 没人要了」,而⑦这一段正是
      // 区间已收口、任务还没落位。扔掉之后对账无从得知这一轮失败过。
      assert.equal(settled.compacted ?? null, null,
        where("启动压缩把一条还没销账的判决清掉了(dropped 非零)"));
    }
  }
  console.log("test:stall-restart ok：判决落盘;库排队、日志读不出来、原进程没活到接管三条路都不会把一轮失败说成成功,全新起跑也不会被冤枉");
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

  const mode = process.env.ASH_STALL_RESTART_MODE ?? "consume";
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { sessions, tasks } = await import("../src/db/schema.js");
  const { openTurn } = await import("../src/session-turns.js");
  const { stallJournalFileForDb } = await import("../src/turn-stall-journal.js");
  await ensureSchema();
  // 场景③:第二段开始前把日志改成不可读 —— 必须在 turn-stall-persist 装载之前动手(装载就在
  // 那个模块的模块初始化里),所以这几句排在下面那些 import 前面。
  if (process.env[UNREADABLE] && (phase === "after-restart" || mode === "fresh-unreadable")) {
    const journal = stallJournalFileForDb(process.env.ASH_DB);
    writeFileSync(journal, "", { flag: "a" }); // 全新那一档盘上压根还没有这个文件
    chmodSync(journal, 0o000);
  }
  const { consumeSingleRun } = await import("../src/single-run.js");
  const { stallFailure } = await import("../src/turn-stall-verdict.js");
  const { readStallJournal, pendingStallVerdicts } = await import("../src/turn-stall-journal.js");
  // 「落盘了吗」问的是**还没销账的那一份**:日志里同时躺着判决行和销账行,只数判决行会把一条
  // 已经结算过的旧判决也算成「还欠着」(turn-stall-journal.ts 文件头第四条)。
  const journaled = (sessionId: string, at: string): boolean =>
    pendingStallVerdicts(readStallJournal()).some((r) => r.sessionId === sessionId && r.turnStartedAt === at);

  const cwd = join(stage, "workspace");
  if (phase === "before-restart") {
    await db.insert(tasks).values({
      id: "restart", projectId: "isolated", title: "熔断后消费者重启", body: "",
      status: "running", mode: "single", workflowMode: "free", createdAt: AT, updatedAt: AT,
      // 对账那条路专门用持续目标:它是 F3 里被写成「因服务中断已暂停」的那一支,而「暂停」
      // 这个落位恰恰把一轮失败说成了「在等你」。cliState 给成能被 hold 的形状,否则
      // interruptCliGoal 直接返回 false,这一段就测不到那个分叉。
      ...(mode === "reconcile" || mode === "no-turn-row"
        ? { goalTurn: true, cliState: JSON.stringify({ codex: { goal: { objective: "一直盯着上游", status: "active" } } }) }
        : {}),
      // ⑨ 已完成任务的一次失败续聊:落位该退回 `done`,不是把整个任务降成 failed。
      ...(mode === "follow-up" ? { followUpFrom: "done" } : {}),
    });
    await db.insert(sessions).values({
      id: "restart-session", taskId: "restart", role: "single", agentType: "codex",
      executor: "codex@smoke", cwd, startedAt: AT, turnStartedAt: AT, cliSessionId: "cli-restart",
    });
    // ⑧ 这一档**故意不开**那一行:模拟 `openTurn` 那一批写失败(排在别人的事务后面,既没抛错
    // 也没落盘)。判决照样会落日志 —— 恢复的身份集合因此不能只由「现有的开放区间」决定。
    if (mode !== "no-turn-row") {
      await openTurn({ taskId: "restart", sessionId: "restart-session", cwd, startedAt: AT });
    }
  }
  mkdirSync(join(stage, "runs", "restart"), { recursive: true });
  const out = createWriteStream(join(stage, "runs", "restart", "restart-session.md"), { flags: "a" });
  const emit = (row: Record<string, unknown>) => console.log(JSON.stringify({ phase, ...row }));
  /** 库里那一格 —— 读不走 `whenIdle`,所以占着事务也问得出来。 */
  const column = async (): Promise<unknown> =>
    (await dbClient.execute("SELECT stall_reason FROM session_turns WHERE session_id = 'restart-session'"))
      .rows.at(0)?.stall_reason ?? null;

  if (phase === "close-span") {
    // ⑦ 单飞那条链在 `recordTurnSpan` 与 `settleTaskStatus` 之间被打断时,盘上留下的就是这个样子:
    // 回合区间已经 failed、任务那一行还是 running。两件事隔着好几个 await(补录 MCP、保存持续
    // 目标),而中间任何一刻进程没了都会定格在这儿。这一段**只**落区间,一个字都不碰任务 ——
    // 也不销账(销账的唯一出口是结算之后那一句 `clearStallFailure`,这里压根没走到结算)。
    const { recordTurnSpan } = await import("../src/session-turns.js");
    await recordTurnSpan({
      taskId: "restart", sessionId: "restart-session", cwd, startedAt: AT,
      endedAt: "2026-10-31T01:05:00.000Z", outcome: "failed",
    });
    emit({ event: "span-closed" });
    process.exit(0);
  }

  // 启动顺序照 index.ts:压缩排在接回/对账前面。这一步是⑦的要害 —— 上一版按「区间收口了 ⇒
  // 没人要了」压缩,正好会把⑦那条还没销账的判决清掉,后面的对账于是无从得知这一轮失败过。
  let compacted: number | null = null;
  if (phase === "after-restart") {
    const { compactStallVerdicts } = await import("../src/turn-stall-persist.js");
    compacted = (await compactStallVerdicts())?.dropped || null;
  }

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
          journaled: journaled("restart-session", AT),
          column: stallReason,
        });
        setTimeout(() => process.exit(0), 30);
      });
    },
    events: {
      async *[Symbol.asyncIterator]() {
        if (mode === "fresh-unreadable") {
          // 全新起跑:上游一切正常。此刻 `restoreStallVerdict` 已经跑过了,看它登记了什么。
          emit({ event: "fresh", kind: stallFailure("restart-session", AT)?.kind ?? null });
          yield { kind: "text", text: "一切正常。\n" };
          yield { kind: "done", exitStatus: 0 };
          return;
        }
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
        // 第二段:接管时结论该已经装回来了(此刻 `restoreStallVerdict` 已跑过)。
        const held = stallFailure("restart-session", AT);
        emit({ event: "resumed", kind: held?.kind ?? null, killed, diagnosis: held?.reason ?? null });
        yield { kind: "text", text: "上游恢复后,原执行器正常收口。\n" };
        yield { kind: "done", exitStatus: 0 };
      },
    },
  };

  if (mode !== "consume" && mode !== "fresh-unreadable" && phase === "after-restart") {
    // 原进程**没活到接管**:这条路上没有句柄可以消费,只有启动对账。真入口,不是手写一份。
    const { reconcileInterruptedTask } = await import("../src/task-reconcile.js");
    assert.equal(await reconcileInterruptedTask("restart"), true, "对账没认领这个被打断的任务");
  } else {
    await consumeSingleRun({
      taskId: "restart", sessId: "restart-session", agentType: "codex",
      ex: { type: "codex", name: "smoke", model: null } as never,
      cwd, handle: handle as never, out, turnStart: AT, cliSessionId: "cli-restart", autoTitle: false,
    });
  }
  const taskRow = (await dbClient.execute("SELECT status, goal_turn FROM tasks WHERE id = 'restart'")).rows.at(0);
  const turn = (await dbClient.execute("SELECT outcome FROM session_turns WHERE session_id = 'restart-session'")).rows.at(0)?.outcome;
  const stallFlag = (await dbClient.execute("SELECT upstream_stalled_since FROM sessions WHERE id = 'restart-session'"))
    .rows.at(0)?.upstream_stalled_since ?? null;
  // 时间线落在会话的 `.md` 里(task-timeline.ts),不是库里的一列。运行输出那条流是异步冲刷的,
  // 一个字都还没落盘时文件可能压根不存在 —— 那不是失败,所以这里不许因此抛。
  const transcript = join(stage, "runs", "restart", "restart-session.md");
  const timeline = existsSync(transcript) ? readFileSync(transcript, "utf8") : "";
  // **用户看得见的那一条红字看 trace**:`.md` 那条流是异步冲刷的,而这个夹具末尾要
  // `process.exit`(模拟 server 被杀),缓冲里的内容跟着丢 —— 不是产品少写了。trace 是同步追加
  // 的,而且它才是刷新页面之后按回合回放的那一份,正好对上项目那条「刷新后仍看得出」的判据。
  const tracePath = join(stage, "runs", "restart", "restart-session.trace.jsonl");
  const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
  emit({
    event: "settled", task: taskRow?.status, turn, goalTurn: taskRow?.goal_turn ?? null, timeline, trace, stallFlag, compacted,
    kindAtConsume: stallFailure("restart-session", AT)?.kind ?? null,
  });
  process.exit(0);
}
