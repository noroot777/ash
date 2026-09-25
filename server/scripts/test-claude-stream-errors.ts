/**
 * parseClaudeStream 对 **API 层失败** 的上报。
 *
 * 起因(2026-08-01):团队调度台配了 `claude --model kimi/kimi-k3` 打百炼的 anthropic
 * 端点,模型不存在 → 404。CLI 把这件事报成两条:
 *   1. 一条 `model:"<synthetic>"` 的 assistant 消息,text 里写着人话的错误原因
 *   2. 一条 `subtype:"success"` + `is_error:true` + `api_error_status:404` 的 result
 * 解析器当时两条都漏了 —— text 因为「已由 delta 流过」被跳过(合成消息根本没有
 * delta),result 因为只看 subtype 被判成正常结束。结果 .md 里只剩一行 agentEnd,
 * 用户看到的是「任务停在那不动」,查不出任何原因。
 *
 * 这份测试用假 CLI 输出把两条路都钉住。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseClaudeStream } = await import("../src/executors/claude.js");

const dir = mkdtempSync(join(tmpdir(), "ash-claude-stream-"));
let bad = 0;
const fail = (m: string) => { console.log("   ✕ " + m); bad++; };
const ok = (m: string) => console.log("   ✓ " + m);

/** 跑一段假 CLI stdout,收集 parseClaudeStream 吐出的事件。 */
async function collect(lines: unknown[], resident?: { interruptPending: boolean; failPending: () => void }) {
  const script = join(dir, `stub-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(
    script,
    lines.map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + "\n")});`).join("\n"),
  );
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.end();
  const events: any[] = [];
  for await (const event of parseClaudeStream(child as any, resident)) events.push(event);
  return events;
}

/**
 * 跑一段假 CLI:把 lines 输出完之后**挂住不退**,过 hangMs 才结束 —— 用来复现
 * 「请求发出去了,上游再也没回话」。waitNoticeMs 缩到毫秒级,免得测试真等 5 分钟。
 */
async function collectHanging(lines: unknown[], hangMs: number, waitNoticeMs: number) {
  const script = join(dir, `stub-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(
    script,
    lines.map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + "\n")});`).join("\n")
      + `\nsetTimeout(() => process.exit(0), ${hangMs});`,
  );
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.end();
  const events: any[] = [];
  for await (const event of parseClaudeStream(child as any, undefined, "claude", undefined, null, () => {}, waitNoticeMs)) {
    events.push(event);
  }
  return events;
}

/** 跑一段非零退出的假 CLI stderr。 */
async function collectStderr(stderr: string) {
  const script = join(dir, `stub-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(script, `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`);
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.end();
  const events: any[] = [];
  for await (const event of parseClaudeStream(child as any)) events.push(event);
  return events;
}

const SYNTHETIC_404 = [
  { type: "system", session_id: "sess-1" },
  {
    type: "assistant",
    message: {
      model: "<synthetic>",
      content: [{ type: "text", text: "There's an issue with the selected model (kimi/kimi-k3)." }],
    },
    error: "model_not_found",
  },
  { type: "result", subtype: "success", is_error: true, api_error_status: 404, session_id: "sess-1", result: "There's an issue with the selected model (kimi/kimi-k3)." },
];

console.log("1) API 层失败(404 model_not_found)必须既留下原因、又报错");
{
  const events = await collect(SYNTHETIC_404);
  const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
  const errors = events.filter((e) => e.kind === "error");
  if (text.includes("kimi/kimi-k3")) ok("合成消息的错误说明进了正文");
  else fail(`合成消息的 text 丢了(收到 ${JSON.stringify(text)})`);
  if (errors.length === 1) ok("报了一次 error");
  else fail(`期望 1 条 error,实到 ${errors.length}`);
  if (errors[0]?.message?.includes("404")) ok(`error 带上了 HTTP 状态:${errors[0].message}`);
  else fail(`error 没带状态码:${errors[0]?.message}`);
}

console.log("2) 真模型的正文仍然只走 delta,不因为这次改动重复一遍");
{
  const events = await collect([
    { type: "system", session_id: "sess-2" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好\n" } } },
    { type: "assistant", message: { model: "claude-opus-5", content: [{ type: "text", text: "你好" }] } },
    { type: "result", subtype: "success", session_id: "sess-2" },
  ]);
  const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
  const errors = events.filter((e) => e.kind === "error");
  if (text.trim() === "你好") ok("正文没有重复");
  else fail(`正文重复或缺失:${JSON.stringify(text)}`);
  if (!errors.length) ok("成功回合不报错");
  else fail(`成功回合冒出了 error:${errors[0].message}`);
}

console.log("3) 用户主动打断仍然不算故障");
{
  // 假常驻桥要带上 failPending:进程退出时解析器会调它(claude.ts 的 close/error 分支),
  // 只塞 interruptPending 的话整个文件会在这里 TypeError 掉,后面几节根本跑不到。
  const resident = { interruptPending: true, failPending: () => {} };
  const events = await collect(
    [
      { type: "system", session_id: "sess-3" },
      { type: "result", subtype: "error_during_execution", is_error: true, session_id: "sess-3" },
    ],
    resident,
  );
  const errors = events.filter((e) => e.kind === "error");
  if (!errors.length) ok("自己发的 interrupt 不上报");
  else fail(`打断被误报成故障:${errors[0].message}`);
  if (events.some((e) => e.kind === "turnEnd")) ok("常驻回合正常收尾");
  else fail("常驻模式没有 turnEnd");
}

// 起因(2026-08-13):563k tokens 的会话发 `/compact`,中转网关连着三次 503,压缩一次
// 都没发生 —— 而这一轮的 result 是 `subtype:"success"` + 退出码 0,任务状态不动,
// 时间线上只多出 CLI 合成的一句英文。用户的结论只能是「这个系统的 /compact 坏了」,
// 下一句话继续撞 Prompt is too long。压缩的成败只在 system/status 这一条事件里。
console.log("4) 压缩(/compact 与自动压缩)的过程与成败必须显式上报");
{
  const failed = await collect([
    { type: "system", subtype: "status", status: "compacting", session_id: "sess-4" },
    {
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "failed",
      compact_error: "Error during compaction: API Error: 503 upstream connect error",
      session_id: "sess-4",
    },
    { type: "result", subtype: "success", session_id: "sess-4" },
  ]);
  const text = failed.filter((e) => e.kind === "text").map((e) => e.text).join("");
  const errors = failed.filter((e) => e.kind === "error");
  if (text.includes("正在压缩上下文")) ok("压缩开始时说了一声");
  else fail(`压缩开始没有任何提示:${JSON.stringify(text)}`);
  if (errors.length === 1 && errors[0].message.includes("503")) ok(`压缩失败抬成了 error:${errors[0].message}`);
  else fail(`压缩失败没有报错(收到 ${errors.length} 条:${errors[0]?.message})`);
  if (errors[0]?.affectsTurn === false) ok("压缩失败只影响展示，不把成功回合判失败");
  else fail(`压缩失败缺少旁路诊断标记:${JSON.stringify(errors[0])}`);

  const succeeded = await collect([
    { type: "system", subtype: "status", status: "compacting", session_id: "sess-5" },
    { type: "system", subtype: "status", status: null, compact_result: "success", session_id: "sess-5" },
    { type: "result", subtype: "success", session_id: "sess-5" },
  ]);
  const okText = succeeded.filter((e) => e.kind === "text").map((e) => e.text).join("");
  if (okText.includes("上下文已压缩")) ok("压成了也说一声");
  else fail(`压缩成功没有任何提示:${JSON.stringify(okText)}`);
  if (!succeeded.filter((e) => e.kind === "error").length) ok("压缩成功不报错");
  else fail("压缩成功却报了 error");
}

console.log("5) 旧版 Claude Code 的 --effort 参数错误要给出可操作提示");
{
  const events = await collectStderr("error: unknown option '--effort'\n");
  const message = events.find((e) => e.kind === "error")?.message ?? "";
  if (message.includes("claude update") && message.includes("跟随执行器")) ok("参数错误已转换成升级/绕过提示");
  else fail(`没有给出可操作提示:${JSON.stringify(message)}`);
  if (!message.includes("unknown option")) ok("不再透传生硬的 CLI 原始错误");
  else fail(`仍在透传原始错误:${JSON.stringify(message)}`);
}

// 起因(2026-08-21):容器里以 root 跑的 ash(172.16.88.252:4317),每个 claude 回合都
// 0s 结束,时间线上只有一行英文 —— 用户读不出这跟「ash 跑在 root 下」有关。
console.log("6) root 下被拒绝跳过权限确认要说清成因和出路");
{
  const events = await collectStderr(
    "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n",
  );
  const message = events.find((e) => e.kind === "error")?.message ?? "";
  if (message.includes("root") && message.includes("IS_SANDBOX=1")) ok("给出了成因与可操作的出路");
  else fail(`没有翻成可操作提示:${JSON.stringify(message)}`);
  if (!message.includes("for security reasons")) ok("不再透传生硬的 CLI 原始错误");
  else fail(`仍在透传原始错误:${JSON.stringify(message)}`);
}

// 起因(2026-08-29):任务接力到对端后 `--resume` 的会话在对端 CLI 的配置目录里不存在,
// CLI 一行 `{"subtype":"error_during_execution", …, "errors":["No conversation found with
// session ID: …"]}` 就退了 —— `result` 是空的,原因只在 `errors[]` 里。当时解析器只读
// `result`,于是时间线上只剩一句 `result: error_during_execution`:用户看不出发生了什么,
// `session-lost.ts` 那条「no conversation found」的识别也永远匹配不上。
console.log("7) CLI 自身失败时,原因在 errors[] 里,不能只报一句 subtype");
{
  const events = await collect([
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "sess-7",
      errors: ["No conversation found with session ID: edb416ee-d4bc-46c2-9bda-f05fbcc84f87"],
    },
  ]);
  const message = events.find((e) => e.kind === "error")?.message ?? "";
  if (message.includes("No conversation found with session ID")) ok(`errors[] 的原因抬到了 error 上:${message}`);
  else fail(`原因丢了,只剩:${JSON.stringify(message)}`);
  const { isSessionLost } = await import("../src/executors/session-lost.js");
  if (isSessionLost(message)) ok("这条消息能被 session-lost 认出来(失效的会话 id 才清得掉)");
  else fail("session-lost 认不出这条消息");
}

// 起因(2026-09-24):中转网关先 502 再整个不响应,两个任务的回合各停了 47 分钟。CLI
// 一直在退避重试(10 次里退到后面单次就等半分钟),事件流里 `api_retry` 一条不落,而
// 解析器把整个 subtype 丢了 —— 界面上只有一句「智能体委派中」停着不动,跟正常思考
// 长得一模一样。当时用户手上没有任何线索,只剩重启 ash 可试;重启确实让三个任务同时
// 活了过来,但那是因为 1M 请求本就经本机 ash 的 context-1m 代理转发,重启切断了这台
// 机器上全部在途请求、逼 CLI 重连 —— 钝手段,不是处理办法。信号一直都在事件流里。
// 下面这两组事件按现场原样抄。
console.log("8) 上游重试必须看得见,且不把仍在进行的回合判成失败");
{
  const retries = [1, 2, 3].map((attempt) => ({
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: 10,
    retry_delay_ms: attempt === 1 ? 547 : attempt * 2000,
    error_status: null,
    error: "unknown",
    session_id: "sess-8",
  }));
  const events = await collect([
    { type: "system", subtype: "init", session_id: "sess-8" },
    ...retries,
    { type: "system", subtype: "api_retry", attempt: 9, max_retries: 10, retry_delay_ms: 32964, error_status: 502, error: "server_error", session_id: "sess-8" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "接着干\n" } } },
    { type: "result", subtype: "success", session_id: "sess-8" },
  ]);
  const notices = events.filter((e) => e.kind === "system" && e.level === "notice");
  if (notices.length === 4) ok("每一次重试都留下了一条旁注(同时是「还活着」的心跳)");
  else fail(`期望 4 条重试旁注,实到 ${notices.length}`);
  // 关键:**一条 error 都不许有**。重试是可恢复状态,不是故障 —— 走 error 会被
  // duet 的 failed() 判成整场讨论失败,也会在普通任务/团队界面渲染成红叉(第 1 轮审查)。
  if (!events.some((e) => e.kind === "error")) ok("重试不产生 error:duet 不会把成功回合判失败,界面也不显示红叉");
  else fail(`重试仍在发 error:${events.filter((e) => e.kind === "error").map((e) => e.message).join(" / ")}`);
  if (notices.every((e) => typeof e.at === "string" && e.at)) ok("旁注带时间戳,刷新后仍留在时间线上");
  else fail(`旁注缺 at:${JSON.stringify(notices.map((e) => e.at))}`);
  if (notices[0]?.text?.includes("第 1/10 次")) ok(`第几次、还要等多久都说清了:${notices[0].text}`);
  else fail(`没说清重试进度:${JSON.stringify(notices[0]?.text)}`);
  if (!notices.some((e) => e.text.includes("unknown"))) ok("连接挂住时不把生硬的 unknown 透给用户");
  else fail(`透传了 unknown:${notices.find((e) => e.text.includes("unknown"))?.text}`);
  if (notices[3]?.text?.includes("502")) ok(`上游给了状态码就报出来:${notices[3].text}`);
  else fail(`502 丢了:${JSON.stringify(notices[3]?.text)}`);
  const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
  if (text.includes("接着干")) ok("重试成功后回合照常继续");
  else fail(`重试之后正文丢了:${JSON.stringify(text)}`);
}

// 同一次事故的另一半:BRw9 那个回合根本没走到重试 —— 请求发出去,`status:"requesting"`
// 之后 47 分钟一个事件都没有。只接 api_retry 对这种情况一点用都没有。
console.log("9) 等上游等到超时无响应要自己冒头,而工具在跑不算");
{
  const stalled = await collectHanging(
    [
      { type: "system", subtype: "init", session_id: "sess-9" },
      { type: "system", subtype: "status", status: "requesting", session_id: "sess-9" },
    ],
    3_000,
    1_200,
  );
  const notices = stalled.filter((e) => e.kind === "system" && e.level === "notice");
  if (notices.length >= 1) ok(`静默等待自己冒了头:${notices[0].text}`);
  else fail("等上游等到天荒地老,界面上仍然一个字都没有");
  if (!stalled.some((e) => e.kind === "error")) ok("等待期的提示不是故障,不把回合判失败");
  else fail(`等待期冒出了 error:${stalled.filter((e) => e.kind === "error").map((e) => e.message).join(" / ")}`);
  if (notices.length <= 5) ok(`每满一个间隔才报一次,没刷成滚屏(${notices.length} 条)`);
  else fail(`静默提示刷屏了:${notices.length} 条`);

  // 现场的真实序列是 requesting → api_retry × N,中间**不再有新的 requesting**。
  // 把 retry 当「别的事件」解除等待,等于第一次失败之后心跳永久熄火,而那之后每一次
  // 重试请求同样可能挂住 —— 静默场景原样回来(第 1 轮审查 P2)。
  const retriedThenHung = await collectHanging(
    [
      { type: "system", subtype: "init", session_id: "sess-10" },
      { type: "system", subtype: "status", status: "requesting", session_id: "sess-10" },
      { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 546, error_status: null, error: "unknown", session_id: "sess-10" },
    ],
    3_000,
    1_200,
  );
  const afterRetry = retriedThenHung.filter((e) => e.kind === "system" && e.level === "notice" && e.text.includes("没有响应，本回合仍在等待中"));
  if (afterRetry.length >= 1) ok(`重试之后再挂住,心跳照样冒头:${afterRetry[0].text}`);
  else fail("第一次重试就把心跳解除了,之后的挂起又变回彻底静默");

  // 反面:工具在跑(最后一件事不是等 API)同样长时间零事件,一个字都不该报。
  const working = await collectHanging(
    [
      { type: "system", subtype: "init", session_id: "sess-11" },
      { type: "system", subtype: "status", status: "requesting", session_id: "sess-11" },
      { type: "assistant", message: { model: "claude-opus-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest" } }] } },
    ],
    3_000,
    1_200,
  );
  const falseAlarms = working.filter((e) => (e.kind === "system" && e.level === "notice") || e.kind === "error");
  if (!falseAlarms.length) ok("工具跑得久不会被误报成「上游没响应」");
  else fail(`误报了:${falseAlarms.map((e) => e.text ?? e.message).join(" / ")}`);
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过");
process.exit(bad ? 1 : 0);
