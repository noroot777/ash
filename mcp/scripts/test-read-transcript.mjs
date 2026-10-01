// 端到端验证 read_task_transcript：起真实的 mcp/dist/index.js，ASH_URL 指向一个**假
// ash**（固定语料，不碰真库），然后按断言逐条核对它拼出来的对话。
//
// 钉住的都是这个工具自己写的那几段逻辑——API 是现成的，拼装才是会坏的地方：
//  1. 多会话按 startedAt 排序（假 server 故意乱序返回；duet 一个任务三条会话，顺序错了
//     整段对话就读反了，而服务端那条查询本来就没有 orderBy）
//  2. \x1e 哨兵分别渲染成「你 / 系统代发 / 结算说明 / 旁注」，不糊进 agent 正文
//  3. 截断保尾，且开了 includeTrace 也不许让工具调用清单占住尾巴
//     ——改之前正是这样：保下来的全是 trace，结论一个字不剩
//  4. trace 超额时只留**最近** 80 次
//  5. sessionId 指向不存在的会话时，报出这个任务实际有哪几条
//  6. **续聊复用老会话**:排序基准必须是「最后活动」而不是「会话创建」,且超限时每条
//     会话各保一段尾巴——否则 9-28 建、9-29 续聊出新结论的那条会被整块砍掉,活下来的
//     是另一条当天就结束的旧审查(审查第 1 轮复现的那个场景)
//  7. 正文**原样**取回:恰好是 `null` / `"带引号的结果"` 的正文不许被 JSON 解码改写
//  8. **小额度下不许撒谎**:六条会话 + 紧额度时,要么给出真正文,要么明说哪几条没读;
//     不许只回一行标题却宣称「每条会话都保留了它最近的部分」,返回也不许超过声称的
//     上限(审查第 2 轮复现的那个场景)
//  9. **最新回复很短时也必须读到**:一条「同意」渲染出来比「本次没读」那行占位还短,
//     不许因为「文本没变长」就把它一直留在未读里、把额度让给旧的长正文(第 3 轮复现)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MCP_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const PORT = 14734;
const RS = "\x1e";

const turn = (o) => `\n${RS}${JSON.stringify(o)}\n`;
// ── 语料 ────────────────────────────────────────────────────────────────────
// T1:两条会话,**喂进去的顺序是反的** —— 断言排序。
// T2:续聊场景。old 9-28 建、9-29 续聊出新结论且还在跑;stale 9-28 晚些建、当天结束,
//    正文很长。按 startedAt 排 + 整体保尾的话,新结论会被整块砍掉。
// T3:正文恰好是合法 JSON 的两条会话(agent 刚写完、还没落 agentEnd 哨兵的那个窗口)。
const RS_ = RS;
const SESSIONS = {
  T1: [
    { id: "sB", role: "implementer", executor: "claude@b", startedAt: "2026-01-02T00:00:00.000Z", endedAt: null },
    { id: "sA", role: "voiceA", executor: "claude@a", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T01:00:00.000Z" },
  ],
  T2: [
    { id: "old", role: "single", executor: "claude@a", startedAt: "2026-09-28T00:00:00.000Z", turnStartedAt: "2026-09-29T10:00:00.000Z", endedAt: null },
    { id: "stale", role: "reviewer", executor: "claude@b", startedAt: "2026-09-28T01:00:00.000Z", turnStartedAt: "2026-09-28T01:00:00.000Z", endedAt: "2026-09-28T02:00:00.000Z" },
  ],
  T6: Array.from({ length: 6 }, (_, i) => ({
    id: `sess${i}`, role: "single", executor: "claude@ccb",
    startedAt: `2026-05-0${i + 1}T00:00:00.000Z`, endedAt: `2026-05-0${i + 1}T01:00:00.000Z`,
  })),
  T3: [
    { id: "jnull", role: "single", executor: "claude@a", startedAt: "2026-03-01T00:00:00.000Z", endedAt: null },
    { id: "jstr", role: "single", executor: "claude@a", startedAt: "2026-03-02T00:00:00.000Z", endedAt: null },
  ],
};
const OUTPUT = {
  sA: `第一段 agent 正文。${turn({ t: "user", agent: "claude", text: "真人追问一句", at: "2026-01-01T00:10:00.000Z" })}回应追问的正文。`
    + turn({ t: "user", agent: "claude", text: "验证打回：改这里", at: "2026-01-01T00:20:00.000Z", by: "system" })
    + turn({ t: "system", agent: "claude", text: "预约了一次审查", at: "2026-01-01T00:30:00.000Z", aside: true })
    + turn({ t: "system", agent: "claude", text: "本回合没有交卷", at: "2026-01-01T00:40:00.000Z", level: "notice" }),
  // 长正文 + 结尾的标记:断言 3 用它确认保下来的是尾巴。
  sB: `${"填充".repeat(3000)}\n这是最后的结论行。`,
  old: `早期讨论。${turn({ t: "user", agent: "claude", text: "再想想方案 B", at: "2026-09-29T10:00:00.000Z" })}${"续聊正文".repeat(200)}\nLATEST_CONFIRMED_PLAN_B`,
  stale: `${"旧审查记录".repeat(2000)}\nSTALE_REVIEW_REJECTS_PLAN_B`,
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`sess${i}`, `${"六条会话的正文".repeat(300)}\nLATEST_SESSION_${i}`])),
  jnull: "null",
  jstr: '"quoted-result"',
};
const TRACE = {
  sA: [],
  // 120 次调用,远超 80 条上限;名字带序号,便于断言留下的是最近那批。
  sB: Array.from({ length: 120 }, (_, i) => ({
    at: "2026-01-02T00:00:00.000Z", turnStartedAt: "2026-01-02T00:00:00.000Z",
    event: { kind: "tool", name: `Tool${i}`, detail: "{}" },
  })),
};
const TASKS = {
  T1: { id: "T1", title: "假任务", status: "done", body: "这是任务指令", executorLabel: "claude@a", mode: "duet" },
  T2: { id: "T2", title: "续聊任务", status: "running", body: "原始指令", executorLabel: "claude@a" },
  T6: { id: "T6", title: "六条会话的任务", status: "done", body: "原始指令", executorLabel: "claude@ccb" },
  T3: { id: "T3", title: "正文像 JSON", status: "running", body: "原始指令", executorLabel: "claude@a" },
};
// 这条会话的 trace 一律 500:断言故障不被粉饰成「老会话本来就没有 trace」。
const TRACE_BROKEN = "sA";

// `short:<回复>` / `longinst:<回复>` / `many13` 这几类任务由 mock 现场合成,省得为每种
// 短回复变体各写一份常量表。
// 这几种渲染出来都比「本次没读」那行占位还短(甚至更省额度)。回复**不写进 taskId**:
// 标题里会回显 taskId,拿它做 body.includes 断言就成了恒真。
const SHORT_REPLIES = ["同意", "null", '"yes"', "123", "true", "好的,就这么办"];

function dynamic(taskId) {
  if (taskId === "many13") {
    const ss = Array.from({ length: 13 }, (_, i) => ({
      id: `many13-s${i}`, role: "single", executor: "claude@ccb",
      startedAt: `2026-07-01T0${i % 10}:00:00.000Z`, endedAt: `2026-07-01T0${i % 10}:30:00.000Z`,
    }));
    return { task: { id: taskId, title: "十三条会话", status: "done", body: "指令" },
      sessions: ss, output: Object.fromEntries(ss.map((x) => [x.id, "正文".repeat(200)])) };
  }
  const m = /^(short|longinst):(\d+)$/.exec(taskId);
  if (!m) return null;
  const [, kind, idx] = m;
  const reply = SHORT_REPLIES[Number(idx)];
  const fresh = { id: `${kind}-${idx}-new`, role: "single", executor: "claude@ccb",
    startedAt: "2026-09-29T00:00:00.000Z", endedAt: "2026-09-29T01:00:00.000Z" };
  const older = { id: `${kind}-${idx}-old`, role: "single", executor: "claude@ccb",
    startedAt: "2026-09-28T00:00:00.000Z", endedAt: "2026-09-28T01:00:00.000Z" };
  const sessions = kind === "longinst" ? [fresh] : [older, fresh];
  return {
    task: { id: taskId, title: "短回复场景", status: "done",
      body: kind === "longinst" ? "长材料".repeat(400) : "指令" },
    sessions,
    output: { [fresh.id]: `${reply}${turn({ t: "agentEnd", at: "2026-09-29T01:00:00.000Z" })}`,
      // 旧会话要足够长,否则连默认 30000 额度都装得下整份文本,根本进不了裁剪分支
      [older.id]: `${"旧的长讨论".repeat(8000)}\nOLDER_LONG_CONCLUSION` },
  };
}

function fakeAsh() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = req.url.split("?")[0];
      const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(body); };
      let m;
      if ((m = /^\/api\/tasks\/([^/]+)$/.exec(path))) {
        const id = decodeURIComponent(m[1]);
        const t = TASKS[id] ?? dynamic(id)?.task;
        return t ? send(200, JSON.stringify(t)) : send(404, JSON.stringify({ error: "not found" }));
      }
      if ((m = /^\/api\/tasks\/([^/]+)\/sessions$/.exec(path))) {
        const id = decodeURIComponent(m[1]);
        return send(200, JSON.stringify(SESSIONS[id] ?? dynamic(id)?.sessions ?? []));
      }
      if ((m = /^\/api\/sessions\/([^/]+)\/output$/.exec(path))) {
        const id = decodeURIComponent(m[1]);
        const dyn = dynamic(id.startsWith("many13") ? "many13" : id.replace(/^(short|longinst)-(\d+)-(new|old)$/, "$1:$2"));
        return send(200, OUTPUT[id] ?? dyn?.output?.[id] ?? "", "text/plain; charset=utf-8");
      }
      if ((m = /^\/api\/sessions\/([^/]+)\/trace$/.exec(path))) {
        if (m[1] === TRACE_BROKEN) return send(500, JSON.stringify({ error: "trace unreadable" }));
        return send(200, JSON.stringify(TRACE[m[1]] ?? []));
      }
      send(404, JSON.stringify({ error: "not found" }));
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

function mcpClient() {
  const child = spawn("node", [MCP_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ASH_URL: `http://127.0.0.1:${PORT}`, ASH_RECONNECT_MS: "3000" },
  });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id); } catch { /* 非协议行 */ }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const n = ++id;
    const timer = setTimeout(() => rej(new Error(`${method} 超时`)), 20_000);
    pending.set(n, (m) => { clearTimeout(timer); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  return { child, rpc };
}

const failures = [];
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${cond ? "" : ` —— ${extra}`}`);
  if (!cond) failures.push(label);
};

const server = await fakeAsh();
const { child, rpc } = mcpClient();
try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const listed = await rpc("tools/list", {});
  check("工具出现在清单里", listed.result.tools.some((t) => t.name === "read_task_transcript"));

  const text = async (args) => {
    const r = await rpc("tools/call", { name: "read_task_transcript", arguments: args });
    return { body: r.result?.content?.[0]?.text ?? "", isError: !!r.result?.isError };
  };

  const full = await text({ taskId: "T1", maxChars: 200_000 });
  const posA = full.body.indexOf("会话 1/2 · sA");
  const posB = full.body.indexOf("会话 2/2 · sB");
  check("多会话按时间排序（喂进去是乱的）", posA > 0 && posB > posA, `posA=${posA} posB=${posB}`);
  check("带上任务指令", full.body.includes("## 任务指令") && full.body.includes("这是任务指令"));
  check("真人追问渲染成「你」", /【你 2026-01-01 \d\d:\d\d】\n真人追问一句/.test(full.body));
  check("后端代发的回合不冒充真人", full.body.includes("【系统代发") && /【系统代发[^】]*】\n验证打回/.test(full.body));
  check("旁注单独成段", /【旁注[^】]*】\n预约了一次审查/.test(full.body));
  check("结算说明单独成段", /【结算说明[^】]*】\n本回合没有交卷/.test(full.body));
  check("agent 正文不吞掉哨兵后面的段落", full.body.includes("回应追问的正文。"));
  check("不截断时没有截断提示", !full.body.includes("〔已截断"));

  const cut = await text({ taskId: "T1", maxChars: 800, includeTrace: true });
  check("超长时给出截断提示", cut.body.includes("〔已截断"));
  check("截断保的是尾巴（结论还在）", cut.body.includes("这是最后的结论行。"), cut.body.slice(-120));
  check("trace 不许占住尾巴", !cut.body.trimEnd().endsWith("}") && cut.body.lastIndexOf("这是最后的结论行。") > cut.body.lastIndexOf("Tool119"));

  const traced = await text({ taskId: "T1", sessionId: "sB", maxChars: 200_000, includeTrace: true });
  check("trace 超额只留最近 80 次", traced.body.includes("共 120 次工具调用,只列最近 80 次")
    && traced.body.includes("Tool119") && !traced.body.includes("Tool39\n"), "");
  check("trace 排在正文之前", traced.body.indexOf("### 执行过程") < traced.body.indexOf("这是最后的结论行。"));
  check("sessionId 过滤只给一条", traced.body.includes("会话 1/1 · sB") && !traced.body.includes("sA"));

  const missing = await text({ taskId: "T1", sessionId: "nope" });
  check("会话 id 不存在时报出实际有哪几条", missing.body.includes("没有会话 nope") && missing.body.includes("sB") && missing.body.includes("sA"));

  // ── 审查第 1 轮:续聊复用老会话 ───────────────────────────────────────────
  const chronoFull = await text({ taskId: "T2", maxChars: 200_000 });
  const iOld = chronoFull.body.indexOf("会话 2/2 · old");
  check("续聊过的老会话排在后面（按最后活动,不是创建时间）", iOld > 0, chronoFull.body.slice(0, 400));
  check("不截断时两条结论都在", chronoFull.body.includes("LATEST_CONFIRMED_PLAN_B") && chronoFull.body.includes("STALE_REVIEW_REJECTS_PLAN_B"));

  const chronoCut = await text({ taskId: "T2", maxChars: 3000 });
  check("超限时续聊出的新结论不丢", chronoCut.body.includes("LATEST_CONFIRMED_PLAN_B"), chronoCut.body.slice(-200));
  check("超限时另一条会话的尾巴也在（分会话各保尾）", chronoCut.body.includes("STALE_REVIEW_REJECTS_PLAN_B"));
  check("被裁的会话仍带着自己的标题行", /## 会话 1\/2 · stale/.test(chronoCut.body));
  check("裁剪提示说清是按会话分别裁的", chronoCut.body.includes("每条会话都保留了它最近的部分"));
  check("裁剪后不超过上限", chronoCut.body.length <= 3000, `len=${chronoCut.body.length}`);

  // ── 审查第 2 轮:正文恰好是合法 JSON ──────────────────────────────────────
  const json = await text({ taskId: "T3", maxChars: 200_000 });
  check("正文 null 不被当成「没有正文」", json.body.includes("null") && !json.body.includes("还没有落下任何正文"), json.body.slice(-300));
  check("正文的引号不被 JSON 解码吃掉", json.body.includes('"quoted-result"'), json.body.slice(-300));

  // ── 不拦项 1:trace 读取故障不许粉饰成「老会话没有 trace」 ────────────────
  const brokenTrace = await text({ taskId: "T1", sessionId: "sA", includeTrace: true, maxChars: 200_000 });
  check("trace 真失败时报出原因", brokenTrace.body.includes("读不到:") && brokenTrace.body.includes("500")
    && !brokenTrace.body.includes("上线之前"), brokenTrace.body.slice(0, 300));

  // ── 审查第 2 轮:小额度不许把正文删光还说保留了 ──────────────────────────
  const FAKE_PROMISE = "每条会话都保留了它最近的部分";
  for (const cap of [200, 400, 800, 1200, 3000, 30_000]) {
    const r = await text({ taskId: "T6", maxChars: cap });
    const skipped = (r.body.match(/本次没读:/g) ?? []).length;
    const got = (r.body.match(/LATEST_SESSION_/g) ?? []).length;
    const denied = r.body.includes("这次什么都没读到");
    check(`额度 ${cap}:返回不超过声称的上限`, r.body.length <= cap, `实际 ${r.body.length}`);
    check(`额度 ${cap}:没读到的会话不冒充读过`, !(r.body.includes(FAKE_PROMISE) && skipped > 0));
    // 核心那条:要么真给了正文,要么明说没读 —— 不许两头都不沾(只剩标题却宣称保留)。
    check(`额度 ${cap}:要么有正文、要么明说读不到`, denied || got > 0 || skipped > 0,
      `got=${got} skipped=${skipped} ${r.body.slice(0, 200)}`);
    if (denied) check(`额度 ${cap}:拒绝时说清要多少字、怎么单读`, /把 maxChars 调到/.test(r.body) && r.body.includes("sessionId"));
  }
  const big = await text({ taskId: "T6", maxChars: 30_000 });
  check("额度够时六条结论一条不少", (big.body.match(/LATEST_SESSION_/g) ?? []).length === 6,
    `只有 ${(big.body.match(/LATEST_SESSION_/g) ?? []).length} 条`);
  const mid = await text({ taskId: "T6", maxChars: 3000 });
  check("中等额度优先给最近的会话", mid.body.includes("LATEST_SESSION_5"), mid.body.slice(-200));

  const tooSmall = await rpc("tools/call", { name: "read_task_transcript", arguments: { taskId: "T6", maxChars: 1 } });
  check("maxChars 小到放不下任何说明时直接拒收", !!tooSmall.result?.isError || !!tooSmall.error,
    JSON.stringify(tooSmall).slice(0, 200));

  // ── 审查第 3 轮:最新回复很短时不许被占位文字挡在门外 ────────────────────
  // 取「最新那条会话」的块,核对它里面有没有真正的回复 —— 不看全文 includes。
  const freshBlock = (body) => (body.split("## 会话 ").find((b) => b.startsWith("2/2 ·") || b.startsWith("1/1 ·")) ?? "");
  for (const [i, reply] of SHORT_REPLIES.entries()) {
    for (const cap of [800, 30_000]) {
      const r = await text({ taskId: `short:${i}`, maxChars: cap });
      const fresh = freshBlock(r.body);
      check(`最新的短回复「${reply}」在 ${cap} 字下读得到`,
        fresh.includes(reply) && !fresh.includes("本次没读"), fresh.slice(0, 200) || r.body.slice(0, 200));
    }
  }
  const shortCut = await text({ taskId: "short:0", maxChars: 800 });
  check("紧额度下旧长会话也还在(只是被裁)", shortCut.body.includes("short-0-old"), shortCut.body.slice(0, 200));

  // 单条会话 + 长任务指令:同一个判据错误在这里表现为「0/1 条」
  const lonely = await text({ taskId: "longinst:0", maxChars: 800 });
  check("唯一一条会话的短回复不会被标成没读",
    freshBlock(lonely.body).includes("同意") && !lonely.body.includes("本次没读"), lonely.body.slice(-260));
  check("任务指令不许挤掉会话正文（最多占四分之一）", !/## 任务指令[\s\S]{400,}?## 会话/.test(lonely.body),
    lonely.body.slice(0, 300));

  // 不拦项:会话多到 id 清单放不下时,拒绝提示本身也不许超上限
  for (const cap of [200, 400]) {
    const many = await text({ taskId: "many13", maxChars: cap });
    check(`十三条会话 + ${cap} 字:拒绝提示本身也不超上限`, many.body.length <= cap, `实际 ${many.body.length}`);
    check(`十三条会话 + ${cap} 字:说清有几条、怎么单读`, many.body.includes("13 条会话") && many.body.includes("sessionId"));
  }

  const noTask = await text({ taskId: "NOPE" });
  check("任务不存在时原样抛出 404", noTask.isError && noTask.body.includes("404"), noTask.body);
} finally {
  // 验证起的东西一律自己收掉,别在 14xxx 上留残留。
  try { child.kill("SIGKILL"); } catch { /* 已经退了 */ }
  server.close();
}

console.log(failures.length ? `\n❌ ${failures.length} 条不通过：${failures.join(" / ")}` : "\n✅ 全部通过");
process.exit(failures.length ? 1 : 0);
