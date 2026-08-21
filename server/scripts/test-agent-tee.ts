// 管道路径上的 stdout tee(executors/spawn.ts 的 teeStdout)。
//
// 为什么值得一条独立测试:这个 tee 是 Windows 砍掉「活得过重启」之后,交卷补捞
// (mcp-handoff.ts 的 replayUndeliveredMcpCalls)唯一的输入来源。它一旦不写,一个
// 调过 complete_task 的任务会被记成 failed —— 而且**没有任何报错**,只能靠这条钉子
// 提前发现。
//
// 两条保证各钉一条:
//  ① 落盘的字节 = agent 真正吐出来的字节(补捞才扫得到 complete_task)
//  ② **晚挂的消费者一个字节不丢** —— 各 executor 的解析器是 spawn 之后才挂 'data'
//     的。当初若图省事写成 `stdout.pipe(ws)`,原流会立刻进 flowing 模式,这中间冒出
//     来的行就永久蒸发了;网页上表现为「开头几行没了」,极难往回查。
// 跑:npm -w server run test:agent-tee
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnAgent } from "../src/executors/spawn.js";

const root = mkdtempSync(join(tmpdir(), "ash-tee-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const LINES = ["{\"type\":\"a\"}", "{\"type\":\"b\"}", "{\"type\":\"c\"}"];
const EXPECTED = LINES.map((l) => `${l}\n`).join("");

async function collect(opts: { delayMs: number }): Promise<{ seen: string; file: string }> {
  // out 文件放进一个还不存在的子目录:tee 要自己把目录建出来(detachedPathsFor 给的
  // 是 runs/<taskId>/… ,首次跑那个目录也是不存在的)。
  const file = join(root, `run-${opts.delayMs}`, "agent-out.jsonl");
  const child = spawnAgent(
    root,
    process.execPath,
    ["-e", `process.stdout.write(${JSON.stringify(EXPECTED)});`],
    "",
    undefined,
    { teeOut: file },
  );
  // close 的监听必须**同步**挂上:子进程比 delayMs 先跑完时,事件早就发过了,晚挂
  // 的监听等不到(ChildProcess 不补发)。stdout 那边则相反 —— PassThrough 是流,晚挂
  // 照样能把攒着的字节吐出来,这正是本测试要验的东西。
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  if (opts.delayMs) await sleep(opts.delayMs); // 模拟「解析器晚几个 tick 才挂上来」
  let seen = "";
  child.stdout?.on("data", (c: Buffer) => {
    seen += c.toString();
  });
  await closed;
  await sleep(50); // 等 sink 落盘
  return { seen, file };
}

{
  const { seen, file } = await collect({ delayMs: 0 });
  assert.equal(seen, EXPECTED, "同步挂上的消费者应当收到完整输出");
  assert.equal(readFileSync(file, "utf8"), EXPECTED, "落盘内容要和 agent 吐出来的一模一样");
}

{
  const { seen, file } = await collect({ delayMs: 120 });
  assert.equal(seen, EXPECTED, "晚 120ms 才挂的消费者也不能少字节(这就是不用 pipe() 的原因)");
  assert.equal(readFileSync(file, "utf8"), EXPECTED, "晚挂消费者不影响落盘");
}

// 没给 teeOut 就该完全是原来那条管道路径:不建目录、不留文件。
{
  const child = spawnAgent(root, process.execPath, ["-e", "process.stdout.write('x')"], "");
  let seen = "";
  child.stdout?.on("data", (c: Buffer) => {
    seen += c.toString();
  });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  assert.equal(seen, "x", "不给 teeOut 时 stdout 照常直通");
}

console.log("agent tee tests passed");
