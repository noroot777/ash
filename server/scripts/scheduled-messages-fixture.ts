import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS } from "../src/platform.js";

export function installFakeClaude(root: string): string {
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "fake-claude.js"),
    `const fs = require("fs");
let buf = "";
const resident = process.argv.includes("--input-format");
let initialized = false;
function init() {
  if (initialized) return;
  initialized = true;
  process.stdout.write(JSON.stringify({ type: "system", session_id: "scheduled-message-test" }) + "\\n");
}
function result(subtype = "success") {
  process.stdout.write(JSON.stringify({
    type: "result", subtype, session_id: "scheduled-message-test",
    ...(subtype === "success" ? {} : { is_error: true, result: "interrupted" }),
  }) + "\\n");
}
function delta(text) {
  process.stdout.write(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  }) + "\\n");
}
function succeed(input, exit = true) {
  fs.appendFileSync(process.env.ASH_TEST_LEAD_LOG, input + "\\n");
  init();
  result();
  if (exit) process.exit(0);
}
function handleResident(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "control_request") {
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id },
    }) + "\\n");
    return result("error_during_execution");
  }
  const text = message.message?.content?.map((part) => part.text || "").join("") || "";
  fs.appendFileSync(process.env.ASH_TEST_LEAD_LOG, line + "\\n");
  init();
  if (text.includes("保持运行等待引导")) {
    delta("旧方向最后一段正文。\\n");
    return;
  }
  if (text.includes("保持新方向运行")) return;
  if (text.includes("先停下旧方案")) delta("新方向第一段正文。\\n");
  result();
  // 团队调度台夹具沿用原行为：一轮结束后进程退出，方便验证收台与补送。
  // 测试进程本身可能继承外层任务的 ASH_TURN_TOKEN，按本测试的任务类型区分才可靠。
  if (!String(process.env.ASH_TASK_ID).startsWith("scheduled-single-")) process.exit(0);
}
process.stdin.on("data", (d) => {
  buf += d;
  if (!resident) return;
  for (;;) {
    const i = buf.indexOf("\\n");
    if (i < 0) return;
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    handleResident(line);
  }
});
process.stdin.on("end", () => {
  if (resident) return process.exit(0);
  if (!process.env.ASH_TURN_TOKEN) return process.exit(9);
  if (buf.includes("保持运行等待引导")) {
    fs.appendFileSync(process.env.ASH_TEST_LEAD_LOG, buf + "\\n");
    process.stdout.write(JSON.stringify({ type: "system", session_id: "scheduled-steer-cli-session" }) + "\\n");
    setInterval(() => {}, 1000);
    return;
  }
  if (buf.includes("保持新方向运行")) {
    fs.appendFileSync(process.env.ASH_TEST_LEAD_LOG, buf + "\\n");
    process.stdout.write(JSON.stringify({ type: "system", session_id: "scheduled-steer-cli-session" }) + "\\n");
    setInterval(() => {}, 1000);
    return;
  }
  if (buf.includes("等待本轮完成确认")) return void setTimeout(() => succeed(buf), 300);
  if (!buf) return process.exit(1);
  succeed(buf);
});
`,
  );
  writeFileSync(
    join(fakeBin, IS_WINDOWS ? "claude.cmd" : "claude"),
    IS_WINDOWS ? `@node "%~dp0fake-claude.js" %*\r\n` : `#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.js" "$@"\n`,
    { mode: 0o755 },
  );
  return fakeBin;
}
