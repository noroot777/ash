// 任务接力——导入侧。协议与导出逻辑见 handoff.ts 顶部注释。
//
// 这里的职责:把对端 POST 过来的 manifest 落成本机的一个完整任务——git 分支 fetch
// 进本地仓库、prepareWorktree 恢复档搭回工作目录、tasks/sessions 行落库、CLI 会话
// 文件放到本机 CLI 期望的位置、runs 产物归位,最后(可选)立刻续跑。
// 失败要么整体 4xx/5xx(什么都没建),要么建成但带 notes 说明哪些东西退化了;
// 不留半截任务。
import { homedir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, sessions, tasks } from "./db/schema.js";
import {
  claudeProjectSlug, HandoffError, safeRel,
  type HandoffManifest, type HandoffFilePayload,
} from "./handoff.js";
import { ensureWorkdir, expandHome, prepareWorktree, projectHealthLight, worktreePathFor } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { DATA_DIR, RUNS_DIR } from "./paths.js";
import { codexHome, findRollout } from "./executors/codex-rollout.js";
import { createTasks } from "./task-store.js";
import { resumeOrRunTask } from "./task-resume.js";
import { now } from "./util.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskHandoff } from "@harness/shared";

const exec = promisify(execFile);
const MB = 1024 * 1024;
const MAX_FILE_BYTES = 100 * MB;

// 导入只接受**已结算**的状态;running/queued 混进来(理论上不该有)一律落 canceled,
// 假 running 会骗过所有「在跑」判断却没有任何进程。
const SETTLED = new Set(["backlog", "paused", "done", "failed", "canceled"]);

const isStr = (v: unknown): v is string => typeof v === "string";

/** JSON 列必须真的是 JSON——坏值现在拒收,好过落库后每次序列化都炸。 */
function jsonOr(v: unknown, fallback: string): string {
  if (!isStr(v)) return fallback;
  try { JSON.parse(v); return v; } catch { return fallback; }
}

function validate(input: unknown): HandoffManifest {
  const m = input as HandoffManifest;
  if (!m || typeof m !== "object") throw new HandoffError("导入体必须是 JSON 对象");
  if (m.version !== 1) throw new HandoffError(`不认识的接力协议版本 ${String((m as { version?: unknown }).version)},两边 harness 版本差太远`);
  if (!isStr(m.targetProjectId)) throw new HandoffError("缺 targetProjectId");
  // transferId 宽容校验:老版本导出没有这个字段,缺了照收(只是失去幂等重放能力)。
  const tid = (m as { transferId?: unknown }).transferId;
  if (tid != null && (!isStr(tid) || tid.length > 64)) throw new HandoffError("transferId 非法");
  const t = m.task;
  if (!t || !isStr(t.id) || !/^[A-Za-z0-9_-]{6,64}$/.test(t.id)) throw new HandoffError("task.id 非法");
  if (!isStr(t.title) || !isStr(t.body) || !isStr(t.createdAt)) throw new HandoffError("task 关键字段缺失");
  if (!Array.isArray(m.sessions) || m.sessions.length > 200) throw new HandoffError("sessions 非法");
  if (!Array.isArray(m.files) || m.files.length > 500) throw new HandoffError("files 非法(最多 500 个)");
  for (const f of m.files) {
    if (!isStr(f.rel) || !isStr(f.dataBase64)) throw new HandoffError("file 载荷字段缺失");
    if (!["claude-session", "codex-rollout", "run-artifact"].includes(f.kind)) {
      throw new HandoffError(`不认识的文件类型 ${String(f.kind)}`);
    }
  }
  if (m.git !== null && (!m.git || !isStr(m.git.branch) || !isStr(m.git.bundleBase64))) {
    throw new HandoffError("git 载荷非法");
  }
  return m;
}

/** bundle 落进本地仓库:verify 确认前置提交齐全,再把分支强制 fetch 进来。 */
async function importGitBundle(
  repoPath: string,
  git: NonNullable<HandoffManifest["git"]>,
  notes: string[],
): Promise<void> {
  const repo = expandHome(repoPath);
  // 空 bundle = 源机确认本机已有全部提交(见 handoff.ts packGitState),只需对齐分支。
  if (!git.bundleBase64) {
    await withRepoLock(repoPath, async () => {
      try {
        await exec("git", ["-C", repo, "cat-file", "-e", `${git.head}^{commit}`]);
      } catch {
        throw new HandoffError(
          `对端说本机已有提交 ${git.head.slice(0, 8)},但本机仓库里找不到——两边仓库状态漂了,重新预检再试`,
          409,
        );
      }
      try {
        await exec("git", ["-C", repo, "branch", "-f", git.branch, git.head]);
        notes.push(`本机已有分支全部提交,分支 ${git.branch} 已对齐(未传输 git 数据)`);
      } catch {
        // 分支正被某个 worktree 检出时 branch -f 会拒绝;提交都在,如实记录即可。
        notes.push(`本机已有分支全部提交,但 ${git.branch} 正被占用无法强制对齐,以本机分支现状为准`);
      }
    });
    return;
  }
  const tmpDir = join(DATA_DIR, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const bundlePath = join(tmpDir, `handoff-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bundle`);
  try {
    await writeFile(bundlePath, Buffer.from(git.bundleBase64, "base64"));
    await withRepoLock(repoPath, async () => {
      try {
        await exec("git", ["-C", repo, "bundle", "verify", bundlePath], { maxBuffer: 4 * MB });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new HandoffError(
          `git bundle 校验失败——本机仓库缺少接力分支的前置提交。先在本机把仓库 git fetch/pull 到较新状态再重试接力。原始错误:${msg.slice(0, 400)}`,
          409,
        );
      }
      // `+` 强制更新:重复接力同一任务(先删了旧任务)时分支可能已存在旧尖。
      await exec("git", [
        "-C", repo, "fetch", bundlePath,
        `+refs/heads/${git.branch}:refs/heads/${git.branch}`,
      ], { maxBuffer: 4 * MB });
    });
    notes.push(`git 分支 ${git.branch} 已导入(${git.full ? "全量历史" : "增量"})`);
  } finally {
    rmSync(bundlePath, { force: true });
  }
}

/**
 * 把 manifest 里的文件落到本机对应位置,返回**真正写盘成功**的会话文件名(basename)集合。
 * cliSessionId 只认这个集合——manifest 里声称带了文件、但被跳过/写失败的会话,一律按
 * 未迁移处理,否则续跑时 CLI 按 id 找不到历史就成了假恢复。
 */
async function writePayloadFiles(
  files: HandoffFilePayload[],
  taskId: string,
  remoteCwd: string,
  notes: string[],
): Promise<Set<string>> {
  const claudeDir = join(homedir(), ".claude", "projects", claudeProjectSlug(remoteCwd));
  const arrived = new Set<string>();
  for (const f of files) {
    // 协议约定 rel 用 `/` 分隔,但老版本 Windows 源机导出的是 `\`——两种都按段拆开重组,
    // 否则整串反斜杠在 POSIX 上是一个文件名,写进错误位置后 findRollout 永远找不到
    // (审查实测:跨平台假迁移)。
    const segs = f.rel.split(/[\\/]/);
    let dest: string;
    if (f.kind === "claude-session") {
      // 会话文件名就是 `<uuid>.jsonl`,不允许带任何目录成分。
      if (!/^[A-Za-z0-9_-]+\.jsonl$/.test(f.rel)) { notes.push(`claude 会话文件名非法,跳过:${f.rel}`); continue; }
      dest = join(claudeDir, f.rel);
    } else if (f.kind === "codex-rollout") {
      if (!safeRel(f.rel)) { notes.push(`codex rollout 路径非法,跳过:${f.rel}`); continue; }
      dest = join(codexHome(), "sessions", ...segs);
    } else {
      if (!safeRel(f.rel)) { notes.push(`产物路径非法,跳过:${f.rel}`); continue; }
      dest = join(RUNS_DIR, taskId, ...segs);
    }
    const data = Buffer.from(f.dataBase64, "base64");
    if (data.byteLength > MAX_FILE_BYTES) { notes.push(`${f.rel} 解码后超限,跳过`); continue; }
    mkdirSync(dirname(dest), { recursive: true });
    await writeFile(dest, data);
    if (f.kind !== "run-artifact") arrived.add(segs.at(-1)!);
  }
  return arrived;
}

export interface HandoffImportResult {
  ok: true;
  taskId: string;
  workspace: string | null;
  sessionsMigrated: number;
  autoResume: boolean;
  notes: string[];
}

// 同一 task id 的导入互斥闸:两个请求同时过掉下面的 existing 检查后,输家会撞
// tasks.id UNIQUE,而它的补偿回滚曾按公共 task id 无条件清理,把赢家刚建好的任务
// 也删掉(审查实测:req1 200、req2 500、最终 GET 404)。这种并发不需要恶意——应答
// 丢失后用户重试时,上一次导入可能还在本机处理中。进程内按 task id 串行(本机 DB
// 有单实例锁,不存在跨进程写方),后来者 409 让源机稍后原样重放收口。
const importsInFlight = new Set<string>();

export async function importHandoff(input: unknown): Promise<HandoffImportResult> {
  const m = validate(input);
  if (importsInFlight.has(m.task.id)) {
    throw new HandoffError("这个任务的另一次导入还在本机进行中,等它落定后再原样重试", 409);
  }
  importsInFlight.add(m.task.id);
  try {
    return await importValidated(m);
  } finally {
    importsInFlight.delete(m.task.id);
  }
}

async function importValidated(m: HandoffManifest): Promise<HandoffImportResult> {
  const notes: string[] = [];
  const project = (await db.select().from(projects).where(eq(projects.id, m.targetProjectId))).at(0);
  if (!project) throw new HandoffError("目标项目不存在(对端项目清单可能过期,重新预检)", 404);
  const existing = (await db
    .select({ id: tasks.id, handoff: tasks.handoff })
    .from(tasks)
    .where(eq(tasks.id, m.task.id))).at(0);
  if (existing) {
    // 应答丢失后的原样重试:同一个 transferId 说明就是同一次接力,按成功收口、零副作用,
    // 让源机把 pending 标记改写成「已接力」。没有 transferId(老版本)或对不上才是真冲突。
    let h: TaskHandoff | null = null;
    if (existing.handoff) {
      try { h = JSON.parse(existing.handoff) as TaskHandoff; } catch { h = null; }
    }
    if (h?.direction === "in" && m.transferId && h.transferId === m.transferId) {
      return {
        ok: true,
        taskId: m.task.id,
        workspace: null,
        sessionsMigrated: h.sessions,
        autoResume: false,
        notes: ["本机已有这次接力导入的任务(应答曾丢失,本次为幂等收口),未重复导入"],
      };
    }
    throw new HandoffError("本机已有同 id 任务(可能已经接力过一次)。要重新接力,先在本机删掉那个任务。", 409);
  }
  // 会话 id 冲突预检:必须在任何副作用之前拦下,否则落库落到一半 UNIQUE 炸掉,
  // 留下没有会话的半截任务(审查实测:import 500 后 GET 200、重试永远 409)。
  if (m.sessions.length) {
    const conflicts = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.id, m.sessions.map((s) => s.id)));
    if (conflicts.length) {
      throw new HandoffError(
        `会话 id 与本机已有会话冲突(${conflicts.map((c) => c.id).join(", ")}),什么都没导入。这份任务可能曾从本机接力出去——先在本机删掉旧任务再试。`,
        409,
      );
    }
  }

  const isRepo = projectHealthLight(project.repoPath).isRepo;
  // useWorktree 依赖本机项目真的是 git 仓库;不是就退化成共享目录,如实记 notes。
  const useWorktree = m.task.useWorktree && isRepo;
  if (m.task.useWorktree && !isRepo) notes.push("本机项目不是 git 仓库,任务退化为共享目录运行,代码状态未迁移");

  // ── git:先分支进仓库,再恢复 worktree ────────────────────────────────────
  let workspace: string | null = null;
  if (useWorktree && m.git) {
    await importGitBundle(project.repoPath, m.git, notes);
    const ws = await prepareWorktree(project.repoPath, m.task.id, m.task.worktreeBase);
    workspace = ws.path;
    if (ws.branch !== m.git.branch) {
      // 源机的分支被手动改过名:fetch 进来的分支还在,但 worktree 挂的是标准名。
      notes.push(`源分支名 ${m.git.branch} 与本机 worktree 分支 ${ws.branch} 不一致,导入的提交在 ${m.git.branch} 上,必要时手动合一下`);
    }
    if (ws.fresh) {
      notes.push("worktree 是全新建的(没接上导入分支),代码进度可能没挂上——检查一下分支");
    }
  } else if (useWorktree) {
    // 没有 git 载荷(源机 worktree 没建过/detached):worktree 留给首次运行时惰性创建。
    workspace = worktreePathFor(project.repoPath, m.task.id);
  } else {
    workspace = ensureWorkdir(project.repoPath, m.task.id);
  }

  // ── 文件先落盘,再落库 ──────────────────────────────────────────────────
  // 顺序有讲究:文件写一半崩了只留下无害的磁盘残留(重试会原样覆盖);反过来先落库
  // 再写文件,「任务行在、文件没到」就是半截任务。arrived 是真正写盘成功的会话文件名。
  const arrived = await writePayloadFiles(m.files, m.task.id, workspace ?? expandHome(project.repoPath), notes);

  // ── cliSessionId 只认「文件写盘成功、且 CLI 自己找得到」的会话 ────────────
  // claude 的文件名是 `<cliSessionId>.jsonl`,codex 是 `rollout-<ts>-<threadId>.jsonl`。
  // codex 还要过 findRollout:它只按 sessions/YYYY/MM/DD 的标准深度扫描,rel 深度不对时
  // 文件在盘上但 codex 定位不到,保留 cliSessionId 就是假恢复(续跑报找不到线程)。
  const hasFile = (s: HandoffManifest["sessions"][number]): boolean =>
    !!s.cliSessionId && [...arrived].some(
      (name) => name === `${s.cliSessionId}.jsonl` || name.endsWith(`-${s.cliSessionId}.jsonl`),
    );
  const usable = new Map<string, boolean>();
  for (const s of m.sessions) {
    let ok = hasFile(s);
    if (ok && s.agentType === "codex") {
      ok = !!(await findRollout(s.cliSessionId!));
      if (!ok) notes.push(`codex 会话 ${s.id} 的 rollout 已写盘但无法按标准目录定位,按未迁移处理`);
    }
    usable.set(s.id, ok);
  }
  const migrated = m.sessions.filter((s) => usable.get(s.id));

  // ── resumePrompt:告诉续跑的 agent 它被搬过机器了 ───────────────────────
  const agentType = m.task.agentType ?? "claude";
  const latest = [...m.sessions]
    .filter((s) => s.agentType === agentType)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
  const resumable = !!latest && !!usable.get(latest.id);
  const preamble = [
    `【任务接力】本任务从另一台机器(${m.sourceHost})接力到本机继续。`,
    m.git ? "git 分支和已提交的改动已随任务迁移。" : "代码没有随任务迁移,以本机仓库当前状态为准。",
    `工作目录从 ${m.sourceWorkspace ?? "(未知)"} 变为 ${workspace},历史对话里引用的旧绝对路径一律以新目录为准。`,
    "先快速核对工作目录(git log/status、关键文件是否符合预期),再继续完成任务目标。",
  ].join("");
  let resumePrompt: string | null;
  if (m.sessions.length === 0) {
    resumePrompt = m.task.resumePrompt; // 没跑过的任务原样保留,首跑走正常 fresh 路径
  } else if (resumable) {
    resumePrompt = preamble + (m.task.resumePrompt ? `\n\n上次暂停时留下的续跑提示:\n${m.task.resumePrompt}` : "");
  } else {
    // 会话文件没到货:续跑会开全新 CLI 会话、只看到这一条消息,任务正文必须自带。
    notes.push("CLI 会话历史未迁移,续跑将开全新会话(任务正文已并入首条消息)");
    resumePrompt = [
      preamble,
      "\n\n注意:CLI 会话历史没有随任务迁移,这是一个全新会话。任务目标全文如下:\n\n" + m.task.body,
      m.task.resumePrompt ? `\n\n上次暂停时留下的续跑提示:\n${m.task.resumePrompt}` : "",
    ].join("");
  }

  const marker: TaskHandoff = {
    direction: "in",
    // 源机生成的接力身份证:应答丢失后源机原样重试时,靠它把「已有同 id 任务」识别成
    // 同一次接力并幂等收口(见上面 existing 分支)。
    transferId: m.transferId ?? null,
    peerUrl: null,
    peerName: m.sourceHost || null,
    peerTaskId: m.task.id,
    at: now(),
    sessions: migrated.length,
    git: useWorktree && m.git ? "bundle" : "none",
  };
  const status = SETTLED.has(m.task.status) ? m.task.status : "canceled";
  // 任务行真的插进去了才置真:插入本身撞 UNIQUE 时,库里那行是别人(或历史)的,
  // 补偿回滚绝不能按公共 task id 把它删掉。
  let taskRowInserted = false;
  try {
    // sessions 作为 afterInsert 塞进 createTasks:会话插入失败时 task.created 广播还没发,
    // 回滚后前端不会闪过「幽灵任务」;成功时广播出去的任务已带全会话。
    await createTasks([{
      id: m.task.id,
      projectId: project.id,
      title: m.task.title,
      body: m.task.body,
      mode: "single",
      status,
      stage: m.task.stage,
      labels: jsonOr(m.task.labels, "[]"),
      agentType: m.task.agentType,
      // executorId 是本机 agents 表的外键语义,对端的 id 在这边没有意义 → 走 agentType 默认。
      executorId: null,
      model: m.task.model,
      reasoningEffort: m.task.reasoningEffort,
      autoTitle: m.task.autoTitle,
      useWorktree,
      worktreeBase: useWorktree ? m.task.worktreeBase : null,
      workflow: jsonOr(m.task.workflow, "") || null,
      workflowMode: (m.task.workflowMode as "free" | "workflow" | undefined) ?? "workflow",
      workflowAt: m.task.workflowAt,
      reviewStep: m.task.reviewStep,
      verifyRounds: m.task.verifyRounds ?? 0,
      verifyStationRounds: m.task.verifyStationRounds ?? 0,
      resumePrompt,
      question: m.task.question,
      questionOptions: jsonOr(m.task.questionOptions, "") || null,
      questionItems: jsonOr(m.task.questionItems, "") || null,
      pinnedAt: m.task.pinnedAt,
      starredAt: m.task.starredAt,
      createdAt: m.task.createdAt,
      updatedAt: now(),
      startedAt: m.task.startedAt,
      endedAt: m.task.endedAt,
      handoff: JSON.stringify(marker),
      reportBack: false,
    }], async () => {
      // createTasks 先 await 任务行插入、再调 afterInsert——走到这里说明任务行是本次建的。
      taskRowInserted = true;
      if (!m.sessions.length) return;
      await db.insert(sessions).values(m.sessions.map((s) => ({
        id: s.id,
        taskId: m.task.id,
        role: s.role,
        agentType: s.agentType,
        executor: s.executor,
        // 本机档案/指纹/续跑命令全部重算或悬空:resumeCommand 读取时按目录重建,
        // fingerprint 留空避免「换机器 = 换执行器」误报。
        executorId: null,
        executorFingerprint: null,
        turnModel: s.turnModel,
        turnReasoningEffort: s.turnReasoningEffort,
        target: "local",
        worktreePath: useWorktree ? workspace : null,
        branch: s.branch,
        cwd: workspace,
        cliSessionId: usable.get(s.id) ? s.cliSessionId : null,
        commandLine: s.commandLine,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        exitStatus: s.exitStatus,
        stoppedAs: s.stoppedAs,
        sideTurn: s.sideTurn ?? false,
        activeMs: s.activeMs,
        turnStartedAt: s.turnStartedAt,
        usageInput: s.usageInput,
        usageOutput: s.usageOutput,
        usageCacheRead: s.usageCacheRead,
        usageCacheWrite: s.usageCacheWrite,
        usageReasoning: s.usageReasoning,
        usageCostUsd: s.usageCostUsd,
        usageTurns: s.usageTurns,
        contextUsed: s.contextUsed,
        contextWindow: s.contextWindow,
        contextWindowEstimated: s.contextWindowEstimated,
      })));
    });
  } catch (e) {
    // 补偿回滚:任务行 + 已插入的会话行一起清掉,不留半截任务(审查实测:UNIQUE 炸在
    // 会话插入后,GET 200 但任务残废、重试永远 409)。只清自己建的行——任务行没插成
    // (taskRowInserted=false)说明库里那行属于别的导入,动不得。git 分支/worktree/
    // 已写盘文件的残留无害——重试会原样覆盖。
    if (taskRowInserted) {
      try {
        await db.delete(sessions).where(eq(sessions.taskId, m.task.id));
        await db.delete(tasks).where(eq(tasks.id, m.task.id));
      } catch { /* 回滚自身失败没有更好的办法,错误照抛,让对端看到失败 */ }
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new HandoffError(`导入落库失败,已回滚,本机没有留下半截任务,可直接重试。原始错误:${msg.slice(0, 300)}`, 500);
  }

  if (m.autoResume) {
    // 火后不管:失败会照常走任务自己的失败结算,在界面上可见。
    void resumeOrRunTask(m.task.id, { reason: "run" }).catch((e) => {
      console.warn(`[handoff] 接力任务 ${m.task.id} 自动续跑失败:`, e);
    });
    notes.push("已触发自动续跑");
  }

  return {
    ok: true,
    taskId: m.task.id,
    workspace,
    sessionsMigrated: migrated.length,
    autoResume: m.autoResume,
    notes,
  };
}
