// 「读另一条任务说过的话」。与另外两组工具的分界还是**作用对象**：orchestrate 摆布一批
// 活怎么组织，task-turn 是一条任务在自己回合里对 ash 说什么，这里是**旁观别人**——
// 只读，不碰任何任务的状态。
//
// 之所以要有它：会话正文一直在 ash 的 HTTP API 上（`/tasks/:id/sessions` +
// `/sessions/:id/output`，web 和 mobile 都读它),但 MCP 工具清单里没有对应的入口,而
// 工具清单是 agent 唯一会主动读的目录。于是 agent 拿到别的任务 id 时只会得出「ash 没
// 提供这个能力」,转头去翻 `~/.claude/projects` 下 CLI 自己的落盘文件——那条路只对
// claude 成立(codex 的 rollout 格式和路径都不同),而且得先知道 cwd 和 cliSessionId,
// 而这两个值恰恰来自这里要调的那个端点。
//
// 解析复用 shared 的 `parseSessionOutput`(web/mobile 同一份):**界面上能看到什么,
// 这里就读到什么**,两边不会漂。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseSessionOutput } from "@ash/shared";
import { call, callText, fail, ok } from "../runtime.js";

type TaskRow = Record<string, unknown>;
type SessionRow = {
  id: string; role?: string; agentType?: string; executor?: string;
  startedAt?: string | null; endedAt?: string | null; turnStartedAt?: string | null; sideTurn?: boolean | null;
  turnModel?: string | null; cwd?: string | null; branch?: string | null;
};
type TraceEntry = { at: string; turnStartedAt: string; event: Record<string, unknown> };

const DEFAULT_MAX_CHARS = 30_000;
const SEP = "\n\n---\n\n";
// 任务指令放不下这么多就整条省掉:半句指令比没有更容易让人误会任务在要求什么。
const HEAD_BODY_MIN = 120;
// maxChars 的下限。比这还小的话,连「为什么读不到、该怎么读」这句说明都放不下,
// 返回什么都只能超过调用方自己定的上限 —— 那种请求本身就不可满足,挡在入口更干净。
const MIN_MAX_CHARS = 200;

// 落盘的 at 是 ISO UTC。读的人在本机，给本地时间——让 agent 自己换算时区是白耗一轮。
function local(at?: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderSegments(raw: string): string {
  const segs = parseSessionOutput(raw);
  if (!segs.length) return "（这条会话还没有落下任何正文）";
  return segs.map((seg) => {
    if (seg.kind === "agent") return `【agent】\n${seg.text}`;
    const at = local(seg.at);
    if (seg.kind === "user") {
      // bySystem：占着真人回合、但字是后端写的（验证打回、验收冲突交接）。把它显示成
      // 「你」会让读的人以为是用户的要求，正相反——它是机器的结论。
      return `【${seg.bySystem ? "系统代发" : "你"}${at ? ` ${at}` : ""}】\n${seg.text}`;
    }
    const tag = seg.aside ? "旁注" : seg.level === "notice" ? "结算说明" : "系统";
    return `【${tag}${at ? ` ${at}` : ""}】\n${seg.text}`;
  }).join("\n\n");
}

// 会话排序/裁剪的时间基准:**最后一次活动**,不是创建时间。
//
// `startedAt` 是会话第一次建起来的时刻,而续聊是 resume 同一条会话——它会更新
// `turnStartedAt` 和正文,却永远停在原来的 `startedAt` 上。于是「9-28 建的会话在
// 9-29 续聊出新结论」会排在「9-28 晚些建、当天就结束的旧会话」前面,再被保尾一截,
// 活下来的是旧结论、丢掉的是新结论(审查第 1 轮复现)。
function lastActivity(s: SessionRow): string {
  return [s.endedAt, s.turnStartedAt, s.startedAt].filter(Boolean).sort().at(-1) ?? "";
}

type Block = { id: string; title: string; body: string };

// 一条会话给不到这么多正文,就别从它身上挤了:几十个字的尾巴拼不出一句完整的话,
// 占着额度还让人以为「这条读过了」。宁可把它标成没读、把额度让给另一条。
const MIN_BODY = 120;
const SKIPPED = "〔本次没读:额度不够,见上方说明〕";

/**
 * 把总预算摊给各条会话。三条原则,顺序不能反:
 *
 * ① **不许撒谎**。额度不够时,老实说哪几条没读、怎么才能读到,而不是只回一行标题却
 *    宣称「每条会话都保留了它最近的部分」——审查第 2 轮实测:六条会话 + 800 字额度,
 *    六份正文全被压成空串,工具还返回成功。只剩标题不等于读到了对话。
 * ② **先铺开,再加厚**。第一轮倒序给每条 MIN_BODY,能覆盖几条覆盖几条;余量才在第二轮
 *    倒序追加。只做倒序贪心的话,最近那条会把额度吃干净,其余五条一个字都读不到。
 * ③ 两轮都**倒序**(最近的会话先拿):读不全时,至少手里那条是最新的。
 *
 * 开销要**按最终渲染出来的字符数**算,不是按估的 —— 标题、省略说明、分隔符都真占地方,
 * 第 1 轮那版就是把它们算漏了,于是实际返回长度还超过自己声称的上限。
 *
 * 返回 null = 连「每条一行标题」的骨架都放不下,这时候调用方该明确拒绝而不是硬挤。
 */
function fitBlocks(blocks: Block[], budget: number): { texts: string[]; read: number } | null {
  const whole = (b: Block) => `${b.title}\n\n${b.body}`;
  const cut = (b: Block, keep: number) =>
    `${b.title}\n〔略去前 ${b.body.length - keep} 字,下面是这条会话最近的部分〕\n…${b.body.slice(b.body.length - keep)}`;

  const out = blocks.map((b) => `${b.title}\n${SKIPPED}`);
  // 判「这一块读到正文了没有」只能靠这个标记,**不能靠文本变没变长**。一条「同意」渲染
  // 出来比「本次没读」那行占位还短 —— 第 2 轮那版拿长度当进展判据,于是真正的最新回复
  // 被一路挡在门外,读到的全是旧长正文,顶上还写着「优先给了最近的几条」(第 3 轮复现)。
  const got = blocks.map(() => false);
  let used = out.reduce((n, t) => n + t.length, 0) + SEP.length * Math.max(0, blocks.length - 1);
  if (used > budget) return null;

  // 一块能膨胀到多大 = 没用掉的额度 + 它现在占的位置
  const roomFor = (i: number) => budget - used + (out[i] as string).length;
  const grow = (i: number, cap: number) => {
    const b = blocks[i];
    if (!b) return;
    const room = Math.min(roomFor(i), cap);
    const w = whole(b);
    const next = w.length <= room ? w : (() => {
      // 留 8 字余量:「略去前 N 字」里 N 的位数会随 keep 变化。算完仍要复核一遍。
      const keep = room - cut(b, 0).length - 8;
      if (keep < MIN_BODY) return null;
      const c = cut(b, keep);
      return c.length <= room ? c : null;
    })();
    if (!next) return;
    // 还没读到正文的块:只要放得下就换上,**哪怕换完更短**(短回复省下来的额度会回到
    // 池子里给别人用)。已经读到的块,才要求必须更长 —— 那是第二轮加厚,不变长没意义。
    if (got[i] && next.length <= (out[i] as string).length) return;
    used += next.length - (out[i] as string).length;
    out[i] = next;
    got[i] = true;
  };

  const titleCost = (i: number) => (blocks[i] as Block).title.length + 2;
  for (let i = blocks.length - 1; i >= 0; i--) grow(i, titleCost(i) + cut(blocks[i] as Block, 0).length + MIN_BODY);
  for (let i = blocks.length - 1; i >= 0; i--) grow(i, Number.MAX_SAFE_INTEGER);
  return { texts: out, read: got.filter(Boolean).length };
}

// 执行过程按回合分组,放在会话正文**之前**而不是内联:trace 与正文的对应关系只靠
// turnStartedAt,内联要猜插入点,猜错了就是把工具调用塞进别人的发言里。
//
// 放前面是因为**截断保的是尾巴**(结论在最后)。附在后面的话,一开 includeTrace、
// maxChars 又给小了,保下来的就全是工具调用清单、结论一个字不剩——实测过,正是
// 最不该留的那部分活了下来。条数也要自己设上限,否则一条几千次调用的会话能把整个
// maxChars 吃干净。
const TRACE_MAX_LINES = 80;

function renderTrace(entries: TraceEntry[]): string {
  const byTurn = new Map<string, string[]>();
  for (const e of entries) {
    const ev = e.event ?? {};
    if (ev.kind !== "tool") continue;
    const name = String(ev.name ?? "?");
    const detail = typeof ev.detail === "string" ? ev.detail.replace(/\s+/g, " ").slice(0, 120) : "";
    const list = byTurn.get(e.turnStartedAt) ?? [];
    list.push(`  - ${name}${detail ? ` ${detail}` : ""}`);
    byTurn.set(e.turnStartedAt, list);
  }
  if (!byTurn.size) return "";
  let total = 0;
  for (const lines of byTurn.values()) total += lines.length;
  let budget = TRACE_MAX_LINES;
  // 超额时保**最近**的若干次调用:结论是怎么得出来的,靠的是最后那几步。
  const blocks: string[] = [];
  for (const [turn, lines] of [...byTurn.entries()].reverse()) {
    if (budget <= 0) break;
    const kept = lines.slice(Math.max(0, lines.length - budget));
    budget -= kept.length;
    blocks.unshift(`回合 ${local(turn)}（${lines.length} 次调用）\n${kept.join("\n")}`);
  }
  const omitted = total > TRACE_MAX_LINES ? `,只列最近 ${TRACE_MAX_LINES} 次` : "";
  return `### 执行过程(共 ${total} 次工具调用${omitted},参数截断到 120 字)\n${blocks.join("\n")}\n\n`;
}

export function registerReadTranscriptTools(server: McpServer): void {
server.registerTool(
  "read_task_transcript",
  {
    title: "读某条任务的对话",
    description:
      "读**另一条任务**（或自己)已经说过的话:用户的指令、agent 的回复、系统的结算说明,按时间顺序拼成一份可读的对话,跟界面上看到的是同一份语料。" +
      "拿到一个任务 id、想知道「它当时得出了什么结论/做过什么」时用这个——不要去翻 ~/.claude/projects 或 codex 的 rollout 文件,那条路只对单一执行器成立。" +
      "任务有多条会话时(duet 的 voiceA/voiceB/implementer、重试新建的会话、就地验证的旁路回合)默认全读,按**最后活动时间**排序(续聊会复用老会话,它的创建时间不代表内容新旧);用 sessionId 可只读一条。" +
      "团队任务的执行者是各自独立的任务,先用 list_tasks(parentId=团队 id) 拿到 id 再逐个读。" +
      "默认不含工具调用明细(includeTrace 打开,最多列最近 80 次)。超长时按会话分别裁剪,**每条会话都保留它最近的部分**——不是把全文拼起来砍尾巴,那样整条会话都可能一个字不剩。",
    inputSchema: {
      taskId: z.string().describe("要读的任务 id"),
      sessionId: z.string().optional().describe("只读这一条会话;缺省读该任务的全部会话"),
      maxChars: z.number().int().min(MIN_MAX_CHARS).optional().describe(
        `正文上限,缺省 ${DEFAULT_MAX_CHARS} 字,不得低于 ${MIN_MAX_CHARS}。超了按会话分摊、各保末尾;`
        + "摊不开时会明说哪几条没读,不会只回标题冒充读过"),
      includeTrace: z.boolean().optional().describe("附上每条会话的工具调用清单(按回合分组),缺省 false"),
    },
  },
  async ({ taskId, sessionId, maxChars, includeTrace }) => {
    try {
      const limit = maxChars ?? DEFAULT_MAX_CHARS;
      const task = (await call("GET", `/tasks/${taskId}`)) as TaskRow;
      const all = (await call("GET", `/tasks/${taskId}/sessions`)) as SessionRow[];
      // 服务端那条查询没有 orderBy,顺序是数据库给什么算什么。对 duet 这种一个任务三条
      // 会话的情形,顺序错了整段对话就读反了,所以在这里显式排 —— 按最后活动时间。
      const rows = all
        .filter((s) => !sessionId || s.id === sessionId)
        .sort((a, b) => lastActivity(a).localeCompare(lastActivity(b)));

      if (!rows.length) {
        return ok(sessionId
          ? `任务 ${taskId} 下没有会话 ${sessionId}。已有会话:${all.map((s) => s.id).join(", ") || "(无)"}`
          : `任务 ${taskId}（${String(task.title ?? "")}）还没有任何会话——它可能从未起跑过。`);
      }

      const headCore = [
        `# 任务 ${taskId} · ${String(task.title ?? "(未命名)")}`,
        [`状态 ${String(task.status ?? "?")}`, task.executorLabel ? `执行器 ${String(task.executorLabel)}` : "",
          task.mode ? `模式 ${String(task.mode)}` : "", task.reviewOf ? `(这是 ${String(task.reviewOf)} 的审查任务)` : "",
          task.parentId ? `(团队 ${String(task.parentId)} 的执行者)` : ""].filter(Boolean).join(" · "),
      ].join("\n");
      const head = task.body ? `${headCore}\n\n## 任务指令\n${String(task.body)}` : headCore;

      const bodies: Block[] = [];
      for (const [i, s] of rows.entries()) {
        const raw = await callText(`/sessions/${s.id}/output`);
        const meta = [s.role, s.executor, s.turnModel, s.sideTurn ? "旁路回合" : "",
          `${local(s.startedAt)}${s.endedAt ? ` → ${local(s.endedAt)}` : " → 进行中"}`].filter(Boolean).join(" · ");
        let trace = "";
        if (includeTrace) {
          // 老会话(trace 2026-08-01 才加)服务端已经给成功的 `[]` 了,所以这里 catch 到的
          // **一定是真失败**。把它说成「多半跑在该功能上线之前」等于把故障粉饰成历史
          // 遗留,读的人连重试的念头都不会有 —— 原样把错误带出来。
          try { trace = renderTrace((await call("GET", `/sessions/${s.id}/trace`)) as TraceEntry[]); }
          catch (e) { trace = `### 执行过程\n（读不到:${e instanceof Error ? e.message : String(e)}）\n\n`; }
        }
        bodies.push({ id: s.id, title: `## 会话 ${i + 1}/${rows.length} · ${s.id} · ${meta}`, body: `${trace}${renderSegments(raw)}` });
      }

      const full = `${head}\n\n${bodies.map((b) => `${b.title}\n\n${b.body}`).join(SEP)}`;
      if (full.length <= limit) return ok(full);

      // 任务那一行(id/标题/状态)是必留的:没有它,底下的正文不知道是谁在哪个任务里说的。
      // 任务指令则是可选的 —— 额度紧张时整条省掉,也好过把会话正文挤没。
      // 任务指令**最多占四分之一**。不设这道闸的话,一条长指令能把六条会话的正文全挤没
      // ——而指令本身调用方往往已经知道(是它自己派的活),会话正文才是它来读的东西。
      const headRoom = Math.max(headCore.length, Math.floor(limit * 0.25));
      const headCut = head.length <= headRoom ? head
        : headRoom - headCore.length >= HEAD_BODY_MIN ? `${head.slice(0, headRoom - 20)}\n〔任务指令过长,已截去后半段〕`
        : `${headCore}\n〔任务指令这次没放进来:额度不够〕`;

      // 顶部那段说明**也要先占位**。漏算它的话总长必然超限,再被下面那道兜底闸从头硬截
      // —— 砍掉的恰好是各条会话的尾巴,也就是刚刚费劲保下来的那部分(第 2 轮实测:3000
      // 字额度下最近一条会话的结论又没了)。按两种措辞里较长的那条估上界,宁可少用几十字。
      const noteFor = (read: number) => read === bodies.length
        ? `〔已截断:全文 ${full.length} 字,上限 ${limit} 字。裁剪按会话分别进行,**每条会话都保留了它最近的部分**;`
          + `想看全部就调大 maxChars,或用 sessionId 单读一条会话。〕`
        : `〔已截断:全文 ${full.length} 字,上限 ${limit} 字。额度只够读 ${read}/${bodies.length} 条会话(优先给了最近的几条),`
          + `**其余几条本次没读** —— 下面标着「本次没读」的那些,拿它们标题里的会话 id 传 sessionId 就能单独读到;`
          + `想看全部就调大 maxChars,或用 sessionId 单读一条会话。〕`;
      const noteRoom = Math.max(noteFor(0).length, noteFor(bodies.length).length);

      const fitted = fitBlocks(bodies, limit - headCut.length - noteRoom - SEP.length * 2);
      if (!fitted) {
        // 骨架都放不下。**明确做不到**,顺带把怎么做得到说清楚 —— 这比回一堆空标题诚实。
        // 提示本身也要短:这里只给 id,不重复每条的角色/模型/时间。
        const need = bodies.reduce((n, b) => n + b.title.length + SKIPPED.length + SEP.length, 0)
          + headCore.length + noteRoom + MIN_BODY;
        const lead = `〔这次什么都没读到:上限 ${limit} 字不够。这个任务有 ${bodies.length} 条会话,`
          + `全列出来至少要 ${Math.ceil(need / 100) * 100} 字。把 maxChars 调到那个数以上,或者用 sessionId 单读一条。〕`;
        // 这一支也受 limit 约束:十几条会话的 id 拼起来能把 200 字的额度顶穿(第 3 轮不拦项)。
        // 按**实际渲染出来的长度**逐个试加,别拿一个估出来的余量去减 —— 前缀本身就有二十来字。
        const ids: string[] = [];
        let listed = "";
        for (const b of bodies) {
          const next = [...ids, b.id];
          const prefix = next.length === bodies.length
            ? "\n会话 id:" : `\n会话 id(前 ${next.length} 条,共 ${bodies.length} 条):`;
          const candidate = `${prefix}${next.join(" ")}`;
          if (lead.length + candidate.length > limit) break;
          ids.push(b.id);
          listed = candidate;
        }
        return ok(`${lead}${listed}`);
      }

      const body = `${noteFor(fitted.read)}\n\n${headCut}\n\n${fitted.texts.join(SEP)}`;
      // 兜底:声称了上限就不许超。上面每一步都按渲染后的长度算过,正常走不到这里;真走到了
      // 也只砍头部的说明,不碰各条会话的尾巴。
      return ok(body.length <= limit ? body
        : `${noteFor(fitted.read).slice(0, 80)}…\n\n${fitted.texts.join(SEP).slice(-(limit - 90))}`);
    } catch (e) { return fail(e); }
  },
);
}
