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

/**
 * 把总预算摊给各条会话,每条**各自保尾**,而不是把它们拼起来再砍一刀尾巴。
 *
 * 块级排序对交错的会话(duet 三条并行、实现与审查来回、续聊复用老会话)永远只是近似,
 * 所以裁剪不能把「最新的东西在整份文本的末尾」当成前提 —— 那等于把排序的瑕疵直接
 * 放大成「整条会话一个字都不剩」。每条会话各留一段尾巴之后,不管块怎么排,**每条会话
 * 最近说的话都在**。用不完的额度回收给超额的那些,别让一条短会话把份额白占着。
 */
function fitBlocks(blocks: string[], budget: number): string[] {
  if (blocks.reduce((n, b) => n + b.length, 0) <= budget) return blocks;
  let share = Math.floor(budget / blocks.length);
  let spare = budget - share * blocks.length;
  // 两轮分配:先把短块用不完的额度收回来,再按还差多少摊给超额的块。
  const over = blocks.filter((b) => b.length > share);
  if (over.length && over.length < blocks.length) {
    const used = blocks.filter((b) => b.length <= share).reduce((n, b) => n + b.length, 0);
    share = Math.floor((budget - used) / over.length);
    spare = 0;
  }
  return blocks.map((b, i) => {
    const room = share + (i === blocks.length - 1 ? spare : 0);
    if (b.length <= room) return b;
    const head = b.split("\n")[0] ?? "";            // 会话标题行一定留住:没有它就不知道这段是谁说的
    const tail = b.slice(Math.max(0, b.length - Math.max(0, room - head.length - 40)));
    return `${head}\n〔这条会话太长,略去前 ${b.length - tail.length} 字,下面是它最近的部分〕\n…${tail}`;
  });
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
      "任务有多条会话时(duet 的 voiceA/voiceB/implementer、重试新建的会话、就地验证的旁路回合)默认全读,按开始时间排序;用 sessionId 可只读一条。" +
      "团队任务的执行者是各自独立的任务,先用 list_tasks(parentId=团队 id) 拿到 id 再逐个读。" +
      "默认不含工具调用明细(includeTrace 打开,最多列最近 80 次)。超长时按会话分别裁剪,**每条会话都保留它最近的部分**——不是把全文拼起来砍尾巴,那样整条会话都可能一个字不剩。",
    inputSchema: {
      taskId: z.string().describe("要读的任务 id"),
      sessionId: z.string().optional().describe("只读这一条会话;缺省读该任务的全部会话"),
      maxChars: z.number().int().positive().optional().describe(`正文上限,缺省 ${DEFAULT_MAX_CHARS} 字;超了按会话分摊、各保末尾`),
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

      const head = [
        `# 任务 ${taskId} · ${String(task.title ?? "(未命名)")}`,
        [`状态 ${String(task.status ?? "?")}`, task.executorLabel ? `执行器 ${String(task.executorLabel)}` : "",
          task.mode ? `模式 ${String(task.mode)}` : "", task.reviewOf ? `(这是 ${String(task.reviewOf)} 的审查任务)` : "",
          task.parentId ? `(团队 ${String(task.parentId)} 的执行者)` : ""].filter(Boolean).join(" · "),
        task.body ? `\n## 任务指令\n${String(task.body)}` : "",
      ].filter(Boolean).join("\n");

      const bodies: string[] = [];
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
        bodies.push(`## 会话 ${i + 1}/${rows.length} · ${s.id} · ${meta}\n\n${trace}${renderSegments(raw)}`);
      }

      const full = `${head}\n\n${bodies.join(SEP)}`;
      if (full.length <= limit) return ok(full);
      // 元信息和任务指令先于会话正文占位:没有它们,剩下的正文不知道是谁在什么任务里说的。
      const headRoom = Math.min(head.length, Math.max(400, Math.floor(limit * 0.15)));
      const headCut = head.length <= headRoom ? head : `${head.slice(0, headRoom)}\n〔任务指令过长,已截去后半段〕`;
      const fitted = fitBlocks(bodies, Math.max(0, limit - headCut.length - SEP.length * (bodies.length - 1)));
      return ok(`〔已截断:全文 ${full.length} 字,上限 ${limit} 字。裁剪按会话分别进行,**每条会话都保留了它最近的部分**;`
        + `想看全部就调大 maxChars,或用 sessionId 单读一条会话。〕\n\n${headCut}\n\n${fitted.join(SEP)}`);
    } catch (e) { return fail(e); }
  },
);
}
