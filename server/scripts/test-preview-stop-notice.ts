// 预览子进程的那条看门狗（preview-start.ts 的 child.on("exit")）必须分得清两件事：
// 服务自己死了，和**我们把它杀了**。它们在 exit 事件里长得一模一样，而记录要等进程确认
// 退出之后才归档 —— 于是「用户点关闭」那一下正落在「记录还挂着 ready」的窗口里，被读成
// 「预览进程已自行退出」：用户主动关掉的预览，会话里多出一条红色的「预览异常」，归档记录
// 还被写成 failed（日志弹窗上那个服务显示「失败」）。
//
// 两头都钉住：主动关闭必须安静收场，服务真的自行退出必须照旧报异常。只钉一头，下次很容易
// 修成一边倒。
// Run: npm -w server run test:preview-stop-notice
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-preview-stop-notice-"));
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_DEPS_DIR = join(root, "deps");
process.env.ASH_DB = join(root, "ash.db");

const { startPreview, stopPreview } = await import("../src/preview.js");
const { lastPreview } = await import("../src/preview-store.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");
await (await import("../src/db/index.js")).ensureSchema();
const { db } = await import("../src/db/index.js");
const { sessions } = await import("../src/db/schema.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cwd = join(root, "work");
mkdirSync(cwd, { recursive: true });

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已经收干净 */ }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { /* 已经收干净 */ }
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(100);
  }
  assert.fail(message);
}

// 时间线是写进会话记录的，没有会话就没地方写（appendTaskTimeline 返回 false）。
async function seedSession(taskId: string): Promise<string> {
  const at = new Date().toISOString();
  const id = `${taskId}-session`;
  await db.insert(sessions).values({
    id, taskId, role: "single", agentType: "claude", executor: "claude", startedAt: at, endedAt: at,
  });
  return id;
}

const timeline = (taskId: string, sessionId: string): string => {
  try { return readFileSync(sessionTranscriptPath(taskId, sessionId), "utf8"); } catch { return ""; }
};

const step = (cmd: string) => ({ id: "preview", kind: "preview", p: { cmd, mode: "frontend", ready: "port", life: "task" } });

try {
  // ① 服务**真的自己退出**：这条路必须照旧报异常，否则后面那条「主动关闭要安静」就可能
  //    是靠把整条看门狗废掉换来的。先跑它，也顺带证明这一轮里看门狗是活的。
  {
    const taskId = "self-exit-task";
    const session = await seedSession(taskId);
    const cmd = "node -e \"const s=require('http').createServer((q,r)=>r.end('bye'))"
      + ".listen(process.env.PORT);setTimeout(()=>process.exit(0),800)\"";
    const result = await startPreview(taskId, step(cmd) as never, cwd);
    assert.ok(result.ok, `这一例的前提是它先真的起来：${result.ok ? "" : result.reason}`);
    await waitFor(() => !isAlive(result.record.pid), "服务没有自行退出");
    await waitFor(() => /预览异常/.test(timeline(taskId, session)), "服务自行退出了，时间线上却一个字没有");
    assert.match(timeline(taskId, session), /自行退出/, "报的异常得说清楚它是自己退的");
    assert.equal(lastPreview(taskId)?.services?.[0]?.status, "failed", "自行退出的归档记录应当是 failed");
  }

  // ② 用户主动关闭：杀进程那一下同样会触发看门狗，但它是**我们下的手**。时间线上只该留下
  //    「预览已回收（用户关闭了…）」这一句，归档记录也得写成 stopped —— 界面上那个服务
  //    因此显示「已停止」而不是红色的「失败」。
  {
    const taskId = "user-stop-task";
    const session = await seedSession(taskId);
    const cmd = "node -e \"require('http').createServer((q,r)=>r.end('ok')).listen(process.env.PORT)\"";
    const result = await startPreview(taskId, step(cmd) as never, cwd);
    assert.ok(result.ok, `这一例的前提是它先真的起来：${result.ok ? "" : result.reason}`);
    try {
      assert.equal(await stopPreview(taskId, "用户关闭了自由工作流预览"), true, "主动关闭没停到东西");
      // stopPreview 是等到进程确认退出才返回的（退出事件此刻已经排在队列里），再放一手让它跑完。
      await sleep(300);
      const text = timeline(taskId, session);
      assert.match(text, /预览已回收（用户关闭了自由工作流预览）/, "主动关闭必须在时间线上留一句");
      assert.doesNotMatch(text, /预览异常/, "用户主动关掉的预览被报成了异常");
      assert.doesNotMatch(text, /自行退出/, "我们自己杀的进程被说成了「自行退出」");
      assert.equal(lastPreview(taskId)?.services?.[0]?.status, "stopped", "主动关闭的归档记录不该是 failed");
    } finally {
      killGroup(result.record.pid);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("preview stop notice tests passed");
