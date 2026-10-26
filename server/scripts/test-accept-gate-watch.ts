// 门禁被收掉时**说不说得清卡在哪**的回归。
//
// 钉住的那件事（用户 2026-10-26）：一次跑满 90 分钟的门禁，日志里只有一句「超过 90 分钟，
// 按超时处理」—— 看不出停在哪一条、静了多久，于是分不出是某一步卡住还是整台机器在爬。
//
// 同时钉住第 1 轮审查打回来的三条边界，别回退：
//  F1 安静 ≠ 卡死：连续没输出只许在日志里喊一声，**不许**把命令收掉；结论也只摆证据和
//     两种读法，不替人断言。
//  F2 现场必须**冻结存盘**：日志里谁最后写不由我们说了算（停止期的清理输出、结算摘要，
//     尤其是没能停下来的那个进程），所以它存在日志旁边，由读口给它留固定位置。
//  F3 谁写的日志按**自己的真实写入记录**认：既不按 `[ash]` 前缀猜（被测命令也能打这个
//     前缀），也不靠两次 stat 推区间（跨进程交错时推出来的区间是错的）。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-gate-watch-"));
process.env.ASH_DB = join(root, "ash.db");
// RUNS_DIR 指到临时目录顺带打开 guardAgentSpawn：门禁红了会**真的发起一轮**去叫醒 agent，
// 拦截器保证那一轮不会起真 CLI。
process.env.ASH_RUNS_DIR = join(root, "runs");
assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1", "门禁红了会叫醒任务，拦截器一失效就会烧真额度");

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * 等一段现场。看门狗的定时器是 `unref` 的（ash 不该被它吊着不退），所以在只有它一个
 * 待办事项的测试进程里 Node 会直接退出 —— 这里自己撑一根活的定时器把事件循环留住。
 */
async function awaitScene(start: (resolve: (verdict: { scene: string; note: string }) => void) => void) {
  const keepAlive = setInterval(() => {}, 20);
  try { return await new Promise<{ scene: string; note: string }>(start); }
  finally { clearInterval(keepAlive); }
}

try {
  const { gateWatchReport, overrideGateWatchTimings, startGateWatch } = await import("../src/accept-gate-watch.js");

  // ① F1 正面：连续没输出只喊一声，命令照跑 —— 安静的编译/等远端/把输出重定向到别处，
  //    都长成「日志不长」的样子，按静默掐死它们等于把一套能跑完的配置判死。
  {
    const logPath = join(root, "quiet.log");
    writeFileSync(logPath, "QUIET_WORK_STARTED\n", "utf8");
    overrideGateWatchTimings({ silenceMs: 100, progressMs: 120, sampleMs: 20, timeoutMs: 600_000 });
    let fired = false;
    const watch = startGateWatch({ logPath, onVerdict: () => { fired = true; } });
    await sleep(700);
    watch.stop();
    const log = readFileSync(logPath, "utf8");
    assert.equal(fired, false, "静默只许报，不许收 —— 本来能跑完的安静命令会被这一刀判死");
    assert.match(log, /\[ash\] 注意 · 已经连续 \d+\.\d 分钟没有任何输出；命令仍在跑，没有被收掉。/);
    assert.equal(log.match(/\[ash\] 注意 ·/g)?.length, 1, "同一段静默只喊一次，不要刷屏");
    assert.match(log, /\[ash\] 进度 · 开跑后 /, "进度行要真的落进日志，不然事后没有时间轴");
  }

  // ② 撞上限：现场要同时给得出「停在哪一行」和「静了多久」，外加一串产出节奏。
  //    这一条同时钉 F3（命令打的就是 `[ash]` 前缀）和 N1（累计产出不含开跑前的启动说明）。
  {
    const logPath = join(root, "timeout.log");
    writeFileSync(logPath, `[ash] 这是开跑前就在的启动说明，一共若干字节，不该算成命令的产出\n`, "utf8");
    overrideGateWatchTimings({ silenceMs: 100, progressMs: 60, sampleMs: 15, timeoutMs: 450 });
    // 命令那一行要在看门狗起来**之后**才写：开跑前就在文件里的都算启动说明，不是产出。
    const verdict = await awaitScene((resolve) => {
      startGateWatch({ logPath, onVerdict: resolve });
      appendFileSync(logPath, "[ash] real-suite: case-27 started\n", "utf8"); // 34 字节，命令自己打的
    });
    assert.match(verdict.scene, /停在这一行：`\[ash\] real-suite: case-27 started`/,
      "按前缀猜来源会把命令自己的输出当心跳删掉（F3）");
    assert.match(verdict.scene, /最后一次有输出在 \d+\.\d 分钟前，即开跑后第 \d+\.\d 分钟。/);
    assert.match(verdict.scene, /产出节奏（开跑第几分钟 \/ 累计输出）：\d/);
    assert.match(verdict.scene, /命令自己的输出累计 34B。/, "累计产出不含启动说明，也不含我们自己的进度行（N1）");
    assert.match(verdict.note, /停在 `\[ash\] real-suite: case-27 started`/);
    assert.match(verdict.note, /最近一次输出在 \d+\.\d 分钟前/);
  }

  // ③ N2：命令停在半行上（没写换行），进度行不许和它粘成一行。
  {
    const logPath = join(root, "no-newline.log");
    writeFileSync(logPath, "", "utf8");
    overrideGateWatchTimings({ silenceMs: 10_000, progressMs: 60, sampleMs: 15, timeoutMs: 400 });
    const verdict = await awaitScene((resolve) => {
      startGateWatch({ logPath, onVerdict: resolve });
      appendFileSync(logPath, "case-27 started", "utf8");
    });
    const log = readFileSync(logPath, "utf8");
    assert.doesNotMatch(log, /case-27 started\[ash\]/, "贴着半行写会把命令输出和心跳粘成一行");
    assert.match(verdict.scene, /停在这一行：`case-27 started`/);
  }

  // ④ R2-F1：命令和我们**跨进程**交错写同一份日志。靠「写前写后两次 stat」推自己那几个
  //    字节落在哪是不成立的 —— 命令插在两次 stat 中间，推出来的区间会把它的输出抹掉、
  //    反倒漏出半行进度行，连「它到底有没有输出过」都会判反。
  {
    const logPath = join(root, "race.log");
    writeFileSync(logPath, "[ash] $ racing-command\n", "utf8"); // 开跑前的启动说明
    const rounds = 20;
    const line = "ACTUAL_CHILD_CASE_STARTED\n"; // 26 字节 × 20 = 520B，故意压在 1KB 以内好精确比对
    overrideGateWatchTimings({ silenceMs: 100_000, progressMs: 20, sampleMs: 10, timeoutMs: 1_000 });
    const verdict = await awaitScene((resolve) => {
      startGateWatch({ logPath, onVerdict: resolve });
      // 真·另一个进程在写，和看门狗的 stat/append 自然交错。
      spawn(process.execPath, ["-e",
        `const fs = require("node:fs"); let i = 0;`
        + ` const t = setInterval(() => { fs.appendFileSync(process.argv[1], ${JSON.stringify(line)});`
        + ` if (++i >= ${rounds}) clearInterval(t); }, 30);`,
        logPath], { stdio: "ignore" }).unref();
    });
    const log = readFileSync(logPath, "utf8");
    assert.equal(log.split("ACTUAL_CHILD_CASE_STARTED").length - 1, rounds, "子进程得在收场前写完，不然这条比不出什么");
    assert.match(verdict.scene, /命令自己的输出累计 520B。/, "字节数要按「自己写了多少」记账，不受交错影响");
    assert.match(verdict.scene, /停在这一行：`ACTUAL_CHILD_CASE_STARTED`/);
    assert.doesNotMatch(verdict.scene, /停在这一行：`\[ash\] 进度/, "推错区间会漏出半行进度行");
    assert.doesNotMatch(verdict.scene, /从头到尾没往门禁日志里写过东西/, "它明明写了 20 行");
    assert.doesNotMatch(verdict.note, /一个字节都没往门禁日志里写过/);
  }

  // ④b R2-F1 的第二个实例：全程没有命令输出时，不许把**开跑前**的启动说明（里面有
  //    `[ash] $ <命令原文>`）当成「停在这一行」，更不能一边说 0B 一边指着它。
  {
    const logPath = join(root, "baseline-only.log");
    writeFileSync(logPath, "[ash] 2026-10-26T00:00:00Z 验收前置命令开跑\n[ash] $ quiet-command\n\n", "utf8");
    overrideGateWatchTimings({ silenceMs: 100_000, progressMs: 40, sampleMs: 10, timeoutMs: 250 });
    const verdict = await awaitScene((resolve) => { startGateWatch({ logPath, onVerdict: resolve }); });
    assert.doesNotMatch(verdict.scene, /停在这一行：`\[ash\] \$ quiet-command`/, "那是 ash 写的，不是命令写的");
    assert.match(verdict.scene, /停在这一行：（这条命令没有往门禁日志里写过任何东西）/);
    assert.match(verdict.scene, /命令自己的输出累计 0B。/);
  }

  // ⑤ `stop()` 之后不该再有结论：命令自己退出、或被取消时走的就是这一条。
  {
    const logPath = join(root, "stopped.log");
    writeFileSync(logPath, "quiet\n", "utf8");
    overrideGateWatchTimings({ silenceMs: 50, progressMs: 1_000, sampleMs: 10, timeoutMs: 60 });
    let fired = false;
    startGateWatch({ logPath, onVerdict: () => { fired = true; } }).stop();
    await sleep(300);
    assert.equal(fired, false, "撤掉的看门狗不许再叫，否则会把一条已经收好的门禁再收一遍");
  }

  // ⑥ F1 反面：措辞只许给「更像」和另一种可能，不许下死判断 —— 卡死的进程一样会打心跳，
  //    安静的命令也可能只是把输出重定向到别处了。
  {
    const quiet = gateWatchReport({ elapsedMs: 90 * 60_000, silentMs: 45 * 60_000, limitMs: 90 * 60_000,
      silenceMs: 20 * 60_000, everProduced: true, lastLine: "system-notices-dom ok", bytes: 12486, marks: ["5.0m/4.1KB"] });
    assert.match(quiet.scene, /\*\*更像\*\*是停在上面那一行之后的某一步/);
    assert.match(quiet.scene, /日志只能证明有没有在输出/, "必须写出反面可能，否则是在给错误的排查方向");

    const busy = gateWatchReport({ elapsedMs: 90 * 60_000, silentMs: 12_000, limitMs: 90 * 60_000,
      silenceMs: 20 * 60_000, everProduced: true, lastLine: "step 9000", bytes: 31_000, marks: [] });
    assert.match(busy.scene, /\*\*更像\*\*是整条命令在爬/);
    assert.match(busy.scene, /卡死在打心跳也长这样/);

    const mute = gateWatchReport({ elapsedMs: 90 * 60_000, silentMs: 90 * 60_000, limitMs: 90 * 60_000,
      silenceMs: 20 * 60_000, everProduced: false, lastLine: null, bytes: 0, marks: [] });
    assert.match(mute.scene, /停在这一行：（这条命令没有往门禁日志里写过任何东西）/);
    assert.match(mute.scene, /可能是它把输出重定向到别处了/, "全程没输出和「出过、后来不出了」是两回事");
    assert.match(mute.scene, /产出节奏（开跑第几分钟 \/ 累计输出）：（没跑够一个采样间隔）/);
  }

  // ⑦ 整条链路。两台：一台安静但正常退出（必须绿），一台撞上限且在停止时吐一大堆清理
  //    输出（现场必须仍在日志尾巴里）。
  {
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-b", "main", repo]);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
    git("config", "user.name", "Gate Watch Test");
    git("config", "user.email", "gate@example.test");
    writeFileSync(join(repo, "seed.txt"), "seed");
    git("add", "-A");
    git("commit", "-m", "seed");

    const { db, ensureSchema } = await import("../src/db/index.js");
    const { acceptGateRuns, projects, sessions, tasks } = await import("../src/db/schema.js");
    const { acceptTask } = await import("../src/task-accept.js");
    const { cancelAcceptGate, whenAcceptGateSettled } = await import("../src/accept-gate.js");
    const { acceptGateLogText, acceptGateLogTail, gateScenePath } = await import("../src/accept-gate-process.js");
    const { sessionTranscriptPath } = await import("../src/transcript.js");
    const { isTurnClaimed } = await import("../src/turn-lock.js");
    await ensureSchema();

    const stamp = new Date().toISOString();
    const seed = async (name: string, command: string) => {
      await db.insert(projects).values({ id: `${name}-project`, name, repoPath: repo,
        acceptGateCommand: command, createdAt: stamp });
      await db.insert(tasks).values({ id: `${name}-task`, projectId: `${name}-project`, title: name, status: "done",
        stage: "verified", workflowMode: "free", mode: "single", useWorktree: false, createdAt: stamp, updatedAt: stamp });
      await db.insert(sessions).values({ id: `${name}-session`, taskId: `${name}-task`, role: "single",
        agentType: "codex", executor: "codex", cwd: repo, startedAt: stamp, turnStartedAt: stamp,
        endedAt: stamp, activeMs: 0 });
      return `${name}-task`;
    };
    const runOf = async (taskId: string) =>
      (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId))).at(0);
    const settled = async (taskId: string) => {
      let run = await runOf(taskId);
      for (let i = 0; i < 600 && (!run || run.status === "running"); i++) { await sleep(25); run = await runOf(taskId); }
      assert.ok(run, `${taskId} 的门禁没有登记`);
      await whenAcceptGateSettled(run.id);
      return run;
    };
    // 红了会真的发起一轮去叫醒 agent（拦截器挡住了真 CLI）。那一轮的收尾是异步的，
    // 不等它落地就关库，剩下的回调会刷一屏 "database is not open"。
    const drain = async (taskId: string) => {
      for (let i = 0; i < 200 && isTurnClaimed(taskId); i++) await sleep(25);
      await sleep(200);
    };

    // 安静但正常：静默线压到 250ms，它要安静 900ms 才退出。这一条必须绿。
    {
      overrideGateWatchTimings({ silenceMs: 250, progressMs: 200, sampleMs: 40, timeoutMs: 600_000 });
      const taskId = await seed("quiet-ok",
        `"${process.execPath}" -e "console.log('QUIET_WORK_STARTED'); setTimeout(() => console.log('QUIET_WORK_DONE'), 900)"`);
      await acceptTask(taskId);
      const run = await settled(taskId);
      assert.equal(run.status, "passed", "安静了几个静默周期但自己正常退出的命令，必须判通过");
      assert.equal(run.exitCode, 0);
      assert.match(readFileSync(run.logPath, "utf8"), /QUIET_WORK_DONE/, "它确实跑完了，没有被半路收掉");
      await drain(taskId);
    }

    // 撞上限 + 停止期吐 6KB 清理输出：现场必须仍在最后 ACCEPT_GATE_TAIL_BYTES 字节里。
    {
      overrideGateWatchTimings({ silenceMs: 100_000, progressMs: 200, sampleMs: 40, timeoutMs: 700 });
      const script = "process.on('SIGTERM', () => { process.stdout.write('CLEANUP '.repeat(900) + String.fromCharCode(10)); process.exit(0); });"
        + " console.log('REAL_GATE_LAST_STEP'); setInterval(() => {}, 1000);";
      const taskId = await seed("tail-keep", `"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"`);
      await acceptTask(taskId);
      const run = await settled(taskId);
      try {
        assert.equal(run.status, "failed");
        assert.equal(run.failure, "timeout");
        const full = readFileSync(run.logPath, "utf8");
        assert.match(full, /CLEANUP CLEANUP/, "这一条要的就是「停止时又吐了一大堆」这个舞台");
        assert.doesNotMatch(full, /被收掉时的现场/, "现场不再往日志里追加，它单独冻结一份");
        assert.ok(existsSync(gateScenePath(run.logPath)), "现场要落成日志旁边那份冻结文件");
        const tail = acceptGateLogTail(run.logPath);
        assert.match(tail, /被收掉时的现场/, "回显的那一段必须给现场留着位置（F2）");
        assert.match(tail, /停在这一行：`REAL_GATE_LAST_STEP`/, "停在哪一行不能变成清理输出");
        assert.match(tail, /最后一次有输出在 \d+\.\d 分钟前/);
        assert.match(acceptGateLogText(run.logPath), /被收掉时的现场/, "「看完整日志」也要看得到");

        // R2-F2：停不掉的进程是受支持的生产状态，它之后写的每个字节都能把追加在日志末尾的
        // 现场顶出去。现场冻结在日志**旁边**，所以这里再灌 20KB 进去也挤不掉它。
        appendFileSync(run.logPath, "ZOMBIE-STILL-WRITING\n".repeat(1000), "utf8");
        const later = acceptGateLogTail(run.logPath);
        assert.match(later, /ZOMBIE-STILL-WRITING/, "这一条要的就是「结算之后还有人在写」这个舞台");
        assert.match(later, /停在这一行：`REAL_GATE_LAST_STEP`/, "后来者不许把现场挤没（R2-F2）");

        const transcript = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
          .map((row) => { try { return readFileSync(sessionTranscriptPath(taskId, row.id), "utf8"); } catch { return ""; } })
          .join("\n");
        assert.match(transcript, /停在 `REAL_GATE_LAST_STEP`，最近一次输出在 \d+\.\d 分钟前/,
          "不点开日志也要知道停在哪、静了多久");
      } finally {
        await cancelAcceptGate(taskId).catch(() => {});
        await drain(taskId);
      }
    }
  }

  overrideGateWatchTimings(null);
  console.log("✅ 门禁看门狗：静默只报不杀 / 现场冻结存盘不被后来者挤掉 / 来源按真实写入记录认 通过");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
