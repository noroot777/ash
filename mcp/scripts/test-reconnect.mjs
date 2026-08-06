// 端到端验证 MCP 的重启重试：
//   1. 起真实的 mcp/dist/index.js，HARNESS_URL 指向一个没人监听的端口
//   2. 立刻发一个 tools/call（此刻必然 ECONNREFUSED）
//   3. 3 秒后才把一个假 harness 拉起来
//   4. 断言：调用最终成功（说明它等过去了），且 stderr 里确实出现过重试
// 对照组：把重试窗口设成 0，同样的时序必须失败——否则证明不了是重试起的作用。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MCP_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const PORT = 14733;

function runCase({ label, reconnectMs, startServerAfterMs }) {
  return new Promise((resolve) => {
    const child = spawn("node", [MCP_ENTRY], {
      env: { ...process.env, HARNESS_URL: `http://localhost:${PORT}`, HARNESS_RECONNECT_MS: String(reconnectMs) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let buf = "";
    let done = false;
    let server = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch {}
      if (server) server.close();
      resolve({ label, ...result, retried: /后重试/.test(stderr), stderr });
    };
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    child.stderr.on("data", (d) => (stderr += d.toString()));
    // 严格按行读，并且**等 initialize 的响应回来**再往下走 —— 抢在它前面发
    // notifications/initialized 会让 SDK 的状态机卡住（第一版测试就栽在这）。
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_tasks", arguments: {} } });
        } else if (msg.id === 2) {
          const text = msg.result?.content?.[0]?.text ?? JSON.stringify(msg.error ?? {});
          finish({ ok: !msg.result?.isError, text: text.slice(0, 120) });
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });

    // 迟到的 harness：只有重试撑过这段空窗，调用才会成功。
    setTimeout(() => {
      server = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: "T1", title: "来自迟到的 server", status: "done" }]));
      });
      server.listen(PORT);
    }, startServerAfterMs);

    setTimeout(() => finish({ ok: false, text: "(超时,没等到响应)" }), 30_000);
  });
}

const results = [];
results.push(await runCase({ label: "重试窗口 20s，server 3s 后才起", reconnectMs: 20_000, startServerAfterMs: 3_000 }));
await new Promise((r) => setTimeout(r, 500)); // 让端口彻底释放
results.push(await runCase({ label: "对照：重试窗口 0，同样时序", reconnectMs: 0, startServerAfterMs: 3_000 }));

let bad = 0;
for (const r of results) {
  console.log(`\n── ${r.label}`);
  console.log(`   成功=${r.ok}  发生过重试=${r.retried}`);
  console.log(`   返回：${r.text.replace(/\s+/g, " ")}`);
}
const [withRetry, without] = results;
if (!withRetry.ok) { console.log("\n✕ 有重试时应当成功，实际失败"); bad++; }
if (!withRetry.retried) { console.log("\n✕ 有重试时应当出现过重试日志，实际没有"); bad++; }
if (without.ok) { console.log("\n✕ 对照组(无重试)不该成功——证明不了是重试起的作用"); bad++; }
console.log(bad === 0 ? "\n✅ 全部通过：重试确实把重启空窗抹平了" : `\n❌ ${bad} 项不符`);
process.exit(bad === 0 ? 0 : 1);
