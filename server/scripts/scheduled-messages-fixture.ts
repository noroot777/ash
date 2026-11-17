import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS } from "../src/platform.js";

export function installFakeClaude(root: string): string {
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "fake-claude.js"),
    `const fs = require("fs");
// 常驻档只在 stdin 结束时退出，而 detached 起法的壳用读写方式打开 fifo，stdin 永远等不到 EOF；
// 测试中途收场时没人来关它，它就成了 PPID=1 的孤儿。测试收尾会删掉整个临时目录，所以以
// 「日志所在目录没了」为准自行退出。
const stage = process.env.ASH_TEST_LEAD_LOG && require("path").dirname(process.env.ASH_TEST_LEAD_LOG);
if (stage) setInterval(() => { if (!fs.existsSync(stage)) process.exit(0); }, 500).unref();
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

/**
 * 给假目录再铺几个「一起就退」的垫片（codex、gemini…），并核对这几个名字此刻解析到的就是它们。
 *
 * 只铺假 claude 不够：找可执行文件除了 PATH 还会看 /opt/homebrew/bin 这些常见安装目录
 * （executors/bin-resolve.ts 的 extraPaths），而放行真执行器的测试（ASH_ALLOW_REAL_AGENT=1）
 * 一旦把任务交给别家，装着那家 CLI 的机器上就会拿着测试正文真起一个回合——
 * test-dispatch-plan 在 2026-11-15～16 这样起过 54 个真 codex 会话。
 */
export async function installExitingClis(fakeBin: string, names: string[]): Promise<void> {
  for (const name of names) {
    writeFileSync(
      join(fakeBin, IS_WINDOWS ? `${name}.cmd` : name),
      IS_WINDOWS ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
  }
  const { resolveBin } = await import("../src/executors/bin-resolve.js");
  for (const name of ["claude", ...names]) {
    const resolved = resolveBin(name);
    if (!resolved || !resolved.startsWith(fakeBin)) {
      throw new Error(`${name} 解析到了 ${resolved ?? "（找不到）"}，不是测试铺的假 CLI：假目录必须排在 PATH 最前`);
    }
  }
}
