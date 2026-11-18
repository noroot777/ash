import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS } from "../src/platform.js";

/**
 * 等这座舞台起过的假 claude 都退干净（按命令行里的桩路径认）；到点还活着的直接杀掉并说一声。
 * 测试进程一退，它们就成了没人管的孤儿 —— 桩自己那道「目录没了就退」只是兜底，半秒才看一眼。
 * Windows 上没有 ps，那边只剩桩自己的兜底。
 */
export async function settleFakeClaudes(root: string, graceMs = 5_000): Promise<void> {
  if (IS_WINDOWS) return;
  const script = join(root, "bin", "fake-claude.js");
  const alive = () => (spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "").split("\n")
    .filter((line) => line.includes(script)).map((line) => Number(line.trim().split(/\s+/)[0]));
  for (const until = Date.now() + graceMs; Date.now() < until;) {
    if (!alive().length) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const pid of alive()) {
    console.warn(`⚠︎ 假 claude 没自己退，收掉：pid ${pid}`);
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

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
 * 只铺假 claude 时，交给别家的任务会解析到机器上真装着的那家 CLI：找可执行文件除了 PATH 还会看
 * /opt/homebrew/bin 这些常见安装目录（executors/bin-resolve.ts 的 extraPaths）。隔离闸按路径放行
 * （ASH_TEST_AGENT_BIN 只列假目录）之后那一步得到的是一条禁启错误；用例要的是「起得来、一起就退」
 * 才铺这些垫片。闸还是整体放行的时候没有这层保护：test-dispatch-plan 在 2026-11-15～16 拿着测试
 * 正文起过 54 个真 codex 会话。
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
