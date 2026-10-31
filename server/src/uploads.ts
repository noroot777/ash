// 上传附件的**授权面**(§八)。
//
// `data/uploads` 是个扁平目录:文件名(`<nanoid>-<原名>`)就是全部信息,`/api/uploads/:file`
// 拿着名字直接读盘。第 3 轮审查实证:多人模式下这等于**任何一个登录用户**只要拿到文件名
// (聊天记录、截图、导出包、日志里都可能出现),就能读到别人**私有随手记**的附件正文 ——
// `/api/notes` 那两条轴白过了,附件是随手记内容的一部分。
//
// 所以文件得有个能查的归属。判据两条,与库里其它面同一套口径:
//   · 个人面 —— 上传者本人恒可读(`ownerUserId`);
//   · 项目轴 —— 附到某个任务上的文件,那个任务看得见的人都可读(`taskId`)。
//     共享项目里的会话是给全体成员看的,里面的图当然也是。
//
// **没有登记行**的文件按「无主资产」处置:只有实例管理员可读 —— 与 `auth/owned.ts` 对
// `ownerUserId IS NULL` 的处置逐字一致。存量文件由转多人时的 `claimExistingUploads`
// 一次性认领(并按任务正文回填 taskId),所以这一档兜的是「哪条写盘路径忘了登记」,
// 失败方向是拒绝而不是放行。
//
// 自用模式下**整条判据透明**:一律放行,与本功能上线前逐字节一致。
import { readdir } from "node:fs/promises";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { basename } from "node:path";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks, uploads } from "./db/schema.js";
import { UPLOADS_DIR } from "./paths.js";
import { scanUploadNames, scanUploadRuns } from "./handoff-uploads.js";
import { uploadNameIndex, uploadRunCandidates } from "./upload-names.js";
import type { Actor } from "./auth/context.js";
import { ANONYMOUS_ACTOR, isAccountHolder, isAdminActor } from "./auth/context.js";
import { isMultiUser } from "./auth/mode.js";
import { getUser } from "./auth/store.js";
import { visibleTaskIds } from "./auth/visibility.js";
import { now } from "./util.js";
import type { AgentEvent } from "@ash/shared";
import type { SessionTraceEvent } from "./transcript.js";

/** 路径 / URL 段 → UPLOADS_DIR 下的文件名。Windows 的反斜杠也归一。 */
export const uploadFileName = (pathOrName: string): string =>
  basename((pathOrName ?? "").trim().replaceAll("\\", "/"));

/** 这个字符串指向 uploads 目录直下的附件吗;是就给出文件名。仓库里的文件返回 null。 */
export function uploadNameOf(pathOrName: string): string | null {
  const raw = (pathOrName ?? "").trim();
  if (!raw) return null;
  const name = uploadFileName(raw);
  if (!name) return null;
  // 裸文件名(接力载荷里就是这个形态)按名字认;带路径的必须真的落在 UPLOADS_DIR 直下 ——
  // 否则「把仓库里任意文件的路径写进 attachments」就能给它挂上一个任务归属。
  if (name === raw) return name;
  return scanUploadNames(raw).has(name) ? name : null;
}

/**
 * 登记一个新写下的附件。同名再登记不覆盖归属(先到先得,后面的只补空位)。
 *
 * **幂等而且不抢唯一键**:先 insert-or-ignore,再按库里真正那一行补空位。先 SELECT 再
 * INSERT 的那一版两条并发登记会同时看到「没有这一行」(直接登记与总线兜底常常同时触
 * 发),输掉的那次抛 `UNIQUE constraint failed: uploads.file`,而调用点大多只 warn ——
 * 它要补的那半边归属就这么丢了(审查第 3 轮 N4:`test:native-work` 真实出现过这条告警)。
 */
export async function registerUpload(
  file: string,
  fields: { ownerUserId?: string | null; taskId?: string | null } = {},
): Promise<void> {
  const name = uploadFileName(file);
  if (!name) return;
  await db.insert(uploads).values({
    file: name,
    ownerUserId: fields.ownerUserId ?? null,
    taskId: fields.taskId ?? null,
    // 声明了归属人的行落盘就带上「本人上传」标记:迁移扫描(db/index.ts claim_origin 段)
    // 要把没有标记的旧代管行认出来,判据是「建行早于第一位用户建档」—— 那是**墙上时钟**,
    // 回拨/跨机导入都能把新行推到线前(第 9 轮复审第 2 轮 R4 clock-step 实测)。写入时把
    // 来历记死,时钟说什么都不再影响这行的隐私;无主行不打标,之后谁补 owner 谁记来历。
    claimOrigin: fields.ownerUserId ? "user" : null,
    createdAt: now(),
  }).onConflictDoNothing({ target: uploads.file });
  const existing = (await db.select().from(uploads).where(eq(uploads.file, name))).at(0);
  // 这一次自己插进去的那行已经带着归属了,下面算出来的 patch 自然是空的。
  if (!existing) return;
  // 只补空位:已经有归属的行不许被后来的写入改掉(见 bindUploadsToTask 的越权推演)。
  // **补 taskId 同样是在改授权面** —— 给别人的私有文件补一条任务 id,等于把它敞开给
  // 那条任务看得见的所有人。所以补空位也要先认人:行是无主的,或者本来就是这次声明
  // 的这个人的。接力导入曾借这一句把同名的私有行挂到接力任务上(第 5 轮审查 P1)。
  const patch: { ownerUserId?: string; taskId?: string; claimOrigin?: string } = {};
  const guards = [eq(uploads.file, name)];
  if (!existing.ownerUserId && fields.ownerUserId) {
    patch.ownerUserId = fields.ownerUserId;
    // 来历跟着 owner 一起记(见上面 insert 的注释);已有来历(repair)的不覆盖。
    if (!existing.claimOrigin) patch.claimOrigin = "user";
    guards.push(isNull(uploads.ownerUserId));
  }
  const mine = !existing.ownerUserId || existing.ownerUserId === fields.ownerUserId;
  // 「owner 非空」不都等于私有:转多人时 claimExistingUploads 给存量文件统一补的 owner 是
  // **代管**(claimOrigin='conversion'),agent 后来生成的图不在任务初始正文里,当时反查不到
  // taskId;事后读到可信产物清单(backfillArtifactUploads 只传 {taskId})再来补,若按「不是
  // 我的」一律拒,这些图对项目成员永远 404(审查第 8 轮 R3)。真私有(本人上传,无标记)
  // 照旧只认人。
  const migrated = existing.claimOrigin === "conversion";
  if (!existing.taskId && fields.taskId && (mine || migrated)) {
    patch.taskId = fields.taskId;
    guards.push(isNull(uploads.taskId));
  }
  // 补空位这一步自己也得是「比较后再写」:读到空、写回去之间另一次登记可能刚填上它,
  // 没有这道 where 就会把先到的那个归属盖掉(先到先得是这整段的判据)。
  if (Object.keys(patch).length) await db.update(uploads).set(patch).where(and(...guards));
}

/**
 * 本机对这批名字的既有登记情况,接力落地拿它决定撞名时改名还是复用(handoff-uploads.ts)。
 *   · `registered` —— 有登记行的名字。文件被删、行还在的也算撞名。
 *   · `boundToTask` —— 登记行**已经就挂在这条接力任务上**。只有这一档可以复用本机
 *     那份字节:授权面与「新写一份再登记给这条任务」完全等价(接力移回的常态)。
 * 其余撞名一律改名落地 —— 「字节一样」不代表「这条任务的人读得到」:本机那份可能是
 * 某人的私有附件、或挂在一条导入方看不见的任务上,复用就等于让附件可读性取决于一条
 * 无关的旧登记(第 6 轮审查 P2)。
 */
export async function localUploadNames(
  names: string[],
  taskId: string,
): Promise<{ registered: Set<string>; boundToTask: Set<string> }> {
  const registered = new Set<string>();
  const boundToTask = new Set<string>();
  if (!names.length) return { registered, boundToTask };
  for (const row of await db.select().from(uploads).where(inArray(uploads.file, names))) {
    registered.add(row.file);
    if (row.taskId === taskId) boundToTask.add(row.file);
  }
  return { registered, boundToTask };
}

/** 一批刚写下的附件。用在「字节是我们自己写的」那些地方(接力落地)。 */
export async function registerUploads(
  files: string[],
  fields: { ownerUserId?: string | null; taskId?: string | null } = {},
): Promise<void> {
  for (const file of files) await registerUpload(file, fields);
}

/**
 * 把一批附件挂到某个任务上 —— 附件跟着任务走进项目轴,同项目的人就看得见了。
 *
 * **只改已有的登记行,一行都不新建。** 这条边界是判据的一半:
 *   · 附件路径是请求体里带来的,谁都能把别人的附件写进自己任务的 attachments,
 *     所以只认「还没挂任务」且「无主或本来就是我的」那些行;
 *   · 没有登记行的文件是**失败关闭**那一档(只有实例管理员读得到)。这里若顺手补一行,
 *     等于给出一条「引用即认领」的路:随便写一个 uploads 目录里已存在、但登记漏了的
 *     文件名(上传写盘后崩在登记前、或哪条写盘路径忘了登记),就把它变成自己的、
 *     还顺带敞开给整个项目 —— 第 4 轮审查实测过这条路。
 *
 * 登记只发生在**刚写下这些字节**的地方(`registerUpload` / `registerUploads`:上传接口、
 * 接力落地、agent 产出的图),以及转多人时的一次性认领。要救回失联的文件走那条管理员
 * 路径,不走普通用户的任务写入。
 */
export async function bindUploadsToTask(
  paths: string[] | undefined,
  taskId: string,
  actorUserId: string | null,
): Promise<void> {
  const names = [...new Set((paths ?? []).map(uploadNameOf).filter((name): name is string => !!name))];
  if (!names.length) return;
  const rows = await db.select().from(uploads).where(inArray(uploads.file, names));
  for (const row of rows) {
    if (row.taskId) continue;
    if (row.ownerUserId && row.ownerUserId !== actorUserId) continue;
    await db.update(uploads).set({ taskId }).where(eq(uploads.file, row.file));
  }
}

/**
 * **可信产物**里记着的那几张图,归属补齐(可重入)。
 *
 * 为什么需要它:登记只发生在「刚写下这些字节」的那一刻(`noteAgentEventUpload` 挂在公共
 * 广播口上),而那一道是 2026-10-21 才补的 —— 在它之前落盘的回合,图还好好躺在 uploads
 * 里、产物里也写着它的路径,唯独这张表里那一行没有 taskId。按 `canReadUpload` 的判据那就
 * 是无主资产:多人模式下同项目的普通成员重新打开那条讨论/那段执行过程,结论看得到、图一律
 * 404(跟「文件不存在」同一句话),而且**没有新广播就永远不会恢复**(审查第 3 轮 R4)。
 * `claimExistingUploads` 也补不到:它只扫任务正文,agent 后来生成的图不在里面。
 * 顺带把登记失败那条分支也收口了 —— `noteAgentUpload` 写不进去只是 warn,下一次读到那份
 * 产物就会再登记一次。
 *
 * **路径只能来自服务端自己写下的产物清单**(讨论回合的 `images`、会话 trace 的 attachment
 * 事件),信任级别跟广播口那一道完全相同。正文里的路径一个都不认,那是「引用即认领」那条
 * 路(推演见 `bindUploadsToTask`);这里再经 `uploadNameOf` 核一遍它真落在 uploads 目录直
 * 下,`registerUpload` 本身又只补空位,所以这一道夺不走任何归属。
 */
export async function backfillArtifactUploads(
  taskId: string,
  paths: Iterable<string | undefined>,
): Promise<void> {
  const names = new Set<string>();
  for (const path of paths) {
    const name = typeof path === "string" ? uploadNameOf(path) : null;
    if (name) names.add(name);
  }
  for (const name of names) {
    try {
      await registerUpload(name, { taskId });
    } catch (error) {
      // 读产物这件事不该因为补归属失败而整条失败(下一次读还会再试)。
      console.warn("[ash] 附件归属回填失败:", error);
    }
  }
}

/**
 * 「确认所属任务」的修复出口(第 9 轮审查 R4)。claim_origin 落地前转换的存量行里,建于
 * 转换那一刻的与真私有上传无法区分,ensureSchema 的自动补标保守跳过 —— 真属于某条任务的
 * 由**行的归属人自己**在这里确认补挂。判据是本人同意,不是管理员身份:管理员替别人确认,
 * 等于把别人可能私有的附件敞开给一个项目(「实例管理员也读不到别人的私有附件」这条不变量
 * 不在这里打洞);本人把自己的文件挂给自己看得见的任务,与他手动转发一份是同一件事。
 * 无主行(连 owner 都没登记上的失联档)本来就只有管理员读得到,由管理员确认。
 *   · 回合凭证不算本人(isAccountHolder 的推演):任意在跑的 agent 都能拿 owner 的身份
 *     把文件挂进自己的任务;
 *   · 只补空位:taskId 是授权面,已有归属不许改挂;
 *   · 目标任务必须存在且确认人自己看得见 —— 挂给一个自己无法核实受众的任务 id 不算确认;
 *   · claimOrigin 记 'repair' 不记 'conversion':人工确认与自动迁移分开记,错了可按标撤。
 * 返回错误文案,null = 成功。没登记的、别人的行回同一句话,不泄露文件存不存在(与读接口
 * 同口径)。
 */
export async function repairUploadClaim(actor: Actor, fileOrPath: string, taskId: string): Promise<string | null> {
  const name = uploadFileName(fileOrPath);
  if (!name || !taskId) return "需要文件名和 taskId";
  if (!isAccountHolder(actor) || !actor.userId) return "只有登录用户可以确认附件归属";
  const row = (await db.select().from(uploads).where(eq(uploads.file, name))).at(0);
  const mine = row && (row.ownerUserId ? row.ownerUserId === actor.userId : isAdminActor(actor));
  if (!row || !mine) return "没有这条可确认的登记";
  if (row.taskId) return row.taskId === taskId ? null : "已挂在别的任务上,不能改挂";
  const task = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || !(await visibleTaskIds(actor, [taskId])).length) return "目标任务不存在或不可见";
  // 「比较后再写」:读到空与写回之间别的登记可能刚填上,空位守卫保住先到先得。写完要回
  // 读核实:守卫没写进去(并发另一次确认/登记抢了先)不能当成功报 —— 本人以为挂好了,
  // 行其实挂在别的任务上(第 9 轮复审第 2 轮 N8)。
  await db.update(uploads).set({ taskId, claimOrigin: "repair" })
    .where(and(eq(uploads.file, name), isNull(uploads.taskId)));
  const after = (await db.select().from(uploads).where(eq(uploads.file, name))).at(0);
  return after?.taskId === taskId ? null : "另一次登记抢了先,这行已挂在别的任务上";
}

/** agent 自己产出的图(工具结果截图之类)。没有上传者,归它跑的那个任务。 */
export function noteAgentUpload(taskId: string, path: string): void {
  void registerUpload(path, { taskId }).catch((error) => {
    // 登记失败只影响别人能不能在界面上看到这张图,不该动摇这一轮的产出。
    console.warn("[ash] 附件归属登记失败:", error);
  });
}

/**
 * 「凡是作为 `agent.event` 广播出去的附件,归属已经登记」—— 这条不变量落在**公共发布
 * 口**上,而不是指望每条执行链各自记得调一次。
 *
 * 为什么必须补这一层:单飞在 `single-run.ts` 的 persistTrace 里登记、团队调度台在
 * `team/lead-voice.ts` 的 traceLead 里登记,两处都挂在**写 trace** 这个动作上;讨论
 * (`duet/turn.ts`)自己写 transcript.jsonl、不走 appendSessionTrace,于是整条链一个字都
 * 没登记 —— 多人模式下普通成员看得到讨论任务和结论、却打不开结论里的图(uploads 行没有
 * taskId = 无主资产,`canReadUpload` 回 404,跟「文件不存在」同一句话;审查第 2 轮 F4 用
 * 真实 runTurn + 真实上传路由实测 404 → 登记后 200)。
 *
 * 判据因此换成**「它有没有把这个事件广播出去」**:广播了就等于这条链要让人看见这张图,
 * 那就必须先有归属。下一条新执行链不写 trace 也照样被这条网兜住。主发言者自己的
 * attachment 和包在子智能体活动里的那些由 `noteAgentEventUpload` 同一个入口处理。
 *
 * 跟那两处直接调用重复不要紧:`registerUpload` 只补空位(见它的注释),重复登记是幂等的。
 */
let watching = false;

export function watchAgentUploads(): void {
  if (watching) return;
  watching = true;
  bus.subscribe((event) => {
    if (event.type === "agent.event") noteAgentEventUpload(event.taskId, event.event);
  });
}

/**
 * 一条可信事件里那张**会被端到人眼前**的附件 —— 实时登记与历史回填**共用这一份遍历**。
 *
 * 为什么必须共用:`attachment` 不止长在顶层,子智能体那一层是包在
 * `tool.nativeWork.type === "activity"` 里的(见 shared 的 NativeAgentActivity),而展示端
 * 把它拆出来照样铺卡片(web 的 nativeAgentSegments → AgentTurnBody)。两处各写一遍遍历
 * 就会分叉:新广播那一道解包了,读旧 trace 那一道只看顶层,于是刚修好的主附件 200、老的
 * 子附件仍然 404(审查第 3 轮 R3 真实路由实测)。
 *
 * 没有 path 的 attachment 是「这处引用没存下副本」的交代,没有文件可登记。
 */
export function eventAttachmentPath(event: AgentEvent | SessionTraceEvent): string | undefined {
  const content = event.kind === "tool" && event.nativeWork?.type === "activity" ? event.nativeWork.event : event;
  return content.kind === "attachment" ? content.path : undefined;
}

export function noteAgentEventUpload(taskId: string, event: AgentEvent | SessionTraceEvent): void {
  const path = eventAttachmentPath(event);
  if (path) noteAgentUpload(taskId, path);
}

/** 能读这个附件吗。找不到与没权限**回同一句话**(路由统一 404),不泄露文件存不存在。 */
export async function canReadUpload(actor: Actor, file: string): Promise<boolean> {
  if (!(await isMultiUser())) return true;
  const name = uploadFileName(file);
  if (!name) return false;
  const row = (await db.select().from(uploads).where(eq(uploads.file, name))).at(0);
  if (!row) return isAdminActor(actor);
  if (row.ownerUserId ? row.ownerUserId === actor.userId : isAdminActor(actor)) return true;
  if (row.taskId) return (await visibleTaskIds(actor, [row.taskId])).length > 0;
  return false;
}

/**
 * 「这个人读得到哪些附件」——给**没有请求上下文**的链路用(出站接力打包)。
 *
 * 出境的字节也得过这条判据:附件路径会出现在日志、粘贴的 prompt、截图里,谁都可能
 * 拿到一个别人的文件名。把它写进一条自己看得见的任务再接力出去,导出侧照着任务正文
 * 扫名字打包 —— 私有附件的**内容**就这么被送到另一台机器上了(8CEbm0rJQIwK 第 1 轮
 * 审查 P1)。判据不新造:能不能带走 == 这个人在本机能不能打开它,毕竟他本来就能自己
 * 复制一份。自用模式恒放行,与本功能上线前逐字节一致。
 *
 * 返回一个判定函数而不是名单:名字是扫文本扫出来的,调用方拿到名字才知道要问谁。
 * 用户行只查一次。
 */
export async function readableUploads(userId: string | null): Promise<(file: string) => Promise<boolean>> {
  if (!(await isMultiUser())) return async () => true;
  const user = userId ? await getUser(userId) : null;
  // 认不出人就按未登录处置(失败关闭):出站链路忘了带身份时,宁可少带走附件、
  // 让对端按旧路径读不到,也不能把不属于他的字节送出境。
  const actor: Actor = user
    ? { kind: "user", userId: user.id, role: user.role === "admin" ? "admin" : "member", name: user.name }
    : ANONYMOUS_ACTOR;
  return (file: string) => canReadUpload(actor, file);
}

/**
 * 转多人时认领存量附件(§十三「存量资源全部归初始管理员」)。两半都要做:
 *   · 自用模式传上来的文件**已经登记过**了,只是归属为 null(那时没有实名用户) ——
 *     跟其它表一样一次 UPDATE 填成管理员;
 *   · 从没登记过的(功能上线前上传的)按目录逐个补登记。
 *
 * 两半都顺带按**任务正文**回填 taskId:老任务里创建时带的附件路径就写在 body 里,
 * 回填之后项目成员照常看得见那些截图 —— 不回填的话它们全成了「只有管理员打得开」。
 * 幂等:已经有归属的行不动。
 */
export async function claimExistingUploads(userId: string): Promise<number> {
  const files = await readdir(UPLOADS_DIR).catch(() => [] as string[]);
  const rows = await db.select().from(uploads);
  const known = new Map(rows.map((row) => [row.file, row] as const));
  const pending = files.filter((file) => !known.has(file));
  const orphanRows = rows.filter((row) => !row.ownerUserId || !row.taskId);
  if (!pending.length && !orphanRows.length) return 0;
  // 一次扫完任务正文建反向索引,别对每个文件各扫一遍(存量库两边都是上千条)。
  // 正文里的路径后面可能紧跟着中文说明(没有分隔符),所以夹在正文里的那种引用要按
  // **本机已知的名字**收敛一下,否则这批文件的 taskId 回填不上。已知 = 盘上有 ∪ 有
  // 登记行(文件被删、行还在的也得认得出自己属于哪条任务)。占满一个字段的引用
  // (附件块那种 `- <绝对路径>` 行)只认精确名字 —— 正文里写明一条已经没了的长路径时,
  // 按前缀收敛会把它算成另一份短名字附件的归属。判据见 upload-names.ts。
  const index = uploadNameIndex([...files, ...known.keys()]);
  const byFile = new Map<string, string>();
  for (const task of await db.select({ id: tasks.id, body: tasks.body }).from(tasks)) {
    for (const ref of scanUploadRuns(task.body)) {
      const name = uploadRunCandidates(ref, index).find((candidate) => index.has(candidate));
      if (name && !byFile.has(name)) byFile.set(name, task.id);
    }
  }
  const at = now();
  if (pending.length) {
    // claimOrigin='conversion':这批 owner 是统一代管出来的,不是本人上传 —— 日后可信产物
    // 清单读到它属于哪个任务时允许补 taskId(registerUpload 的 migrated 分支)。
    await db.insert(uploads).values(pending.map((file) => ({
      file,
      ownerUserId: userId,
      taskId: byFile.get(file) ?? null,
      claimOrigin: "conversion",
      createdAt: at,
    })));
  }
  for (const row of orphanRows) {
    const patch: { ownerUserId?: string; taskId?: string; claimOrigin?: string } = {};
    // 补 owner 的同时打上代管标记;只补 taskId 的行已有真 owner,不打(它的归属来源没变)。
    if (!row.ownerUserId) {
      patch.ownerUserId = userId;
      patch.claimOrigin = "conversion";
    }
    if (!row.taskId && byFile.has(row.file)) patch.taskId = byFile.get(row.file)!;
    if (Object.keys(patch).length) await db.update(uploads).set(patch).where(eq(uploads.file, row.file));
  }
  return pending.length + orphanRows.length;
}
