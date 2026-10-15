// 悬着的 Monitor 调用（读到了 `tool_use`、还没配上 `task_started`）的**落盘与恢复**。
//
// 为什么非落盘不可：那一行是**入参的唯一出处**（命令、说明），而身份要等下一行才有。上一版
// 把这段状态只放内存，靠「读取位置绝不越过一条还悬着的调用」来保证那一行可以重放 —— 代价是
// 位置会被**永远不会完结的调用**钉死：
//
//   - 启动被拒 / 校验失败：有 `is_error` 回执，但**没有** `task_started`
//   - 进程在那一行之后被杀：连回执都没有
//
// 于是每一轮都从那一行重读同一个窗口，末尾的 Monitor 永远读不到（第 11 轮审查实测：12 轮
// 固定输入，`blast` 一次都没出现；第 8～10 轮是同一类的前几个实例）。
//
// 落盘之后分工干净：
//   - **位置**只管单调往前（`claude-monitor-backfill.ts` 的 `checkpointCursors`）
//   - **悬着的调用**由这张表独立恢复，不受内存上限和读取窗口影响
//   - 「`task_started` 配不上任何调用 ⇒ 那个工具不是 Monitor」这条推理照旧成立，因为悬着的
//     调用一定在（内存里或这张表里），不再依赖「位置没越过它」
//
// ── 一条调用的身份是 (任务, ash 会话, **来源**, tool_use 号) ───────────────────
//
// 来源那一维不能省：一条 ash 会话跨好几个 run 文件（每回合一个），而 tool_use 号只在**一条
// CLI 会话**内唯一。省掉它的后果在这张表上特别重，因为这里存的是**入参的唯一出处**，不是
// 可以重算的缓存 —— 两轮撞号时，一边是「第二条根本插不进来」（唯一键吞掉），一边是「新一轮
// 成行把旧一轮那条删了」（销账条件太粗），两边都让旧那张卡永久消失，而读取位置照常被确认成
// 「读完了」。判据本体在 `claude-monitor-identity.ts`，这里只许调它。
import { and, eq, inArray } from "drizzle-orm";
import type { MonitorCall } from "./claude-monitor-call.js";
import { matchBySource, type SourceRow } from "./claude-monitor-identity.js";
import { orphanRows, writeIfTaskAlive } from "./claude-monitor-write.js";
import { db } from "./db/index.js";
import { monitorPendingCalls, monitors } from "./db/schema.js";

/**
 * 一条语句最多带多少行（或多少个 id）。
 *
 * sqlite 的绑定变量有上限（本机 node:sqlite 是 250000，别的平台构建出来的不一定一样），
 * 而这张表的行数虽然天然有界，界在「每个 run 文件至多一条长期悬着的」——历史很长的任务
 * 总 run 数没有硬上限。顶爆的后果不是一行写不进去，而是**整轮 discard + 留账，下一轮重读
 * 又攒出同样大的一批**，永远过不去（第 12 轮审查 N6）。分批写的代价只是多几条语句。
 */
const BATCH = 200;

const batches = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
};

export type PendingCall = {
  /** 读到它的那条 ash 会话 id（`pending` 按会话分区）。 */
  sessionKey: string;
  toolUseId: string;
  call: MonitorCall;
  /** 那条 assistant 事件的时刻 = 起点区间的下界。 */
  at: string | null;
  /**
   * **调用发生时**那一行报的 CLI 身份（认不出来就是 null —— 不是通配符）。
   *
   * 不是 `sessions.cli_session_id`：那个只记得**当前**那一个，resume 之后旧 run 文件里的
   * 调用会跟着改姓（见文件头的身份说明）。
   */
  cliSessionId: string | null;
  /** 读到它的那个 run 文件。未知归属**唯一**能自证的凭据，也是持久键的一维。 */
  sourceRun: string;
};

/**
 * 已经完结、该从表里销掉的调用（配上了 `task_started`，或确证起不来）。
 *
 * 三样都要：会话、**来源**、tool_use 号。少了来源那一维，一轮的销账就会把另一轮同号的那条
 * 一起删掉 —— 而那一行是它入参的唯一出处（见文件头）。
 */
export type ClearedCall = { sessionKey: string; sourceRun: string; toolUseId: string };

/**
 * 按 (会话, 来源, tool_use) 删除 —— **删除条件就是持久键本身**。
 *
 * 按会话 + 号删（不带来源）等于把同一条 ash 会话里另一个 run 文件的同号调用也带走；只按号
 * 删还会跨会话。两种都试过，后果一样：那条调用唯一的恢复依据消失，它那张卡再也出不来。
 */
async function deleteCalls(taskId: string, calls: readonly ClearedCall[]): Promise<void> {
  const groups = new Map<string, { sessionKey: string; sourceRun: string; ids: string[] }>();
  for (const item of calls) {
    const key = `${item.sessionKey}\u0000${item.sourceRun}`;
    const slot = groups.get(key) ?? { sessionKey: item.sessionKey, sourceRun: item.sourceRun, ids: [] };
    slot.ids.push(item.toolUseId);
    groups.set(key, slot);
  }
  for (const slot of groups.values()) {
    for (const batch of batches(slot.ids)) {
      await db.delete(monitorPendingCalls).where(and(
        eq(monitorPendingCalls.taskId, taskId),
        eq(monitorPendingCalls.sessionKey, slot.sessionKey),
        eq(monitorPendingCalls.sourceRun, slot.sourceRun),
        inArray(monitorPendingCalls.toolUseId, batch),
      ));
    }
  }
}

/** 库里那一行（销账判据只问这几列）。 */
type PendingRow = {
  sessionKey: string; toolUseId: string; cliSessionId: string | null; sourceRun: string;
};

/** 按会话分桶（`scanSession` 新建会话桶时取它）。 */
export async function loadPendingCalls(taskId: string): Promise<Map<string, PendingCall[]>> {
  const rows = await db.select().from(monitorPendingCalls)
    .where(eq(monitorPendingCalls.taskId, taskId));
  const out = new Map<string, PendingCall[]>();
  if (!rows.length) return out;
  // **自愈**：已经成行的那些（库里有同一个 `tool_use_id` 的 Monitor）早就配上了，只是当初
  // 那一笔删除没落地（提交成功、紧接着写失败）。留着不会让显示出错，但会一直被读回来 ——
  // 就地清掉，免得越积越多。
  //
  // **「同一个 tool_use_id」要连来源一起问，而且用的是和认行同一个判据**
  // （`matchBySource`，见 claude-monitor-identity.ts）：
  //   - 来源对得上（两边都知道且相等）⇒ 就是它，照常销账；
  //   - 对不上时只认**能被证明是我的**：库里那一行记的 `source_run` 跟我这条一样（一个 run
  //     文件 = 一次进程启动），而且它的归属不与我矛盾。
  //
  // 三条都不成立就**不许销账**。此前这里是另一套判据：拿**当前** `sessions.cli_session_id`
  // 反推旧调用的归属（resume 之后它换号，旧调用就跟着改姓），再把两个 NULL 拼成同一个空串
  // （两个「不知道」被当成同一个来源）。实测后果：同一个 tool_use 号在两轮之间撞上时，新一轮
  // 成行把旧一轮还悬着的那条删了，而那一行是它入参的唯一出处 —— 旧卡永久缺一张，读取位置却
  // 照常被确认成「读完了」（新一轮第 1 轮审查 F1）。
  //
  // 代价只是这一行会被反复读回来（留着不会让显示出错，见上），比毁掉恢复依据便宜得多：宁可
  // 留着未决责任，也不拿一条证明不了的证据销账。连 `source_run` 都没有的存量行从此谁也证明
  // 不了，于是永远留着 —— 键上每个 (会话, 来源, 号) 至多一行，有界。
  const byTool = new Map<string, SourceRow[]>();
  for (const row of await db
    .select({
      toolUseId: monitors.toolUseId,
      cliSessionId: monitors.cliSessionId,
      sourceRun: monitors.sourceRun,
    })
    .from(monitors)
    .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "claude")))) {
    if (!row.toolUseId) continue;
    byTool.set(row.toolUseId, [...(byTool.get(row.toolUseId) ?? []), row]);
  }
  const isSettled = (row: PendingRow): boolean =>
    !!matchBySource(byTool.get(row.toolUseId) ?? [], {
      cliSessionId: row.cliSessionId, sourceRun: row.sourceRun,
    });
  await deleteCalls(taskId, rows.filter(isSettled));
  for (const row of rows) {
    if (isSettled(row)) continue;
    const bucket = out.get(row.sessionKey) ?? [];
    bucket.push({
      sessionKey: row.sessionKey, toolUseId: row.toolUseId,
      call: { command: row.command, description: row.description },
      at: row.at, cliSessionId: row.cliSessionId, sourceRun: row.sourceRun,
    });
    out.set(row.sessionKey, bucket);
  }
  return out;
}

/**
 * 把这一轮的未决状态落下来：完结的删掉、还悬着的补上。
 *
 * **只在确认提交之后调用**（见 `TaskScan.committedThrough`）：没提交的那几条路会回退读取
 * 位置、把那些行重新读一遍，这时落盘只会留下一份马上又会被重建的拷贝。
 *
 * 写入用 `onConflictDoNothing`：同一条调用的内容来自同一行不变的日志，重复读到它（文件被
 * 重写、位置回退）时没有任何字段需要更新。它靠的是 `(task_id, session_key, source_run,
 * tool_use_id)` 这个唯一键 —— **两条建库路径都得有**（见 db/schema-monitors.ts）。
 *
 * **来源必须在键里。** 少了它，两个 run 文件里的同号调用争同一个键：第二条被
 * `onConflictDoNothing` 吞掉，它的入参于是只剩下别人那一份，而那一份一销账就什么都不剩了
 * （新一轮第 1 轮审查 F1）。
 */
export async function syncPendingCalls(
  taskId: string, pending: readonly PendingCall[], cleared: readonly ClearedCall[],
): Promise<void> {
  await deleteCalls(taskId, cleared);
  for (const batch of batches(pending)) {
    // 落库资格跟插入同批（见 claude-monitor-write.ts）：门闸只在进入这个函数时问过一次。
    await writeIfTaskAlive(
      db.insert(monitorPendingCalls)
        .values(batch.map((item) => ({
          taskId, sessionKey: item.sessionKey, toolUseId: item.toolUseId,
          command: item.call.command, description: item.call.description,
          at: item.at, cliSessionId: item.cliSessionId, sourceRun: item.sourceRun,
        })))
        .onConflictDoNothing(),
      db.delete(monitorPendingCalls).where(orphanRows(monitorPendingCalls, taskId)),
    );
  }
}
