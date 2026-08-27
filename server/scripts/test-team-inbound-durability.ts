// 待送的执行者汇报必须**活过 server 重启**。
//
// 换台丢消息这件事前后修过两轮(先是搬给新 lead,后来是一块模块级托盘 Map),两次都只覆盖
// 同一个进程内的交接。可正常生命周期里还有第三个断点:调度台忙着的时候收到执行者汇报 →
// 它正常收台、任务落回 idle → 用户还没再唤醒它,server 就重启了。新进程的内存是空的,而
// idle 的团队任务开机不会被唤醒(task-reconcile.ts 只叫醒当时还 running/queued 的),那条
// 汇报就永久消失:用户刷新看不到原文,调度者也在缺这份事实的情况下接着做决定。
//
// 所以这条测试**真的开两个互不相干的 Node 进程**,共用同一个 SQLite 库和 runs 目录:
//   ① 进程 A:忙碌调度台收下一条执行者汇报(只进待送队列 —— 没进 CLI,也没落盘)→ 正常收台
//   ② 进程 B:重启之后挂一台健康调度台 —— 它必须收到这条汇报,恰好一次,.md 里也只有一条
//
// 跑:npm -w server run test:team-inbound-durability
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@ash/shared";

const HERE = fileURLToPath(import.meta.url);
const TASK = "task-inbound-durability";
const SESS = "sess-inbound-durability";
const REPORT = "执行者汇报:必须活过 server 重启";
const AT = "2026-08-26T00:00:00.000Z";
const ok = (m: string) => console.log("   ✓ " + m);

const [, , role, root] = process.argv;

if (!role) await parent();
else await child(role, root);

// ── 父进程:依次跑两个子进程,再对它们各自留下的实测结果下断言 ────────────────────────
async function parent(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ash-team-inbound-"));
  try {
    const stage = await run("stage", dir);
    assert.equal(stage.sent, 0, "进程 A 的调度台正忙,这条汇报不该被塞进 CLI");
    assert.equal(
      stage.persisted,
      false,
      "这一条要在「既没进 CLI 也没落盘」的前提下验 —— 否则重启丢的是什么就说不清了",
    );
    assert.equal(stage.queued, 1, "忙碌时收到的执行者汇报必须先落进持久待送队列");
    ok("进程 A:忙碌调度台收下的汇报只进持久队列,没进 CLI 也没落盘");

    const resume = await run("resume", dir);
    assert.equal(
      resume.sent,
      1,
      "重启后新开的调度台一条都没收到 —— 那份执行结果/待回答的提问随着上一个进程的内存永久消失了",
    );
    assert.equal(resume.occurrences, 1, "同一条汇报在 .md 里出现了不止一次");
    assert.equal(resume.queued, 0, "送成之后必须销账,否则下一台还会再送一遍");
    ok("进程 B:重启后接手的调度台照样收到它,恰好一次且落盘一次");
    console.log("test:team-inbound-durability ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 起一个**全新的** Node 进程跑下面的 child(),回收它写下的实测结果。 */
function run(which: string, dir: string): Promise<Record<string, number | boolean>> {
  return new Promise((resolve, reject) => {
    // execArgv 里带着 tsx 的 loader,照搬就能让子进程也直接跑 .ts(不依赖 npx 在 PATH 上)。
    const p = spawn(process.execPath, [...process.execArgv, HERE, which, dir], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${which} 子进程退出码 ${code}`));
      try {
        resolve(JSON.parse(readFileSync(join(dir, `${which}.json`), "utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

// ── 子进程 ──────────────────────────────────────────────────────────────────────
async function child(which: string, dir: string): Promise<void> {
  process.env.ASH_DB = join(dir, "ash.db");
  process.env.ASH_RUNS_DIR = join(dir, "runs");
  process.env.ASH_TEAM_IDLE_MS = "0"; // 别在测试里挂一个 30 分钟的回收计时
  // env 要在这些模块被求值之前定好(db/paths 在模块顶层就读它们),所以走动态 import。
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { attachLead, sendInbound, teamIsLive } = await import("../src/team/session.js");
  const { pendingInbound } = await import("../src/team/inbound-queue.js");
  const { eq } = await import("drizzle-orm");

  const runDir = join(dir, "runs", TASK);
  const mdPath = join(runDir, `${SESS}.md`);
  mkdirSync(runDir, { recursive: true });
  const readMd = () => { try { return readFileSync(mdPath, "utf8"); } catch { return ""; } };

  await ensureSchema();
  if (which === "stage") {
    await db.insert(projects).values({ id: "project", name: "inbound-durability", repoPath: dir, createdAt: AT });
    await db.insert(tasks).values({
      id: TASK, projectId: "project", title: "调度台", body: "带一队人干活", mode: "team",
      status: "running", team: JSON.stringify({ lead: "codex", worker: "codex" }),
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
      autoTitle: false, createdAt: AT, updatedAt: AT,
    });
    await db.insert(sessions).values({
      id: SESS, taskId: TASK, role: "lead", agentType: "codex", executor: "codex@test", cwd: dir,
      cliSessionId: "thread-a", resumeCommand: "codex exec resume thread-a",
      startedAt: AT, turnStartedAt: AT, activeMs: 0,
    });
  } else {
    // 「重启后接回同一段会话」:openLead 的 resuming 分支就是这么复用这一行的。
    await db.update(sessions)
      .set({ cliSessionId: "thread-b", resumeCommand: "codex exec resume thread-b", turnStartedAt: AT, endedAt: null, exitStatus: null })
      .where(eq(sessions.id, SESS));
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, TASK));
  }

  let sent = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const thread = which === "stage" ? "thread-a" : "thread-b";
  async function* events(): AsyncGenerator<AgentEvent> {
    // 进程 B 的调度台收完这一回合就该把待送队列合并送出去;进程 A 没有 turnEnd,
    // 它就是「忙着的时候收到汇报,然后正常收台」。
    if (which === "resume") yield { kind: "turnEnd" };
    await gate;
    yield { kind: "done", exitStatus: 0 };
  }
  attachLead({
    taskId: TASK, sessId: SESS, cliSessionId: thread, agentType: "codex", executorId: null,
    model: null, reasoningEffort: null, cwd: dir,
    handle: {
      sessionId: thread,
      commandLine: `codex exec resume ${thread}`,
      events: events(),
      send: () => { sent++; return true; },
      interrupt: () => {}, dropSession: () => {}, close: () => {}, kill: () => {},
    },
    out: createWriteStream(mdPath, { flags: "a" }),
    busy: true, turnStart: AT, pending: [], notices: [], pendingCredential: null,
    wantedStatus: null, statusTimer: null, retired: false, idleTimer: null, closing: null,
  });

  const deadline = Date.now() + 15_000;
  if (which === "stage") await sendInbound(TASK, REPORT); // 调度台正忙 → 只进待送队列
  else while (sent === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  release();
  while (teamIsLive(TASK) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200)); // 等 .md 的写流真的收口

  writeFileSync(join(dir, `${which}.json`), JSON.stringify({
    sent,
    persisted: readMd().includes(REPORT),
    occurrences: readMd().split(REPORT).length - 1,
    queued: (await pendingInbound(TASK)).length,
  }));
  // Windows 上 sqlite 的文件句柄不放,父进程就删不掉临时目录(EBUSY)。
  try { dbClient.close(); } catch { /* 已经关了 */ }
}
