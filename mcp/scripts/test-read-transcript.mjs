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
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MCP_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const PORT = 14734;
const RS = "\x1e";

const turn = (o) => `\n${RS}${JSON.stringify(o)}\n`;
// 两条会话,**喂进去的顺序是反的** —— 断言 1 靠这个。
const SESSIONS = [
  { id: "sB", role: "implementer", executor: "claude@b", startedAt: "2026-01-02T00:00:00.000Z", endedAt: null },
  { id: "sA", role: "voiceA", executor: "claude@a", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T01:00:00.000Z" },
];
const OUTPUT = {
  sA: `第一段 agent 正文。${turn({ t: "user", agent: "claude", text: "真人追问一句", at: "2026-01-01T00:10:00.000Z" })}回应追问的正文。`
    + turn({ t: "user", agent: "claude", text: "验证打回：改这里", at: "2026-01-01T00:20:00.000Z", by: "system" })
    + turn({ t: "system", agent: "claude", text: "预约了一次审查", at: "2026-01-01T00:30:00.000Z", aside: true })
    + turn({ t: "system", agent: "claude", text: "本回合没有交卷", at: "2026-01-01T00:40:00.000Z", level: "notice" }),
  // 长正文 + 结尾的标记:断言 3 用它确认保下来的是尾巴。
  sB: `${"填充".repeat(3000)}\n这是最后的结论行。`,
};
const TRACE = {
  sA: [],
  // 120 次调用,远超 80 条上限;名字带序号,便于断言留下的是最近那批。
  sB: Array.from({ length: 120 }, (_, i) => ({
    at: "2026-01-02T00:00:00.000Z", turnStartedAt: "2026-01-02T00:00:00.000Z",
    event: { kind: "tool", name: `Tool${i}`, detail: "{}" },
  })),
};

function fakeAsh() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = req.url.split("?")[0];
      const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(body); };
      let m;
      if ((m = /^\/api\/tasks\/([^/]+)$/.exec(path))) {
        if (m[1] !== "T1") return send(404, JSON.stringify({ error: "not found" }));
        return send(200, JSON.stringify({ id: "T1", title: "假任务", status: "done", body: "这是任务指令", executorLabel: "claude@a", mode: "duet" }));
      }
      if ((m = /^\/api\/tasks\/([^/]+)\/sessions$/.exec(path))) return send(200, JSON.stringify(SESSIONS));
      if ((m = /^\/api\/sessions\/([^/]+)\/output$/.exec(path))) return send(200, OUTPUT[m[1]] ?? "", "text/plain; charset=utf-8");
      if ((m = /^\/api\/sessions\/([^/]+)\/trace$/.exec(path))) return send(200, JSON.stringify(TRACE[m[1]] ?? []));
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
  check("多会话按 startedAt 排序（喂进去是乱的）", posA > 0 && posB > posA, `posA=${posA} posB=${posB}`);
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

  const noTask = await text({ taskId: "NOPE" });
  check("任务不存在时原样抛出 404", noTask.isError && noTask.body.includes("404"), noTask.body);
} finally {
  // 验证起的东西一律自己收掉,别在 14xxx 上留残留。
  try { child.kill("SIGKILL"); } catch { /* 已经退了 */ }
  server.close();
}

console.log(failures.length ? `\n❌ ${failures.length} 条不通过：${failures.join(" / ")}` : "\n✅ 全部通过");
process.exit(failures.length ? 1 : 0);
