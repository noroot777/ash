// 这一轮到底产出了新一版没有 —— 用工作目录前后两张「照片」判，不问模型。
//
// 要解决的病：任务验收完（甚至已经合并、删了分支）之后，用户再发一条消息让 agent
// 改点东西。改完 agent 亲口确认完成，线接着往下走 —— 可这条线身上记的是**上一版**的
// 成绩：那一站验证已经跑满轮数（`verify_station_rounds`），于是 `verifyStationAction`
// 判 skip 整站略过；「等我点头」那道关口看见 stage 还是 accepted/merged 也直接放行。
// 结果就是**没人验过的新代码被自动合并、分支被删**，而用户以为它还会走一遍流程。
//
// 判据只有一条，没有模型参与：agent 起跑前拍一张照，结算时再拍一张。
// 照片 = sha256(`git rev-parse HEAD` + `git diff HEAD` + `git ls-files --others`)。
// 三样都要：只看 HEAD 会漏「改了但没提交」，只看文件名单会漏「一个已改的文件又被改一次」。
//
//   照片不一样                 → 清账：游标搬回第一站、验证轮数归零、stage 清空
//   照片一样                   → 线一个字节不动（纯询问不该重置任何东西），并把回合开头
//                                摘掉的「已验收/已合并」牌子原样挂回去 —— 那是白摘的
//   照片一样 + 屋子是这一轮新建的空壳 → 拆屋（见 discardEmptyShell）
//   照片取不到（非 git / 命令挂了） → 保守当作「变了」
//
// **清账只看照片，不看这一轮 agent 确认没确认完成**（2026-08-07 改）。这两件事被混过
// 一次：确认完成决定的是「这一轮的成绩算不算、线要不要接着往下走」，清账清的是「上一版
// 的成绩还算不算数」——而后者只取决于工作目录里的字节变没变。混在一起漏掉的正是最常见
// 的那条路：**续聊回合本来就不要求确认完成**（`followUpFrom` 会把它回落到原终态），于是
// 用户发一句「这块再改改」、agent 改完提交、没调 complete_task，账就一个字没清。上一版
// 那道「等我点头」仍记成已放行、那一站验证仍记着已验满轮，游标还停在验证站上：接下来
// 谁点一下「再验一轮」或「人工强制通过」，没人验过、也没经过关口的新代码就被合并了
// （实测：任务 1rojF5Tjau91）。原先那条「没确认就什么都不动」的理由是「一次中断不该把
// 上一版的成绩抹了」——可照片一样时本来就不会动，会被抹的一律是**真改了字节**的中断，
// 那本来就该抹。
//
// 两个刻意的例外：
//   ① **只给真人消息拍照**（`!opts.system`，与 `followUpFrom` / `reopenAcceptedStage`
//      同一条口径）。系统续跑、队列推进、验证打回后叫 agent 修 —— 那些轮次改代码是
//      本分，清账会把正在进行的流程打回起点。
//   ② **stage 是 verify_failed 时不清账**（用户 2026-08-06 拍板）。验证没过、用户插进来
//      指点两句，那还是**同一版在修**，不是新开一版；清零的话轮数上限就形同虚设 ——
//      每被打回一次就有人说句话，可以无限重验。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { STAGE_LABELS } from "@harness/shared";
import { firstAnchor } from "@harness/shared/workflow-policy";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";
import { clearTaskStage, restoreTaskStage } from "./task-stage.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";
import { setWorkflowAt } from "./workflow-advance.js";
import { taskWorkflowDef } from "./workflows.js";
import { discardTaskWorkspace } from "./workspace-cleanup.js";

const exec = promisify(execFile);

interface TurnBaseline {
  cwd: string;
  /** null = 当时就没拍成（非 git 目录等）。比对时按「变了」处理。 */
  fingerprint: string | null;
  /** 这个工作目录是不是这一轮才凭空建出来的空壳（分支和目录都没了才会是 true）。 */
  fresh: boolean;
  /**
   * 回合开头 `reopenAcceptedStage` 摘掉的那块牌子（没摘则 null/缺省）。摘牌必须立刻发生，
   * 可那时还不知道这一轮会不会真改东西；照片一样就说明白摘了，结算时按这个值挂回去。
   */
  stage?: "accepted" | "merged" | null;
  at: string;
}

const baselinePath = (taskId: string) => join(RUNS_DIR, taskId, "turn-baseline.json");

/**
 * 给工作目录拍一张照。取不到就返回 null —— 调用方一律按「变了」处理，
 * 因为「不知道有没有变」和「确实变了」的正确应对是同一个：让它重走流程。
 */
async function fingerprint(cwd: string): Promise<string | null> {
  if (!cwd || !existsSync(cwd)) return null;
  try {
    // 三段各自先写长度再写内容：不用分隔符，也就不会有「换个位置切开能拼出同样字节流」
    // 的歧义。**别改回 join(分隔符)** —— 上一版用了个原始 NUL 字节当分隔符，整个文件
    // 被 git 当成二进制，diff 显示 "Binary files differ"，这块核心逻辑没法审阅。
    const hash = createHash("sha256");
    for (const args of [
      ["rev-parse", "HEAD"],
      ["diff", "HEAD"],
      ["ls-files", "--others", "--exclude-standard"],
    ]) {
      // diff 可以很大；默认 1MB 的 maxBuffer 会直接抛，那样每次都判成「变了」。
      const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
      hash.update(String(stdout.length));
      hash.update("\n");
      hash.update(stdout);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/**
 * 起跑前的第一张照。落磁盘而不是内存：`data/runs/<taskId>/turn-baseline.json`
 * 活得过 server 重启，重启后接管（reattach）那一路照样能比对上。
 */
export async function recordTurnBaseline(
  taskId: string,
  cwd: string,
  fresh: boolean,
  reopenedStage: "accepted" | "merged" | null = null,
): Promise<void> {
  try {
    const snapshot: TurnBaseline = {
      cwd,
      fingerprint: await fingerprint(cwd),
      fresh,
      stage: reopenedStage,
      at: now(),
    };
    mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
    writeFileSync(baselinePath(taskId), JSON.stringify(snapshot));
  } catch (error) {
    // 拍照失败不该拖垮起跑：没有基线 = 这一轮不做任何判断，退回改动前的行为。
    console.warn(`[harness] failed to record turn baseline for ${taskId}:`, error);
  }
}

/** 读一次就删：一张基线只服务一个回合，留着会让下一轮拿旧照片比。 */
function takeTurnBaseline(taskId: string): TurnBaseline | null {
  const path = baselinePath(taskId);
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as TurnBaseline;
    rmSync(path, { force: true });
    return typeof raw?.cwd === "string" ? raw : null;
  } catch {
    rmSync(path, { force: true });
    return null;
  }
}

const RESET_NOTE =
  "这一轮产出了新的改动，之前那一版的验证与验收记录已清空，这条线从头再走一遍（上一版验过了，不能替这一版放行）。";

/** 清了账、线却不会自己往下走的那一档，得把「停在哪、怎么让它继续」说出来。 */
const RESET_STALLED_NOTE =
  "这一轮没有确认完成，所以线就停在「让 AI 干活」这一站，不会自己往下走"
  + "——再回一句让它把这一版确认完成，后面的站（预览 / 等我点头 / 验证）就会照常接着跑。";

/**
 * 清账：把这条线退回起点，让新改动重新过一遍验证和验收。
 *
 * 三样东西一起清，少一样都还能让新代码溜过去：游标（`workflow_at`）搬回「让 AI 干活」
 * 那一站、这一站验过几轮（`verify_station_rounds` + `review_step`）归零、验收阶段
 * （`stage`）清空。**游标要搬回 run 站的 id，不能清成 null** —— 前端在没有游标时会按
 * status 猜位置（`web-next/src/workflow/workflowModel.ts` 的 `resolveCursor`：done 且
 * 无游标 → 落在 run 之后那一站），清成 null 反而显示成「已经走过第一站了」。
 *
 * `willAdvance` **只管那行时间线多不多一句**，不参与清不清的判断（判据只有照片）：
 * 这一轮确认完成了，紧接着 `afterSettlement` 就会把线推下去，用户看得见它在走；没确认
 * 的话线就停在起点，不说一句，用户只会看着一个「已完成」的任务停在第一站发懵。
 */
async function resetWorkflowLedger(taskId: string, willAdvance: boolean): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return;
  // 验证没过正在修 —— 同一版的事，账不能清（否则轮数上限形同虚设）。
  if (task.stage === "verify_failed") return;
  const runId = firstAnchor(taskWorkflowDef(task.workflow), "run")?.id ?? null;
  const stale =
    !!task.stage ||
    (task.verifyStationRounds ?? 0) > 0 ||
    !!task.reviewStep ||
    (!!task.workflowAt && task.workflowAt !== runId);
  if (!stale) return; // 账本本来就是空的，别写一行没信息量的时间线
  const note = willAdvance || !runId ? RESET_NOTE : `${RESET_NOTE}${RESET_STALLED_NOTE}`;
  // clearTaskStage 顺带广播 task.stage 并写时间线；没有 stage 可清时自己补那一行。
  if (task.stage) await clearTaskStage(taskId, note);
  else await appendTaskTimeline(taskId, note);
  await db
    .update(tasks)
    .set({ verifyStationRounds: 0, reviewStep: null, updatedAt: now() })
    .where(eq(tasks.id, taskId));
  if (runId && task.workflowAt !== runId) await setWorkflowAt(taskId, runId); // 广播 task.updated
}

/**
 * 拆屋：这一轮为了接住一句话临时建的空壳工作目录，agent 一个字都没改，删掉。
 *
 * 不删的话它就永远留在那儿了 —— 清理只发生在「验收通过」那一刻，而这个任务早已验收过，
 * 不会再验收第二次。用户在界面上看不见它，只能自己记得去 git 里收拾。
 * 只在 `fresh`（目录和分支都没了、`-b` 现建的空壳）时拆；恢复出来的旧 worktree 里
 * 有真东西，一律不碰。不带 force，让 git 自己的安全检查当最后一道保险。
 */
async function discardEmptyShell(taskId: string): Promise<void> {
  const task = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return;
  const project = (await db
    .select({ repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, task.projectId))).at(0);
  if (!project) return;
  const out = await discardTaskWorkspace(project.repoPath, taskId, { worktree: true, branch: true });
  if (!out.worktreeRemoved && !out.branchDeleted) return; // 没删成就别吭声（多半是里面还有东西）
  await appendTaskTimeline(
    taskId,
    `这一轮没有产出任何改动，为它临时重建的工作目录${out.branchDeleted ? `与空分支 ${out.branch}` : ""}已清理。`,
  );
}

/**
 * 结算时拍第二张照并作出决定。
 *
 * **必须排在 `afterSettlement` 之前**：那一步会拿着游标把这条线往下推
 * （`handleTaskSettlement → advanceWorkflowFrom(settleFrom(...))`），账晚清一步就来不及了。
 *
 * `confirmedDone` **只用来挑那行时间线的措辞**（清完之后线会不会自己往下走）。它绝不能
 * 再回到「清不清账」的判断里 —— 那正是这次要修的病，理由见文件头。
 */
export async function reconcileTurnBaseline(taskId: string, confirmedDone: boolean): Promise<void> {
  const base = takeTurnBaseline(taskId);
  if (!base) return; // 这一轮没拍过照（系统续跑、验证轮、老任务）→ 维持原行为
  try {
    const after = await fingerprint(base.cwd);
    const changed = base.fingerprint === null || after === null || after !== base.fingerprint;
    if (changed) {
      // 确认没确认完成都要清：账本记的是上一版的成绩，而这一版的字节已经不一样了。
      await resetWorkflowLedger(taskId, confirmedDone);
      return;
    }
    // 一个字节没变 = 纯询问。回合开头摘掉的「已验收/已合并」牌子是白摘的，挂回去 ——
    // 不然用户只是问一句「这段为什么这么做」，任务就从已验收掉回进行中，还得再点一次验收。
    if (base.stage) {
      await restoreTaskStage(
        taskId,
        base.stage,
        `这一轮没有产出任何改动，验收阶段放回「${STAGE_LABELS[base.stage]}」——纯询问不用重新验收一次。`,
      );
    }
    if (base.fresh) await discardEmptyShell(taskId);
  } catch (error) {
    console.warn(`[harness] failed to reconcile turn baseline for ${taskId}:`, error);
  }
}
