// 自由工作流的预览段（从 free-workflow.ts 拆出，纯行数拆分）：命令来源、启动、路由。
// 「跑哪条命令」在 preview-command.ts（纯函数，回归 test:preview-command）：项目设置里
// 填过就用那条，没填就按各语言自己的惯例去认，认出恰好一个才自动用。
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { assertBeforeAcceptance } from "./free-workflow.js";
import { acquireFreeWorkflowAction, releaseFreeWorkflowAction } from "./free-workflow-lock.js";
import { handoffBlockReasonById } from "./handoff-guard.js";
import { resolvePreviewCommand } from "./preview-command.js";
import { parsePreviewConfig, previewProxyEnabled, type WorkspacePreviewInput } from "@ash/shared/preview";
import { workspacePreviewDirectory, workspacePreviewInput } from "./preview-workspace.js";
import { isMultiUser } from "./auth/mode.js";
import { previewState } from "./preview-public.js";
import { isTurnClaimed } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { taskWorkspace } from "./task-workspace.js";
import { readPreview, readPreviewLog, isPreviewStarting, startPreview, stopPreview, beginPreviewStart, endPreviewStart, previewStartCanceled, PREVIEW_CANCELED, type PreviewStep } from "./preview.js";
import { rerunGateClosed } from "./rerun-gate.js";

async function startFreePreview(taskId: string, input?: WorkspacePreviewInput) {
  // 拿锁那一步也会因为「任务正在切进 running」而失败（见 rerun-gate.ts），但它只会说一句
  // 「已有操作正在进行」——用户此刻遇到的事其实是任务又开跑了。所以先自己问一次，把话说准。
  if (rerunGateClosed(taskId)) throw new Error("任务正在修改代码，结束后再打开预览");
  const holder = acquireFreeWorkflowAction(taskId);
  if (holder === null) throw new Error("当前已有自由工作流操作正在进行");
  // **可取消从这一行开始。** 下面查任务、查项目、解析/新建工作区全是 await，第一次开预览
  // 时建 worktree 更是要花时间；代号如果等进了 startPreview 才注册，这一整段就是取消不掉的
  // 黑窗口——用户点的取消什么也标不到，只会收到「预览已经不在跑了」，然后这一趟照常把预览
  // 起起来（见 preview.ts 的 beginPreviewStart）。同步注册，中间不能有 await。
  //
  // 取消打不断正卡在建 worktree（或等仓库写锁）上的那一步，所以**动作锁在取消那一刻就放**：
  // 再攥着它，验收和派审会被一个已经作废的启动挡满八分钟。带号码牌地放，只放自己那一次。
  const gen = beginPreviewStart(taskId, () => releaseFreeWorkflowAction(taskId, holder));
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task || task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) {
      throw new Error("当前任务不支持自由预览");
    }
    if (task.archived) throw new Error("归档任务不能打开预览");
    if (task.status === "backlog") throw new Error("任务尚未运行，完成实现后再打开预览");
    if (task.status === "running" || task.status === "queued") throw new Error("任务正在修改代码，结束后再打开预览");
    // 库里那一行可能是**上一秒的**：任务正在切进 running 的那一段（先收旧预览、后写状态）
    // 里，读到的还是 done。那一段结束后不会再收第二次，放行就等于让预览跟正在改代码的
    // agent 共用同一个工作区（见 rerun-gate.ts）。上面那次问的是发车前，这次问的是「读完
    // 任务行之后门才关上」。
    if (rerunGateClosed(taskId)) throw new Error("任务正在修改代码，结束后再打开预览");
    if (isTurnClaimed(taskId)) throw new Error("任务回合正在进行（状态尚未落库），结束后再打开预览");
    assertBeforeAcceptance(task);
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) throw new Error("项目不存在");
    const workspace = input ? { path: await workspacePreviewDirectory(taskId) } : await taskWorkspace(task, project.repoPath);
    // 工作区这一段最长（要建 worktree、可能还在等同仓库的写锁），取消八成落在这儿：
    // 到这个检查点就收摊，别再往下认命令、更别起进程。开跑那道门同理——这一段里任务
    // 完全可能已经开始跑下一轮了。
    if (previewStartCanceled(gen)) throw new Error(PREVIEW_CANCELED);
    if (rerunGateClosed(taskId)) throw new Error("任务正在修改代码，结束后再打开预览");
    const config = input?.config ?? (input?.command ? null : parsePreviewConfig(project.previewConfig ?? null));
    const selected = config?.mode === "services" ? config.services.filter((s) => s.enabled) : undefined;
    const { command, source } = selected
      ? { command: selected.map((s) => s.command).join("\n\n"), source: "configured" }
      : resolvePreviewCommand(workspace.path, input?.command ?? project.previewCommand);
    const proxy = !!input || previewProxyEnabled(config?.proxy, await isMultiUser());
    // 就绪判据只认「端口真的连得上」。**不能**再加一条「日志里说了 ready」：READY_WORDS
    // 那张表（ready / listening / compiled…）是照 Node dev server 的说法写的，Django 印的是
    // 「Starting development server at …」、Go/Rust 印什么全看作者 —— 拿它当必要条件，等于
    // 只有 Node 项目的预览算数，别的语言明明起来了也要干等到超时。地址是这条命令自己印在
    // 日志里的（或它自述的端口，见 preview-log.ts），连得上就是它起来了。
    const step: PreviewStep = {
      id: "free-preview", kind: "preview",
      p: { cmd: command, mode: "frontend", ready: "port", life: "task" },
      fail: null,
    };
    const result = await startPreview(taskId, step, workspace.path, gen, { services: selected, primaryServiceId: config?.primaryServiceId, proxy });
    if (!result.ok) throw new Error(result.reason);
    // **起来了不等于还是我们的。** 从这里到 200 之间还有一个 await（写时间线），用户点的
    // 关闭、重跑回收都可能落在这条缝里：进程被杀、记录被删，而这一趟手里攥着的还是那份旧
    // record。就那么返回，用户会收到一句「预览已打开」外加一个已经死掉的地址（前端拿 200
    // 就 window.open），比直接说没起来还糟。
    //
    // 三样一起认：代号还在（没被取消）、盘上那条记录还是我们这一代、开跑那道门没关上
    // （管的是「记录刚被收、状态还没落库」那条缝）。
    const mine = () => !previewStartCanceled(gen) && readPreview(taskId)?.gen === gen && !rerunGateClosed(taskId);
    if (!mine()) throw new Error(PREVIEW_CANCELED);
    // 预览只是「随手开一眼」：时间线留一行让刷新后仍看得见，但不进「实际工作流」那条
    // 线——开关预览不改变任务本身走到了哪一步。命令是哪儿来的也写上：填过的那条跑错了
    // 要去项目设置改，认出来的那条跑错了是另一回事。
    await appendTaskTimeline(
      taskId,
      `自由工作流预览已打开（${input ? "预览工作区" : source === "configured" ? "项目预览设置" : "自动识别"}：${command}）：${previewState(taskId).url ?? command}`,
    );
    if (!mine()) throw new Error(PREVIEW_CANCELED);
    bus.publish({ type: "task.review", taskId });
    return result.record;
  } finally {
    endPreviewStart(taskId, gen);
    releaseFreeWorkflowAction(taskId, holder);
  }
}

export function mountFreePreviewRoutes(api: Hono): void {
  api.post("/tasks/:id/free-workflow/preview", async (c) => {
    // 打开预览会在任务工作区里跑启动命令——接力出去的「历史存档」不给开(关闭不拦)。
    const handedOff = await handoffBlockReasonById(c.req.param("id"));
    if (handedOff) return c.json({ error: handedOff, handoff: true }, 409);
    try {
      const input = workspacePreviewInput(await c.req.json().catch(() => ({})));
      const record = await startFreePreview(c.req.param("id"), input);
      return c.json(previewState(record.taskId));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  // 预览起没起来、为什么没起来，答案全在这份启动日志里。**它跟 preview.json 不是一回事**：
  // banner 在 spawn 之前就落盘，所以起失败的那一次照样读得到（而那一次恰恰最该看）。
  // 不设 waiting/接力门禁：读日志是只读动作，任务停在哪一步都该看得见。
  api.get("/tasks/:id/free-workflow/preview/log", async (c) => {
    const taskId = c.req.param("id");
    const task = (await db.select({
      workflowMode: tasks.workflowMode, mode: tasks.mode, parentId: tasks.parentId, reviewOf: tasks.reviewOf,
    }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task || task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) {
      return c.json({ error: "当前任务不支持自由预览" }, 409);
    }
    const log = readPreviewLog(taskId, 200_000, c.req.query("service"));
    const record = readPreview(taskId);
    // `running` 在这儿的用处只有一个：告诉界面「这份日志还会不会长」。所以它必须把
    // **正在启动**那一段算进来 —— preview.json 要等就绪才写，而启动可以耗到 120 秒，
    // 那一整段里日志一直在长（Maven 在下依赖、前端在冷编译），正是最该续读的时候。
    // 只看 preview.json 的话，弹窗那句「日志每 2 秒自动续上」在最需要它的时候是假的。
    const running = !!record || isPreviewStarting(taskId);
    const state = previewState(taskId);
    const selectedService = state.services?.find((s) => s.id === c.req.query("service"));
    return c.json({
      text: log?.text ?? "",
      truncated: log?.truncated ?? false,
      updatedAt: log?.updatedAt ?? null,
      exists: log !== null,
      running,
      starting: !record && isPreviewStarting(taskId),
      command: selectedService?.command ?? state.command,
      url: selectedService ? selectedService.url : state.url,
      services: state.services,
    });
  });

  // 关闭预览是**控制类**动作：不设 waiting（提问/续跑）门禁——预览进程占着端口，
  // 任务无论停在哪一步，用户都必须能把它收掉。
  api.delete("/tasks/:id/free-workflow/preview", async (c) => {
    const taskId = c.req.param("id");
    const task = (await db.select({
      workflowMode: tasks.workflowMode, mode: tasks.mode, parentId: tasks.parentId, reviewOf: tasks.reviewOf,
    }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task || task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) {
      return c.json({ error: "当前任务不支持自由预览" }, 409);
    }
    // **不抢那把自由工作流的锁。** 起预览是同步等到就绪的，那把锁会被 POST 一直握到
    // 八分钟之后（装依赖 6 分钟 + 等就绪 2 分钟）；关闭如果也要那把锁，用户在整个启动
    // 期间只会拿到一句 409「当前已有自由工作流操作正在进行」——而这一段恰恰是最需要
    // 「我不等了，收掉」的时候，代码里为它做的那套取消（starting 记录 + 代号 + 杀装
    // 依赖的进程）也就永远走不到。
    //
    // 不加锁是安全的，因为 stopPreview 本身就是按盘上记录做的幂等操作：并发两次关闭，
    // 第二次读不到记录直接返回 false；跟启动并发时，启动那一趟会在下一个检查点发现
    // 自己的代号没了，自己收摊（见 preview.ts 的 abandoned）。
    const stopped = await stopPreview(taskId, "用户关闭了自由工作流预览");
    bus.publish({ type: "task.review", taskId });
    return c.json({ stopped });
  });
}
