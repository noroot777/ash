// 自由工作流的**预览**那一段：打开/关闭只报「当下开没开」、启动期可取消、取消要从路由
// 第一行就管用、「任务又开跑了」与「不许再起预览」是同一道门、起来了也可能已经不是你的、
// 用户自己点的关闭要当场放掉动作锁。
//
// 从 `test-free-workflow.ts` 切出来的理由是**行数**：那份文件 1076 行，远超仓库 700 行上限，
// 而这一段是它里面最大的一块、也是唯一一块需要 FIFO 堵塞 + 真实预览进程 + 真实仓库锁的
// —— `drainFifo` / `killLeftoverPreviews` / `waitFor` 三件装置只被它用，所以整组一起搬过来，
// 切完两边都在上限内。断言一条没改。
// 跑:npm -w server run test:free-workflow-preview
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-free-preview-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * 「把时间线那一笔堵住」用的 FIFO（重跑交错那一段）。
 *
 * 读者要**一直守着**：没有读者的写入会一路挂着，进程就卡在那儿不退出——回归退化时本该
 * 看得见的那句断言会变成「测试跑不完」。而且不能只读一次：第一个写者关掉时读端就 EOF 了，
 * 后面那个写者（退化时那次「预览已打开」）又会重新堵住，所以 end 之后要接着开下一个。
 * 收尾时 stopDrainingFifo 把它拆掉，否则一个永远开着的读端自己就会吊住事件循环。
 */
let stopDrainingFifo: (() => void) | null = null;
function drainFifo(path: string): void {
  let on = true;
  let current: ReturnType<typeof createReadStream> | null = null;
  const open = () => {
    if (!on || !existsSync(path)) return;
    const reader = createReadStream(path);
    current = reader;
    reader.resume();
    reader.on("end", () => { reader.close(); open(); });
    reader.on("error", () => { /* 拆掉读端时会来一发，忽略 */ });
  };
  stopDrainingFifo = () => { on = false; current?.destroy(); stopDrainingFifo = null; };
  open();
}

/**
 * 收尾时把还活着的预览进程收掉。回归退化时那一路会真的把服务起起来，断言炸在它前面，
 * 于是既漏一个监听着端口的孤儿进程，又把事件循环吊住（同上：断言打印了，进程不退）。
 */
function killLeftoverPreviews(runsRoot: string): void {
  if (!existsSync(runsRoot)) return;
  for (const dir of readdirSync(runsRoot)) {
    const file = join(runsRoot, dir, "preview.json");
    if (!existsSync(file)) continue;
    try {
      const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
      if (pid > 0) process.kill(-pid, "SIGKILL");
    } catch { /* 已经走了 */ }
  }
}

/** 等一个条件成真（用在真实路由 + 真实仓库锁那一段：时序靠等，不靠猜固定毫秒）。 */
async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(message);
}

let failure: unknown = null;
try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, projects, reviewerProfiles, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { mountFreeWorkflowRoutes } = await import("../src/free-workflow-routes.js");
  const { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } = await import("../src/free-workflow-lock.js");
  const { prepareWorktree } = await import("../src/git.js");
  const { withRepoLock } = await import("../src/repo-lock.js");
  const { setTaskStatus } = await import("../src/status.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { acceptTask } = await import("../src/task-accept.js");
  await ensureSchema();

  const now = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "test", repoPath: root, apiKeys: null, workflowId: null, createdAt: now });
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Ash Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  await db.insert(projects).values({ id: "p-git", name: "git test", repoPath: repo, apiKeys: null, workflowId: null, createdAt: now });
  await db.insert(agents).values({
    id: "reviewer-executor", name: "codex@test", type: "codex",
    model: "gpt-test", extraArgs: "[]", reasoningEffort: "high", speed: null, providerId: null, isDefault: true,
  });
  await db.insert(reviewerProfiles).values({
    id: "preview-reviewer", name: "Codex logic", agentType: "codex", executorId: "reviewer-executor",
    model: "gpt-review", reasoningEffort: "high", createdAt: now, updatedAt: now,
  });
  const reviewer = { id: "preview-reviewer" };
  await createTasks([{
    id: "free-task", projectId: "p", groupId: null, parentId: null,
    title: "free", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: now, updatedAt: now,
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);

  const api = new Hono();
  mountFreeWorkflowRoutes(api);
  mountTaskRoutes(api);

  // 打开/关闭预览不是工作流里的一步：状态只报「当下开没开」，不再攒开关历史。
  const previewShape = await api.request("/tasks/free-task/free-workflow")
    .then((response) => response.json()) as Record<string, unknown>;
  assert.equal("previewEvents" in previewShape, false, "自由工作流状态不应再暴露预览开关历史");
  assert.equal(
    typeof (previewShape.preview as { running?: unknown } | undefined)?.running,
    "boolean",
    "当下开没开仍要报，否则工具栏那颗按钮没法显示状态",
  );

  // 启动那一段（装依赖 6 分钟 + 等就绪 2 分钟）里，用户必须**从接口上就**关得掉预览。
  // 起预览是同步等到就绪才返回的，那把自由工作流锁会被 POST 一直握着；关闭如果也要这把
  // 锁，整个启动期只会拿到一句 409「当前已有自由工作流操作正在进行」——后端为取消做的那
  // 一整套（starting 记录 + 代号 + 杀装依赖的进程）就永远走不到，用户只能干等八分钟。
  {
    const runsDir = join(root, "runs", "free-task");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "preview.json"), JSON.stringify({
      taskId: "free-task", cmd: "npm run dev", pid: 0, url: null, port: null, life: "task",
      startedAt: new Date().toISOString(), log: join(runsDir, "preview.log"), links: [],
      state: "starting", gen: "in-flight", installPid: null,
    }));
    writeFileSync(join(runsDir, "preview.log"), "$ npm run dev\n");
    // 刷新页面看到的也得是「有东西在跑、可以关掉」，而不是又一颗会撞锁的「打开预览」。
    const startingShape = await api.request("/tasks/free-task/free-workflow")
      .then((response) => response.json()) as { preview: { running: boolean; starting: boolean } };
    assert.equal(startingShape.preview.running, true, "正在启动也该算「在跑」，否则界面上没有任何一处给得出「关掉它」");
    assert.equal(startingShape.preview.starting, true, "得分得清「正在启动」和「已经起来了」：前者没有 url，还能被取消");

    assert.equal(tryAcquireFreeWorkflowAction("free-task"), true, "这一刻模拟的是 POST 还握着锁");
    const canceled = await api.request("/tasks/free-task/free-workflow/preview", { method: "DELETE" });
    releaseFreeWorkflowAction("free-task");
    assert.equal(canceled.status, 200, "启动请求还挂着的时候，关闭预览被锁挡回去了（用户点不到取消）");
    assert.deepEqual(await canceled.json(), { stopped: true }, "关闭应当真的把那条启动记录收掉");
    assert.equal(existsSync(join(runsDir, "preview.json")), false, "记录还在，说明只是嘴上说停了");
  }

  // 取消得从**路由的第一行**就管用。走到 startPreview 之前还有一长串 await：查任务、查
  // 项目、解析或新建工作区（第一次开预览要建 worktree，还可能在等同仓库的写锁）。代号
  // 如果等进了 startPreview 才注册，这一整段就是取消不掉的黑窗口 —— 用户点的取消什么也
  // 标不到，只收到一句「预览已经不在跑了」，然后这一趟照常建工作区、照常起服务、照常
  // 上线，而且此后没有任何一处会再去关它。
  //
  // 这里用真路由复现：仓库锁先被别人握着，POST 就定格在 prepareWorktree 上，取消落在这一段。
  {
    const marker = join(root, "preview-ran.txt");
    const script = join(root, "preview-server.mjs");
    writeFileSync(script, [
      'import { writeFileSync } from "node:fs";',
      'import http from "node:http";',
      `writeFileSync(${JSON.stringify(marker)}, "ran");`,
      'http.createServer((_q, res) => res.end("ok")).listen(Number(process.env.PORT));',
      "",
    ].join("\n"));
    await db.update(projects).set({ previewCommand: `node ${script}` }).where(eq(projects.id, "p-git"));
    await createTasks([{
      id: "pv-cancel-task", projectId: "p-git", groupId: null, parentId: null,
      title: "preview early cancel", body: "test", mode: "single", status: "done",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
      executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
      duet: null, team: null, reportBack: false, scheduleId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      useWorktree: true, worktreeBase: "main", originTaskId: null, workflowMode: "free",
    }]);

    let releaseRepo = () => {};
    let repoLocked = false;
    const repoHeld = withRepoLock(repo, () => new Promise<void>((resolve) => {
      repoLocked = true;
      releaseRepo = resolve;
    }));
    // 锁真的到手了再发 POST，否则它可能抢在前面自己拿到锁、根本不会停在工作区那一步。
    await waitFor(() => repoLocked, "仓库锁没拿到，这一段就不是「工作区准备中」了");
    const post = api.request("/tasks/pv-cancel-task/free-workflow/preview", { method: "POST" });
    // 界面在这一段就该看得到「正在启动、可以取消」——它读的正是这次登记下来的代号。
    await waitFor(async () => {
      const snapshot = await api.request("/tasks/pv-cancel-task/free-workflow")
        .then((response) => response.json()) as { preview: { starting: boolean } };
      return snapshot.preview.starting;
    }, "工作区还在准备时，快照里看不出「正在启动」——那一段就没有任何入口能取消");
    assert.equal(
      existsSync(join(root, "runs", "pv-cancel-task", "preview.json")), false,
      "这一刻盘上本来就还没有记录（正是老实现取消不掉的原因）",
    );

    const stop = await api.request("/tasks/pv-cancel-task/free-workflow/preview", { method: "DELETE" });
    assert.equal(stop.status, 200, "启动请求还卡在工作区准备时，关闭被挡回去了");
    assert.deepEqual(await stop.json(), { stopped: true }, "工作区还在准备时点的取消，接口却说没东西可停");

    // **取消要当场收口。** 打不断那次正卡在建 worktree 上的调用，可对外的那几句话不能跟着
    // 一起拖到它回来：仓库锁这时还握在别人手里，POST 一步都没动。
    {
      const stuck = await api.request("/tasks/pv-cancel-task/free-workflow")
        .then((response) => response.json()) as { preview: { running: boolean; starting: boolean } };
      assert.equal(stuck.preview.starting, false, "已经取消了，快照还说它正在启动（刷新后又变回「关闭预览」）");
      assert.equal(stuck.preview.running, false, "已经取消了，快照还说预览在跑");
      const again = await api.request("/tasks/pv-cancel-task/free-workflow/preview", { method: "DELETE" });
      assert.deepEqual(
        await again.json(), { stopped: false },
        "同一次启动被反复「停到」：每点一次就再记一条「预览启动已取消」",
      );
      // 那把自由工作流动作锁也得当场放掉，否则验收、派审要陪着这次作废的启动干等八分钟。
      assert.equal(
        tryAcquireFreeWorkflowAction("pv-cancel-task"), true,
        "取消之后动作锁还攥在那次启动手里，验收/派审全被 409 挡住",
      );
      releaseFreeWorkflowAction("pv-cancel-task");
    }

    releaseRepo();
    await repoHeld;
    const response = await post;
    assert.equal(response.status, 409, "取消之后这一趟还是把预览起起来了");
    assert.match(
      ((await response.json()) as { error: string }).error, /取消/,
      "起预览这一路失败了，却没说清是被取消的",
    );
    assert.equal(existsSync(marker), false, "取消之后预览命令还是跑起来了（没人再去关它）");
    assert.equal(
      existsSync(join(root, "runs", "pv-cancel-task", "preview.json")), false,
      "取消之后仍然写出了启动记录",
    );
    assert.equal(
      existsSync(join(root, "runs", "pv-cancel-task", "preview.log")), false,
      "取消之后仍然走进了 runPreview（日志头都写出来了）",
    );
  }

  // 「任务又开跑了」和「不许再起预览」必须是**同一道门**。收旧预览和把状态写成 running 是
  // 两步、中间隔着 await；起预览那一路只看库里那一行，在这条缝里读到的还是 done，于是一路
  // 放行——收预览那一下已经过去了，不会再来第二次。结果是任务正在改下一版代码，上一版的
  // 预览却在同一个工作区里跑着：用户对着旧页面验新改动，dev server 的产物还跟 agent 的写入
  // 撞在一起。
  {
    const rerunId = "rerun-race-task";
    const marker2 = join(root, "preview-ran.txt"); // 预览命令跑起来就会写它（见上一段那个脚本）
    await createTasks([{
      id: rerunId, projectId: "p-git", groupId: null, parentId: null,
      title: "preview rerun race", body: "test", mode: "single", status: "done",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
      executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
      duet: null, team: null, reportBack: false, scheduleId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      useWorktree: true, worktreeBase: "main", originTaskId: null, workflowMode: "free",
    }]);

    // ① 先钉住「POST 已经读过任务行（那时还是 done），随后任务开跑」这条时序：仓库锁把
    //    POST 定格在工作区准备上，中间跑完一次真实的 setTaskStatus(running)。
    let releaseRepo2 = () => {};
    let repoLocked2 = false;
    const repoHeld2 = withRepoLock(repo, () => new Promise<void>((resolve) => {
      repoLocked2 = true;
      releaseRepo2 = resolve;
    }));
    await waitFor(() => repoLocked2, "仓库锁没拿到");
    const racingPost = api.request(`/tasks/${rerunId}/free-workflow/preview`, { method: "POST" });
    await waitFor(async () => {
      const snapshot = await api.request(`/tasks/${rerunId}/free-workflow`)
        .then((response) => response.json()) as { preview: { starting: boolean } };
      return snapshot.preview.starting;
    }, "POST 还没走到工作区准备那一步");
    await setTaskStatus(rerunId, "running");
    releaseRepo2();
    await repoHeld2;
    const racing = await racingPost;
    assert.equal(racing.status, 409, "任务已经开跑了，那趟在途的启动还是把预览起了起来");
    assert.match(
      ((await racing.json()) as { error: string }).error, /取消/,
      "挡是挡住了，但不是因为「任务开跑收掉了这一趟」——别让别的错误替它交差",
    );
    assert.equal(
      existsSync(join(root, "runs", rerunId, "preview.json")), false,
      "任务开跑之后仍然留下了预览记录",
    );

    // ② 再钉住那条缝本身：旧预览已经收掉、状态还没落库时发起的新 POST 不能放行。
    //    用 FIFO 把回收里那次时间线写入卡住，窗口就成了确定的。
    const sessionId = "rerun-race-session";
    await db.insert(sessions).values({
      id: sessionId, taskId: rerunId, role: "lead", agentType: "codex",
      executor: "codex@test", startedAt: new Date().toISOString(),
    });
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, rerunId));
    const fifo = sessionTranscriptPath(rerunId, sessionId);
    mkdirSync(dirname(fifo), { recursive: true });
    rmSync(fifo, { force: true });
    execFileSync("mkfifo", [fifo]);
    const runsDir = join(root, "runs", rerunId);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "preview.json"), JSON.stringify({
      taskId: rerunId, cmd: "npm run dev", pid: 0, url: "http://localhost:1/", port: 1, life: "task",
      startedAt: new Date().toISOString(), log: join(runsDir, "preview.log"), links: [],
      state: "ready", gen: "old-gen", installPid: null,
    }));

    const flipping = setTaskStatus(rerunId, "running");
    // 记录已经被收掉、时间线那一笔还堵在 FIFO 上 —— 正是那条缝。
    await waitFor(() => !existsSync(join(runsDir, "preview.json")), "回收还没开始");
    const midway = (await db.select().from(tasks).where(eq(tasks.id, rerunId))).at(0);
    assert.equal(midway?.status, "done", "这一刻库里本来就还是旧状态（正是这条缝的成因）");

    // **同一条缝里，终局动作也不能放行。** 重跑取消在途预览时会顺手把动作锁放掉（那是对的，
    // 否则验收/派审要陪一次作废的启动干等八分钟），可这一刻库里还写着 done —— 空出来的锁加
    // 一行过期的状态，正好够验收挤进来，把一个下一秒就要开跑的任务点成 accepted。
    //
    // 这两发要**在窗口里当场跑完再收结果**：放到放开 FIFO 之后去 await，退化的那一路会读到
    // 已经落库的 running，被别的挡板顺手拦下，这条断言就永远报不出真问题（实测：退化版给出
    // 的是 task_in_flight）。也必须排在下面那发预览 POST **之前** —— 没有这道门的话，那发
    // POST 自己就把动作锁攥走了，验收会因为「已有操作正在进行」被拦下，同样是假通过。
    // 先把会话删掉，这两发各自那笔时间线就不会再堵在同一条 FIFO 上；回收那一笔早就把流开
    // 着卡在那儿了，窗口不受影响。
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    const midAccept = await acceptTask(rerunId).then(
      (result) => result,
      (err: unknown) => ({ accepted: false as const, reason: `threw: ${String(err)}` }),
    );
    assert.equal(midAccept.accepted, false, "任务正在切进 running，验收却成功了（accepted + running 就是这么来的）");
    if (!midAccept.accepted) {
      assert.equal(
        midAccept.reason, "free_workflow_action_in_progress",
        "验收是被挡住了，但不是因为这个任务正在开跑 —— 别让别的理由替它交差",
      );
    }
    const midReview = await api.request(`/tasks/${rerunId}/free-workflow/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1 }),
    });
    assert.equal(midReview.status, 409, "任务正在切进 running，派审却放行了");

    // 这一发不 await：挡不住的话它会一路起到底，而那时它自己的时间线也要写进同一条 FIFO。
    const midPosting = api.request(`/tasks/${rerunId}/free-workflow/preview`, { method: "POST" });
    // 先守住 FIFO 再收结果：回收那一笔写完、状态落库，退化的那一路也走得完 —— 断言才有得报。
    drainFifo(fifo);
    await flipping;
    const midPost = await midPosting;
    assert.equal(midPost.status, 409, "任务正在切进 running，这一刻还能把预览起起来");
    assert.match(
      ((await midPost.json()) as { error: string }).error, /任务正在修改代码/,
      "挡是挡住了，但没说清是因为任务正在改代码",
    );
    stopDrainingFifo?.();
    const after = (await db.select().from(tasks).where(eq(tasks.id, rerunId))).at(0);
    assert.equal(after?.status, "running", "状态最终没落成 running");
    assert.notEqual(after?.stage, "accepted", "任务被点成了已验收，可它下一秒就开跑了（界面锁死操作，执行器还在改它）");
    assert.equal(
      existsSync(join(root, "runs", rerunId, "preview.json")), false,
      "那条缝里发起的预览最终还是起来了",
    );
    assert.equal(existsSync(marker2), false, "那条缝里发起的预览把命令跑起来了");
  }

  // 「起来了」不等于「还是你的」：`startPreview` 返回成功之后，路由还要写一笔时间线才应答，
  // 重跑回收完全可能落在这条缝里 —— 进程被杀、记录被删、任务已经 running，而这一趟手里攥
  // 着的还是那份旧 record。就那么回 200，前端拿 200 就通知「预览已打开」并 window.open，
  // 用户被弹到一个已经被收掉的地址上，比直接说没起来还糟。
  {
    const tailId = "tail-race-task";
    await createTasks([{
      id: tailId, projectId: "p-git", groupId: null, parentId: null,
      title: "preview tail race", body: "test", mode: "single", status: "done",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
      executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
      duet: null, team: null, reportBack: false, scheduleId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
    }]);
    const tailSession = "tail-race-session";
    await db.insert(sessions).values({
      id: tailSession, taskId: tailId, role: "lead", agentType: "codex",
      executor: "codex@test", startedAt: new Date().toISOString(),
    });
    // 时间线那一笔写进 FIFO，这一趟就定格在成功尾段上 —— 窗口是确定的，不靠抢时序。
    const tailFifo = sessionTranscriptPath(tailId, tailSession);
    mkdirSync(dirname(tailFifo), { recursive: true });
    rmSync(tailFifo, { force: true });
    execFileSync("mkfifo", [tailFifo]);

    const tailRecord = join(root, "runs", tailId, "preview.json");
    const tailPosting = api.request(`/tasks/${tailId}/free-workflow/preview`, { method: "POST" });
    await waitFor(() => {
      if (!existsSync(tailRecord)) return false;
      return (JSON.parse(readFileSync(tailRecord, "utf8")) as { state: string }).state === "ready";
    }, "预览没能起来，这一段就不是「已就绪、只差应答」了", 90_000);
    const readyRecord = JSON.parse(readFileSync(tailRecord, "utf8")) as { pid: number };
    assert.ok(readyRecord.pid > 0, "就绪记录里没有进程号，后面没法验证进程有没有被收掉");

    // 会话删掉，重跑自己那笔回收时间线就不会跟着堵在同一条 FIFO 上（堵住的只剩这一趟）。
    await db.delete(sessions).where(eq(sessions.id, tailSession));
    await setTaskStatus(tailId, "running");
    assert.equal(existsSync(tailRecord), false, "重跑没把已就绪的预览记录收掉");

    drainFifo(tailFifo);
    const tailPost = await tailPosting;
    assert.notEqual(tailPost.status, 200, "预览已经被重跑收掉了，这一趟还是回了 200（前端照着它 window.open 一个死地址）");
    assert.equal(tailPost.status, 409);
    assert.match(
      ((await tailPost.json()) as { error: string }).error, /取消/,
      "挡是挡住了，但没说清这一趟的成果是被人收走了",
    );
    stopDrainingFifo?.();
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await waitFor(() => !alive(readyRecord.pid), "预览进程还活着：记录没了、任务在跑，端口却还占着");
    const tailTask = (await db.select().from(tasks).where(eq(tasks.id, tailId))).at(0);
    assert.equal(tailTask?.status, "running", "状态最终没落成 running");
  }

  // 同一条尾巴上，**用户自己点的关闭**也得当场收干净。预览起来了、路由还在写那笔时间线，
  // 这一刻的关闭在盘上完全生效（进程杀掉、记录删掉、刷新后也确实没预览），可代号如果已经
  // 被内层交接时撤掉，挂在它上面的「提前放动作锁」就再也不会响：用户看到的是关闭成功，
  // 验收/派审却还被一个已经作废的请求的锁挡着，直到它自己从时间线那一步醒过来 —— 那一步
  // 是真的文件 I/O，磁盘或挂载出问题时可以拖到没边。
  {
    const cancelId = "tail-cancel-task";
    await createTasks([{
      id: cancelId, projectId: "p-git", groupId: null, parentId: null,
      title: "preview tail cancel", body: "test", mode: "single", status: "done",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
      executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
      duet: null, team: null, reportBack: false, scheduleId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
    }]);
    const cancelSession = "tail-cancel-session";
    await db.insert(sessions).values({
      id: cancelSession, taskId: cancelId, role: "lead", agentType: "codex",
      executor: "codex@test", startedAt: new Date().toISOString(),
    });
    const cancelFifo = sessionTranscriptPath(cancelId, cancelSession);
    mkdirSync(dirname(cancelFifo), { recursive: true });
    rmSync(cancelFifo, { force: true });
    execFileSync("mkfifo", [cancelFifo]);

    const cancelRecord = join(root, "runs", cancelId, "preview.json");
    const cancelPosting = api.request(`/tasks/${cancelId}/free-workflow/preview`, { method: "POST" });
    await waitFor(() => {
      if (!existsSync(cancelRecord)) return false;
      return (JSON.parse(readFileSync(cancelRecord, "utf8")) as { state: string }).state === "ready";
    }, "预览没能起来，这一段就不是「已就绪、只差应答」了", 90_000);
    const cancelPid = (JSON.parse(readFileSync(cancelRecord, "utf8")) as { pid: number }).pid;
    assert.ok(cancelPid > 0, "就绪记录里没有进程号，后面没法验证进程有没有被收掉");

    // 会话删掉，关闭自己那笔时间线就不会跟着堵在同一条 FIFO 上（堵住的只剩这一趟 POST）。
    await db.delete(sessions).where(eq(sessions.id, cancelSession));
    const closed = await api.request(`/tasks/${cancelId}/free-workflow/preview`, { method: "DELETE" });
    assert.equal(closed.status, 200, "预览已经起来了，关闭却被挡回去了");
    assert.deepEqual(await closed.json(), { stopped: true }, "关闭没真的把它收掉");
    const closedShape = await api.request(`/tasks/${cancelId}/free-workflow`)
      .then((response) => response.json()) as { preview: { running: boolean; starting: boolean } };
    assert.equal(closedShape.preview.running, false, "关掉了，快照还说预览在跑");
    assert.equal(closedShape.preview.starting, false, "关掉了，快照还说它正在启动");
    const closedAgain = await api.request(`/tasks/${cancelId}/free-workflow/preview`, { method: "DELETE" });
    assert.deepEqual(await closedAgain.json(), { stopped: false }, "同一次预览被反复「停到」");
    // 这条是本段的要害：关闭**当场**就得把动作锁放掉，不能让验收/派审陪那个已经作废的
    // 请求等到它写完时间线。
    assert.equal(
      tryAcquireFreeWorkflowAction(cancelId), true,
      "关闭已经生效、快照也说没在跑，动作锁却还攥在那次作废的启动手里（验收/派审全被 409 挡住）",
    );
    releaseFreeWorkflowAction(cancelId);

    drainFifo(cancelFifo);
    const cancelPost = await cancelPosting;
    assert.equal(cancelPost.status, 409, "关掉之后这一趟还是宣告「预览已打开」");
    assert.match(
      ((await cancelPost.json()) as { error: string }).error, /取消/,
      "挡是挡住了，但没说清这一趟是被关掉的",
    );
    stopDrainingFifo?.();
    const stillAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await waitFor(() => !stillAlive(cancelPid), "关掉之后预览进程还活着，端口还占着");
  }

  console.log("✓ 预览只报当下开没开，启动期可取消，取消从路由第一行生效");
  console.log("✓ 任务重开与起预览是同一道门；起来了也可能已不是你的；关闭当场放锁");
} catch (error) {
  console.error(error);
  failure = error;
} finally {
  stopDrainingFifo?.();
  killLeftoverPreviews(join(root, "runs"));
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
  // 断言炸在窗口里的时候，还有写者堵在 FIFO 的 `open()` 上 —— 那是 libuv 线程池里的一根
  // 线程，**连 process.exit 都回不来**。结论已经在屏幕上了，剩下的只有退场，所以直接自杀。
  if (failure) process.kill(process.pid, "SIGKILL");
}
