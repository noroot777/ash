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
//   照片不一样                 → 账保持清空（清账在回合开头就做了，见下）
//   照片一样                   → 把开头清掉的账原样放回，连同摘掉的「已验收/已合并」
//                                牌子 —— 纯询问不该重置任何东西，那些都是白清的
//   照片一样 + 屋子是这一轮新建的空壳 → 拆屋（见 discardEmptyShell）
//   照片取不到（非 git / 命令挂了） → 保守当作「变了」
//
// **清账在回合开头就做，不等结算**（2026-08-07 第二次改）。一开始它排在结算那一步，
// 判据本身没错，可一个回合要跑几十分钟 —— 这整段时间账本还记着上一版的成绩，于是
// 线路图上「等我点头」写着 ✓已过、游标停在「自动验证」，而 agent 正在底下重做这一版。
// 显示错只是表象：游标落在 verify 站，那一站的「再验一轮」「人工强制通过」两颗按钮
// 此刻就是可点的，点下去 `advanceWorkflowFrom` 会直接跑完 accept 段——**把一个正在被
// 改写的分支合并掉、再删掉 agent 脚下的 worktree**。所以「上一版的成绩作废」必须在
// 收到指令那一刻就生效，而不是等干完才追认（实测：任务 nInnSY6WiMoS）。
//
// 反过来那一档（纯询问）用「先清、照片一样再放回」补偿，跟隔壁 `reopenAcceptedStage`
// 摘牌 / `restoreTaskStage` 挂回是同一副结构：摘牌也是回合开头无条件做的，那时同样
// 不知道这一轮会不会真改东西。代价是纯询问期间线路图短暂退回起点 —— 换来的是那段
// 时间里**没有任何会合并的按钮**，这笔买卖稳赚。
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
import type { TaskStage } from "@harness/shared";
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
  /**
   * 回合开头清掉的账本原值，照片一样时原样放回。三种取值要分清：
   *   `LedgerSnapshot` → 开头清过账，结算时按它恢复
   *   `null`           → 开头查过、不用清（账本本来就干净，或 verify_failed 那一档）
   *   字段缺失         → **旧版 server 写的基线**，那一轮开头没清过，结算时退回老路径补清一次
   */
  ledger?: LedgerSnapshot | null;
  at: string;
}

/** 一条线的「上一版成绩」全在这四样里，清和放回都必须四样一起动。 */
interface LedgerSnapshot {
  workflowAt: string | null;
  verifyStationRounds: number;
  reviewStep: string | null;
  stage: TaskStage | null;
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
 * 起跑前的第一张照 —— 顺手把上一版的账清了。
 *
 * 落磁盘而不是内存：`data/runs/<taskId>/turn-baseline.json` 活得过 server 重启，
 * 重启后接管（reattach）那一路照样能比对上。
 *
 * **拍照必须排在清账前面**：清账会写 `tasks` 表，不碰工作目录，本来两边不相干；但真出了
 * 岔子（清账抛异常）时，先拍到的照还在，结算那头至少能照老路把账补清，不会连基线都没有。
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
      ledger: await resetWorkflowLedger(taskId),
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

// 这行写在**回合开头**，那会儿还不知道 agent 会不会真动代码，所以措辞得是前瞻的：
// 先说清「已经退回起点了」，再把「白退了会放回去」这条兜底讲明白。
const RESET_NOTE =
  "收到新的指令，这条线先退回「让 AI 干活」这一站：上一版的验证与验收记录已清空，"
  + "改完要从头再走一遍（上一版验过了，不能替这一版放行）。"
  + "这一轮要是一个字节都没改，会把刚才清掉的原样放回去。";

/** 清了账、线却不会自己往下走的那一档，得把「停在哪、怎么让它继续」说出来。 */
const RESET_STALLED_NOTE =
  "这一轮没有确认完成，所以线就停在「让 AI 干活」这一站，不会自己往下走"
  + "——再回一句让它把这一版确认完成，后面的站（预览 / 等我点头 / 验证）就会照常接着跑。";

/** 白清一场：纯询问回合的收尾。 */
const RESTORE_NOTE =
  "这一轮没有产出任何改动，线路图已放回原处——纯询问不用重走一遍流程。";
const restoreStageNote = (stage: TaskStage) =>
  "这一轮没有产出任何改动，线路图已放回原处、验收阶段放回"
  + `「${STAGE_LABELS[stage]}」——纯询问不用重走一遍流程。`;

/**
 * 清账：把这条线退回起点，让新改动重新过一遍验证和验收。**返回被清掉的原值**，
 * 照片一样时按它原样放回（见 `restoreWorkflowLedger`）；本来就不用清则返回 null。
 *
 * 三样东西一起清，少一样都还能让新代码溜过去：游标（`workflow_at`）搬回「让 AI 干活」
 * 那一站、这一站验过几轮（`verify_station_rounds` + `review_step`）归零、验收阶段
 * （`stage`）清空。**游标要搬回 run 站的 id，不能清成 null** —— 前端在没有游标时会按
 * status 猜位置（`web-next/src/workflow/workflowModel.ts` 的 `resolveCursor`：done 且
 * 无游标 → 落在 run 之后那一站），清成 null 反而显示成「已经走过第一站了」。
 */
async function resetWorkflowLedger(taskId: string): Promise<LedgerSnapshot | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return null;
  // 验证没过正在修 —— 同一版的事，账不能清（否则轮数上限形同虚设）。
  if (task.stage === "verify_failed") return null;
  const runId = firstAnchor(taskWorkflowDef(task.workflow), "run")?.id ?? null;
  const before: LedgerSnapshot = {
    workflowAt: task.workflowAt ?? null,
    verifyStationRounds: task.verifyStationRounds ?? 0,
    reviewStep: task.reviewStep ?? null,
    stage: (task.stage as TaskStage | null) ?? null,
  };
  const stale =
    !!before.stage ||
    before.verifyStationRounds > 0 ||
    !!before.reviewStep ||
    (!!before.workflowAt && before.workflowAt !== runId);
  if (!stale) return null; // 账本本来就是空的，别写一行没信息量的时间线
  // clearTaskStage 顺带广播 task.stage 并写时间线；没有 stage 可清时自己补那一行。
  if (before.stage) await clearTaskStage(taskId, RESET_NOTE);
  else await appendTaskTimeline(taskId, RESET_NOTE);
  await db
    .update(tasks)
    .set({ verifyStationRounds: 0, reviewStep: null, updatedAt: now() })
    .where(eq(tasks.id, taskId));
  if (runId && before.workflowAt !== runId) await setWorkflowAt(taskId, runId); // 广播 task.updated
  return before;
}

/**
 * 把开头清掉的账原样放回（纯询问回合）：游标、这一站验过几轮、review_step。
 *
 * **stage 不在这儿放**，由调用方统一处理 —— 那块牌子有两条来路（开头 `reopenAcceptedStage`
 * 摘走的 accepted/merged，和这里清掉的其它阶段），时间线也只该为这件事写一行。
 */
async function restoreWorkflowLedger(taskId: string, ledger: LedgerSnapshot): Promise<void> {
  await db
    .update(tasks)
    .set({
      verifyStationRounds: ledger.verifyStationRounds,
      reviewStep: ledger.reviewStep,
      updatedAt: now(),
    })
    .where(eq(tasks.id, taskId));
  await setWorkflowAt(taskId, ledger.workflowAt); // 广播 task.updated
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
 * 结算时拍第二张照并作出决定。账在回合开头就清过了，这里只做两件事：
 * 照片一样 → 把清掉的原样放回（外加拆空壳屋）；照片不一样 → 保持清空。
 *
 * **必须排在 `afterSettlement` 之前**：那一步会拿着游标把这条线往下推
 * （`handleTaskSettlement → advanceWorkflowFrom(settleFrom(...))`），放回晚一步就会
 * 把纯询问回合的游标推乱。
 *
 * `confirmedDone` **只用来挑那行时间线的措辞**（清完之后线会不会自己往下走）。它绝不能
 * 再回到「清不清账」的判断里 —— 那正是上一次要修的病，理由见文件头。
 */
export async function reconcileTurnBaseline(taskId: string, confirmedDone: boolean): Promise<void> {
  const base = takeTurnBaseline(taskId);
  if (!base) return; // 这一轮没拍过照（系统续跑、验证轮、老任务）→ 维持原行为
  try {
    const after = await fingerprint(base.cwd);
    const changed = base.fingerprint === null || after === null || after !== base.fingerprint;
    if (changed) {
      // 账开头就清了，这里什么都不用做。唯一的例外是 `ledger` 字段缺失 —— 那张基线是
      // 升级前的旧 server 写的，那一轮开头没清过，退回老路径在这儿补清一次。
      const cleared = base.ledger === undefined ? await resetWorkflowLedger(taskId) : base.ledger;
      // 清了账、线又不会自己往下走的那一档，到这会儿才知道，补一句说明停在哪
      // （这句点名了「让 AI 干活」那一站，所以线上真有这么一站才写）。
      if (cleared && !confirmedDone) {
        const t = (await db.select({ workflow: tasks.workflow }).from(tasks).where(eq(tasks.id, taskId))).at(0);
        if (t && firstAnchor(taskWorkflowDef(t.workflow), "run")) {
          await appendTaskTimeline(taskId, RESET_STALLED_NOTE);
        }
      }
      return;
    }
    // 一个字节没变 = 纯询问。回合开头清掉的账、摘掉的「已验收/已合并」牌子都是白清的，
    // 放回去 —— 不然用户只是问一句「这段为什么这么做」，任务就从已验收掉回进行中，
    // 线路图也退回第一站，还得再点一次验收。
    if (base.ledger) await restoreWorkflowLedger(taskId, base.ledger);
    // 牌子的两条来路互斥：accepted/merged 在开头就被 `reopenAcceptedStage` 摘走了，
    // 轮到清账时 stage 已经是空的；其余阶段（verified / awaiting_acceptance…）才落在账里。
    // `restoreTaskStage` 只在牌子位还空着时放 —— 这一轮 agent 自报过新阶段的话那是更新的
    // 结论，不能被旧牌子盖掉；那种情况下退回只写一行不带阶段的说明。
    const stageBack = base.stage ?? base.ledger?.stage ?? null;
    const staged = stageBack ? await restoreTaskStage(taskId, stageBack, restoreStageNote(stageBack)) : false;
    if (!staged && base.ledger) await appendTaskTimeline(taskId, RESTORE_NOTE);
    if (base.fresh) await discardEmptyShell(taskId);
  } catch (error) {
    console.warn(`[harness] failed to reconcile turn baseline for ${taskId}:`, error);
  }
}
