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
import { eq, inArray } from "drizzle-orm";
import { basename } from "node:path";
import { db } from "./db/index.js";
import { tasks, uploads } from "./db/schema.js";
import { UPLOADS_DIR } from "./paths.js";
import { scanUploadNames } from "./handoff-uploads.js";
import type { Actor } from "./auth/context.js";
import { isAdminActor } from "./auth/context.js";
import { isMultiUser } from "./auth/mode.js";
import { visibleTaskIds } from "./auth/visibility.js";
import { now } from "./util.js";

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

/** 登记一个新写下的附件。同名再登记不覆盖归属(先到先得,后面的只补空位)。 */
export async function registerUpload(
  file: string,
  fields: { ownerUserId?: string | null; taskId?: string | null } = {},
): Promise<void> {
  const name = uploadFileName(file);
  if (!name) return;
  const existing = (await db.select().from(uploads).where(eq(uploads.file, name))).at(0);
  if (!existing) {
    await db.insert(uploads).values({
      file: name,
      ownerUserId: fields.ownerUserId ?? null,
      taskId: fields.taskId ?? null,
      createdAt: now(),
    });
    return;
  }
  // 只补空位:已经有归属的行不许被后来的写入改掉(见 bindUploadsToTask 的越权推演)。
  // **补 taskId 同样是在改授权面** —— 给别人的私有文件补一条任务 id,等于把它敞开给
  // 那条任务看得见的所有人。所以补空位也要先认人:行是无主的,或者本来就是这次声明
  // 的这个人的。接力导入曾借这一句把同名的私有行挂到接力任务上(第 5 轮审查 P1)。
  const patch: { ownerUserId?: string; taskId?: string } = {};
  if (!existing.ownerUserId && fields.ownerUserId) patch.ownerUserId = fields.ownerUserId;
  const mine = !existing.ownerUserId || existing.ownerUserId === fields.ownerUserId;
  if (!existing.taskId && fields.taskId && mine) patch.taskId = fields.taskId;
  if (Object.keys(patch).length) await db.update(uploads).set(patch).where(eq(uploads.file, name));
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

/** agent 自己产出的图(工具结果截图之类)。没有上传者,归它跑的那个任务。 */
export function noteAgentUpload(taskId: string, path: string): void {
  void registerUpload(path, { taskId }).catch((error) => {
    // 登记失败只影响别人能不能在界面上看到这张图,不该动摇这一轮的产出。
    console.warn("[ash] 附件归属登记失败:", error);
  });
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
  const byFile = new Map<string, string>();
  for (const task of await db.select({ id: tasks.id, body: tasks.body }).from(tasks)) {
    for (const name of scanUploadNames(task.body)) if (!byFile.has(name)) byFile.set(name, task.id);
  }
  const at = now();
  if (pending.length) {
    await db.insert(uploads).values(pending.map((file) => ({
      file,
      ownerUserId: userId,
      taskId: byFile.get(file) ?? null,
      createdAt: at,
    })));
  }
  for (const row of orphanRows) {
    const patch: { ownerUserId?: string; taskId?: string } = {};
    if (!row.ownerUserId) patch.ownerUserId = userId;
    if (!row.taskId && byFile.has(row.file)) patch.taskId = byFile.get(row.file)!;
    if (Object.keys(patch).length) await db.update(uploads).set(patch).where(eq(uploads.file, row.file));
  }
  return pending.length + orphanRows.length;
}
