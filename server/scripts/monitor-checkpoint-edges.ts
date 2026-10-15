// 检查点的**边界条件**那一半:读取层的缺口(⑨⑫⑭⑮)、删除与作废把账留对(⑩⑪⑬)。
//
// 为什么跟 `test-claude-monitor-checkpoint.ts` 分开:那份钉的是「位置停在哪、前缀的关联怎么
// 配回来」,这份钉的是「读不到/读不全/读过的被删了,账面怎么说」。两份共用同一套夹具
// (`monitor-checkpoint-harness.ts`),由那份脚本按顺序驱动 —— 合在一个文件里是 762 行,
// 超过单文件 700 行的约定(全局约定;第 12 轮审查 F2 也是这条)。
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  LIMIT, db, dbClient, schema, sessions, monitors, tasks,
  backfillClaudeMonitors, monitorRecoveryOf, listMonitors, check,
  line, liveProcess, fixture, bytes, padLines,
  call, started, receipt, notice,
} from "./monitor-checkpoint-harness.js";

export async function edgeGroups(): Promise<void> {
  // ── ⑨ 一条**比读取窗口还长**的记录不许把整个文件卡死 ───────────────────────────
  //
  // 窗口内一个换行都没有 ⇒ 位置零进展，下一轮同样的输入同样读不出换行：这个文件之后的内容
  // 和后面所有 run 文件永远读不到（第 11 轮审查 N3 的上半；本轮自测时 ⑦⑧ 的第一版夹具正好
  // 造出了这一条，两组都停在第一个窗口里）。那条记录在这个窗口下无论如何都解析不了，所以
  // 跳过它、位置继续往前 —— 丢一条事件，换这个文件剩下的部分都读得到。
  {
    const f = await fixture("oversized-record");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    // 一条 1.5 个窗口长的文本事件（合法 JSON，就是太长）
    body += line({ type: "assistant", timestamp: "2026-10-15T09:00:00.000Z",
      message: { content: [{ type: "text", text: "y".repeat(LIMIT + LIMIT / 2) }] } });
    const tailAt = bytes(body);
    body += call(f.cli, "tu-bover", "超长记录后面的哨兵", "2026-10-15T09:10:00.000Z");
    body += started(f.cli, "tu-bover", "bover");
    body += receipt("tu-bover", "bover", "2026-10-15T09:10:00.040Z");
    body += notice(f.cli, "bover");
    writeFileSync(f.file, body);
    check(tailAt > LIMIT, "⑨夹具里那条记录确实比窗口长", `${tailAt} > ${LIMIT}`);

    let rounds = 0;
    const seen = new Set<string>();
    for (; rounds < 6; rounds += 1) {
      await backfillClaudeMonitors(f.taskId);
      for (const r of monitorRecoveryOf(f.taskId)?.reasons ?? []) seen.add(r);
      if ((await listMonitors(f.taskId)).length) break;
    }
    // 跳掉的那条里**可能**带着 Monitor 的入参或回执,所以跳的那一轮不许按「读全了」收尾:
    // 账上要说得出这个缺口(第 13 轮审查 N3)。
    check(seen.has("record-skipped"), "⑨跳过那一轮账上说得出「有记录被跳过」",
      [...seen].join(",") || "(账本一直是空的)");
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "bover",
      "⑨跳过那条超长记录之后，它后面的 Monitor 读到了",
      `${rounds + 1} 轮后 ${rows.length} 条`);
    check(rows[0]?.status === "exited", "⑨终态也在", String(rows[0]?.status));
    check(rounds + 1 <= 3, "⑨而且没有反复重读同一段", `${rounds + 1} 轮`);
    // **缺口的账不随下一轮干净扫描清掉**(第 14 轮审查 N1)。这个窗口下那条记录无论如何都
    // 解析不了,在窗口变大把它补回来之前,「有一条事实没读到」一直成立——上一版是跳过的下
    // 一轮就销账,于是账面干净、而那条事实永远没回来。
    for (let i = 0; i < 3; i += 1) await backfillClaudeMonitors(f.taskId);
    check((monitorRecoveryOf(f.taskId)?.reasons ?? []).includes("record-skipped"),
      "⑨之后每一轮账上都还留着这个缺口（没被干净的一轮清掉）",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
  }


  // ── ⑩ 删任务时未决行也要跟着走（没有别的入口能清它）─────────────────────────────
  {
    const f = await fixture("delete-cascade");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += call(f.cli, "tu-bleft", "只剩调用的那条", "2026-10-15T10:00:00.000Z");
    writeFileSync(f.file, body);
    await backfillClaudeMonitors(f.taskId);
    const before = await db.select().from(schema.monitorPendingCalls)
      .where(eq(schema.monitorPendingCalls.taskId, f.taskId));
    check(before.length === 1, "⑩先确认库里真有一条未决行", String(before.length));
    const { deleteTaskAssociations } = await import("../src/task-delete-routes.js");
    await deleteTaskAssociations(f.taskId);
    const after = await db.select().from(schema.monitorPendingCalls)
      .where(eq(schema.monitorPendingCalls.taskId, f.taskId));
    check(after.length === 0, "⑩删任务把它一起带走了", String(after.length));
    // **再读一轮**：删除只清了库的话，按 taskId 缓着的那份扫描状态还留着上一轮悬着的调用，
    // 这一轮提交完就会把它重新插回去 —— 一条再也没有入口能清的孤儿行（第 12 轮审查 N5）。
    // 删除那一侧要连扫描状态、位置、恢复责任一起作废。
    await backfillClaudeMonitors(f.taskId);
    const revived = await db.select().from(schema.monitorPendingCalls)
      .where(eq(schema.monitorPendingCalls.taskId, f.taskId));
    check(revived.length === 0, "⑩删完之后再读一轮，旧桶里那条不会被写回来",
      JSON.stringify(revived));
    check(monitorRecoveryOf(f.taskId) === null, "⑩删除也把它的恢复责任作废了（不会一直自动重推）",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
  }

  // ── ⑪ 删除撞上正在跑的那一轮：旧扫描不许把删掉的东西写回来 ─────────────────────
  //
  // ⑩ 是「先删完、再读一轮」。真实请求不排队：删除可以正好落在某一轮的 await 里——那一轮
  // 的会话清单、配对状态、悬着的调用全是删除之前读到的事实，照常写下去就是投影行、未决行、
  // 读取位置各留一条**再也没有入口能清**的孤儿（任务都没了，面板上根本看不到它）。
  // 第 13 轮审查用屏障实测：删除当刻三张表都是 0，旧扫描跑完又各回来一条。
  //
  // 这里用同一个屏障复现：卡在「会话查完、还没交还给扫描」那一刻执行真正的删除入口。
  {
    const f = await fixture("delete-inflight");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += call(f.cli, "tu-inflight", "删除撞上的那条", "2026-10-15T11:00:00.000Z");
    body += started(f.cli, "tu-inflight", "binflight");
    body += padLines("", LIMIT * 2); // 两个窗口：这一轮读不完，会留账也会落位置
    writeFileSync(f.file, body);

    const real = dbClient.execute.bind(dbClient);
    let reached!: () => void;
    let resume!: () => void;
    const selected = new Promise<void>((r) => { reached = r; });
    const barrier = new Promise<void>((r) => { resume = r; });
    let paused = false;
    (dbClient as any).execute = async (stmt: any) => {
      const result = await real(stmt);
      const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
      if (!paused && /from "sessions"/i.test(sql) && JSON.stringify(stmt?.args ?? []).includes(f.taskId)) {
        paused = true;
        reached();
        await barrier;
      }
      return result;
    };
    const job = backfillClaudeMonitors(f.taskId);
    await selected;
    const { deleteTaskAssociations } = await import("../src/task-delete-routes.js");
    try {
      await deleteTaskAssociations(f.taskId);
      await db.delete(tasks).where(eq(tasks.id, f.taskId));
    } finally { resume(); }
    await job;
    (dbClient as any).execute = real;

    const leftovers = {
      monitors: (await db.select().from(monitors).where(eq(monitors.taskId, f.taskId))).length,
      pending: (await db.select().from(schema.monitorPendingCalls)
        .where(eq(schema.monitorPendingCalls.taskId, f.taskId))).length,
      cursors: (await db.select().from(schema.monitorScanCursors)
        .where(eq(schema.monitorScanCursors.taskId, f.taskId))).length,
    };
    check(leftovers.monitors === 0 && leftovers.pending === 0 && leftovers.cursors === 0,
      "⑪删除撞上在途的那一轮，三张表都没留下孤儿行", JSON.stringify(leftovers));
    check(monitorRecoveryOf(f.taskId) === null,
      "⑪也没给一个已经删掉的任务留恢复责任（否则定时器会一直推它）",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
  }

  // ── ⑫ 末行没写完 / 一条比预算还长：**不许当成读完了** ──────────────────────────
  //
  // 这两条是第 13 轮审查 N3 的另外两半。共同形状仍是老问题:「我手上没有这条事实」被当成
  // 「这条事实不成立」—— 位置停在半行之前是对的,错在之后一声不吭地销账,于是最后一条完成
  // 通知要等用户自己再打开一次面板才会被读到。
  {
    // (a) 文件尾是半行:这一轮读不到它,但账上要留着。
    const f = await fixture("partial-tail");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += call(f.cli, "tu-btail", "末行还没写完", "2026-10-15T12:00:00.000Z");
    body += started(f.cli, "tu-btail", "btail");
    body += receipt("tu-btail", "btail", "2026-10-15T12:00:00.040Z");
    // 完成通知**只写了一半**(没有换行符)——正在被追加的文件就长这样。
    const tail = line({ type: "system", subtype: "task_notification", task_id: "btail",
      status: "completed", summary: "来源确认完成", session_id: f.cli }).trimEnd();
    writeFileSync(f.file, body + tail);
    await backfillClaudeMonitors(f.taskId);
    check((monitorRecoveryOf(f.taskId)?.reasons ?? []).includes("tail-incomplete"),
      "⑫(a) 末行没写完 → 账上留着未读提示",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
    check((await listMonitors(f.taskId)).length === 1, "⑫(a) 半行之前那条照常读到了");

    writeFileSync(f.file, body + tail + "\n");   // 写完它
    await backfillClaudeMonitors(f.taskId);
    check((await listMonitors(f.taskId)).at(0)?.status === "exited",
      "⑫(a) 写完之后那条终态读到了", String((await listMonitors(f.taskId)).at(0)?.status));
    check(monitorRecoveryOf(f.taskId) === null, "⑫(a) 这时才销账",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
  }
  {
    // (c) 对照:会话**还活着**时,半行是常态——不记账。记了就是让退避定时器每秒重扫一个
    // 正在被写的文件,而且每轮都读到新字节、退避预算永远清零(那正是第 8 轮审查修过的病)。
    const proc = liveProcess();
    const f = await fixture("live-tail", proc.pid, proc.startedAt);
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += call(f.cli, "tu-blive", "活着的会话", "2026-10-15T12:30:00.000Z");
    body += started(f.cli, "tu-blive", "blive");
    body += line({ type: "assistant", timestamp: "2026-10-15T12:30:01.000Z",
      message: { content: [{ type: "text", text: "写了一半" }] } }).trimEnd();
    writeFileSync(f.file, body);
    await backfillClaudeMonitors(f.taskId);
    check(monitorRecoveryOf(f.taskId) === null,
      "⑫(c) 会话还活着时那半行是常态,不留账", JSON.stringify(monitorRecoveryOf(f.taskId)));
    proc.kill();
  }
  {
    // (b) 找换行也有工作预算:比预算还长就不再往下扫。
    //
    // 预算限的是**每轮的工作量**,不是这个文件的可读性上限:找到哪儿了要落盘,下一轮从那儿
    // 接着找(第 14 轮审查 N1)。上一版没有续查位置,于是每轮都从同一处重扫同样的预算、同样
    // 找不到——「有预算」就成了「这条记录后面的内容永远读不到」。
    // 生产窗口 128 MiB ⇒ 每轮预算 512 MiB,一条真实日志行到不了那个量级。
    const f = await fixture("beyond-budget");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += line({ type: "assistant", timestamp: "2026-10-15T13:00:00.000Z",
      message: { content: [{ type: "text", text: "z".repeat(LIMIT * 5) }] } });
    body += call(f.cli, "tu-bbudget", "预算之外的哨兵", "2026-10-15T13:10:00.000Z");
    body += started(f.cli, "tu-bbudget", "bbudget");
    body += notice(f.cli, "bbudget");
    writeFileSync(f.file, body);
    await backfillClaudeMonitors(f.taskId);
    check((await listMonitors(f.taskId)).length === 0,
      "⑫(b) 第一轮的预算确实不够找到那条记录的结尾");
    check((monitorRecoveryOf(f.taskId)?.reasons ?? []).includes("scan-unfinished"),
      "⑫(b) 而且照实说「还没读完」,不是静悄悄销账", JSON.stringify(monitorRecoveryOf(f.taskId)));
    for (let i = 0; i < 4; i += 1) await backfillClaudeMonitors(f.taskId);
    const budgetRows = await listMonitors(f.taskId);
    check(budgetRows.length === 1 && budgetRows[0]?.status === "exited",
      "⑫(b) 再给几轮,续查位置把结尾找出来了,它后面的内容照样读得到",
      `${budgetRows.length} 条 / ${budgetRows[0]?.status}`);
    check((monitorRecoveryOf(f.taskId)?.reasons ?? []).includes("record-skipped"),
      "⑫(b) 跳过的那条仍然留着缺口的账", JSON.stringify(monitorRecoveryOf(f.taskId)));
  }

  // ── ⑬ 作废位置失败时:**那份位置不许接着用** ───────────────────────────────────
  //
  // 回退路径(读失败、裁不清要重放)要做两件事:登记责任、把库里那份位置作废。位置作废走的是
  // 数据库,而要作废的时机多半正是数据库刚出过问题的时候。清不掉就当「那就接着用」的话,这
  // 一轮本来要重读的那一段被永久跳过 —— 比没清更糟(第 14 轮审查 F1 的后半句)。
  {
    const f = await fixture("stale-cursor");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body = padLines(body, LIMIT + 1024);              // 第一轮只读得完第一个窗口
    body += call(f.cli, "tu-bstale", "第二个窗口里的哨兵", "2026-10-15T14:00:00.000Z");
    body += started(f.cli, "tu-bstale", "bstale");
    body += notice(f.cli, "bstale");
    writeFileSync(f.file, body);

    await backfillClaudeMonitors(f.taskId);
    const cursorsOf = async () => await db.select().from(schema.monitorScanCursors)
      .where(eq(schema.monitorScanCursors.taskId, f.taskId));
    const first = (await cursorsOf())[0]?.readOffset ?? 0;
    check(first > 0, "⑬第一轮确实落了一个位置", String(first));

    // 第二轮:提交写失败(走回退) + 作废位置也失败(F1 的组合)。
    const real = dbClient.execute.bind(dbClient);
    let down = true;
    (dbClient as any).execute = async (stmt: any) => {
      const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
      if (down && /insert into "monitors"|delete from "monitor_scan_cursors"/i.test(sql)) {
        throw new Error("INJECTED_DB_DOWN");
      }
      return real(stmt);
    };
    try {
      await backfillClaudeMonitors(f.taskId);
      check(monitorRecoveryOf(f.taskId)?.pending === true, "⑬失败这一轮留下了责任",
        JSON.stringify(monitorRecoveryOf(f.taskId)));
      check((await cursorsOf()).length > 0,
        "⑬而且库里那份位置确实没删掉(清理失败了)");
    } finally { down = false; (dbClient as any).execute = real; }

    // 第三轮:数据库好了。那份位置是**作废过的**,不许当成已确认位置接着往后读。
    await backfillClaudeMonitors(f.taskId);
    const after = (await cursorsOf())[0]?.readOffset ?? 0;
    check(after <= LIMIT, "⑬作废过的位置没被接着用,这一轮从零重读", `${first} → ${after}`);
    let rounds = 0;
    for (; rounds < 6 && (await listMonitors(f.taskId)).length === 0; rounds += 1) {
      await backfillClaudeMonitors(f.taskId);
    }
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.status === "exited",
      "⑬重读之后第二个窗口里那条照样读得到", `${rows.length} 条`);
  }

  // ── ⑭ 跳过的那条**正是完成通知**:缺口的账要留着,窗口够大了要补回来 ──────────────
  //
  // 审查实测的形状(第 14 轮 N1):完成通知的 summary 约 45 KiB、超过当时的读取窗口,于是被
  // 整条跳过 —— 第 3 轮起账面干净,而那张卡永远停在 `lost`。「我没读到」被写成了「它没结束」。
  {
    const f = await fixture("skipped-completion");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += call(f.cli, "tu-bskip", "完成通知超长的哨兵", "2026-10-15T15:00:00.000Z");
    body += started(f.cli, "tu-bskip", "bskip");
    body += receipt("tu-bskip", "bskip", "2026-10-15T15:00:00.040Z");
    // 完成通知本身比窗口还长(真实形状:summary 很长)。
    body += line({ type: "system", subtype: "task_notification", task_id: "bskip",
      status: "completed", summary: "x".repeat(LIMIT + LIMIT / 2), session_id: f.cli });
    writeFileSync(f.file, body);

    for (let i = 0; i < 5; i += 1) await backfillClaudeMonitors(f.taskId);
    const before = await listMonitors(f.taskId);
    check(before.length === 1 && before[0]?.status !== "exited",
      "⑭完成通知被跳过时,卡确实还不是 exited", `${before.length} 条 / ${before[0]?.status}`);
    check((monitorRecoveryOf(f.taskId)?.reasons ?? []).includes("record-skipped"),
      "⑭而账上一直说得出「有一条记录没读到」(不是第 3 轮起就干净了)",
      JSON.stringify(monitorRecoveryOf(f.taskId)));

    // 窗口变大(生产是 128 MiB,这里模拟改配置重启):缺口要被补回来,不是永远留着。
    const saved = process.env.ASH_MONITOR_SCAN_MAX_BYTES;
    process.env.ASH_MONITOR_SCAN_MAX_BYTES = String(LIMIT * 8);
    try {
      await backfillClaudeMonitors(f.taskId);
      const after = await listMonitors(f.taskId);
      check(after.length === 1 && after[0]?.status === "exited",
        "⑭窗口装得下它的那一轮回去重读,终态补上了", `${after.length} 条 / ${after[0]?.status}`);
      check(monitorRecoveryOf(f.taskId) === null, "⑭这时缺口才销账",
        JSON.stringify(monitorRecoveryOf(f.taskId)));
    } finally {
      if (saved === undefined) delete process.env.ASH_MONITOR_SCAN_MAX_BYTES;
      else process.env.ASH_MONITOR_SCAN_MAX_BYTES = saved;
    }
  }

  // ── ⑮ 「这个文件还在被写吗」按 run 判,不按整条会话的进程判 ──────────────────────
  //
  // 会话活着只说明**最后那个** run 文件还在被追加;之前那些早就封存了。拿会话存活去代替
  // 文件封存,旧文件末尾的半行就成了无声的拦路虎:它照样把后面的 run 文件挡住(因果顺序),
  // 账上却什么都没有 —— 停滞且不声张(第 14 轮审查 N1)。
  {
    const proc = liveProcess();
    const f = await fixture("sealed-old-run", proc.pid, proc.startedAt);
    // 旧 run:末尾是半行(那一回合被杀,文件就这样封存了)。
    writeFileSync(f.runFile("20261015T020000000Z"),
      line({ type: "system", subtype: "init", session_id: f.cli })
      + line({ type: "assistant", timestamp: "2026-10-15T16:00:00.000Z",
        message: { content: [{ type: "text", text: "写了一半" }] } }).trimEnd());
    // 新 run:还活着,里面有一条完整的监听。
    const latest = f.runFile("20261015T030000000Z");
    writeFileSync(latest,
      line({ type: "system", subtype: "init", session_id: f.cli })
      + call(f.cli, "tu-bseal", "新一代里的哨兵", "2026-10-15T17:00:00.000Z")
      + started(f.cli, "tu-bseal", "bseal"));
    await db.update(sessions).set({ agentOutPath: latest }).where(eq(sessions.id, `s-${f.taskId}`));

    await backfillClaudeMonitors(f.taskId);
    check((monitorRecoveryOf(f.taskId)?.reasons ?? []).includes("tail-incomplete"),
      "⑮封存的旧 run 末尾那半行照实留账(会话还活着也一样)",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
    proc.kill();
  }

}
