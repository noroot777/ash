// 「自定义解析器的那十个 CLI,正文里的图到底会不会落盘」—— 审查第 1 轮 F3。
//
// `spec.exec.parser ?? textParser` 是**二选一**:目录里十个 CLI(gemini / kimi / cursor /
// qwen / opencode / kilo / pi / qoder / grok / antigravity)各自内联了一份解析器,只在默认
// 那份里持久化图片,等于十家全漏 —— 同一句话在 claude 上看得见图、换个执行器只剩裂图标。
// 所以持久化挪到了 `withMarkdownImages`,裹在 run 与 attach 共同的出口上。
//
// 这一份从**真的起一个进程**那一端验:任意自定义解析器 + GenericCliExecutor.run,事件流里
// 必须出现带 `source` 的 attachment。另外验流式碎片(半句话分两次到)和去重。
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import type { CliSpec } from "../src/executors/catalog/types.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const root = mkdtempSync(join(tmpdir(), "ash-image-stream-"));
const uploads = join(root, "data", "uploads");
// uploads 目录在 paths.ts 里是模块级常量,所以必须在**导入它之前**改环境变量 —— 静态
// import 会被提到所有语句之前,这里只能动态导。
process.env.ASH_UPLOADS_DIR = uploads;
// claude 执行器要先导:`catalog/parsers.ts` ↔ `executors/claude.ts` ↔ `catalog/claude.ts`
// 是一条既有的循环依赖,从 parsers 这头进去会在 `catalog/claude.ts` 读到还没初始化的
// `claudeStreamJsonParser`(TDZ)。从 claude 这头进去则只需要 import 绑定,能跑通。
await import("../src/executors/claude.js");
const { GenericCliExecutor } = await import("../src/executors/generic.js");
const { withMarkdownImages } = await import("../src/executors/catalog/parsers.js");

/** 只会往事件流里推正文的解析器 —— 那十个内联解析器的共同形状。 */
function textOnlyParser(lines: string[]) {
  return async function* (ctx: { child: ChildProcess }): AsyncIterable<AgentEvent> {
    // 子进程的输出一个字都不读(有的 CLI 的 parser 也只认自己那套 JSON),但要等它退出,
    // 免得留个孤儿进程。
    await new Promise<void>((done) => ctx.child.on("close", () => done()));
    for (const text of lines) yield { kind: "text", text };
    yield { kind: "done", exitStatus: 0 };
  };
}

function spec(parser: CliSpec["exec"]["parser"]): CliSpec {
  return {
    key: "kimi",
    name: "fixture",
    description: "回归夹具",
    bins: ["node"],
    docsUrl: "https://example.invalid",
    installCommand: "—",
    exec: { prompt: { via: "arg" }, baseArgs: ["-e", "process.exit(0)"], parser },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const attachments = (events: AgentEvent[]) =>
  events.filter((event): event is Extract<AgentEvent, { kind: "attachment" }> => event.kind === "attachment");

try {
  mkdirSync(join(root, "output"), { recursive: true });
  const shot = join(root, "output", "shot.png");
  writeFileSync(shot, Buffer.from(PNG_BASE64, "base64"));

  // ① 自定义解析器 + 真起一个进程:attachment 必须出现,且带上「正文哪一句引用的」。
  const executor = new GenericCliExecutor(spec(textOnlyParser(["看这张：![预览](output/shot.png)\n"])));
  const handle = executor.run({ cwd: root, prompt: "noop", trace: undefined } as never);
  const events = await collect(handle.events);
  const stored = attachments(events);
  assert.equal(stored.length, 1, "自定义解析器也必须把正文里的本机图片落盘成附件");
  assert.equal(stored[0]!.source, "output/shot.png", "附件要标明是正文哪一句引用的");
  assert.ok(stored[0]!.path?.startsWith(uploads), "拷贝要落在 uploads 目录里");
  // 正文一个字都不能被改动或吞掉。
  assert.equal(
    events.filter((event) => event.kind === "text").map((event) => (event as { text: string }).text).join(""),
    "看这张：![预览](output/shot.png)\n",
  );

  // ② 流式碎片:一条引用被切成三段到达,仍然要认出来(逐片扫描看不见它)。
  const pieces = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "看这张：![预" } as AgentEvent;
    yield { kind: "text", text: "览](output/sh" } as AgentEvent;
    yield { kind: "text", text: "ot.png)\n完了。" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(pieces).map((event) => event.source),
    ["output/shot.png"],
    "跨碎片的引用要认出来,而且只认一次",
  );

  // ③ 同一处目的地被引用两次(字节没变):**两条都要报**,指向同一份拷贝。
  // 这里曾经断言「只报一次」,而那正是审查第 1 轮 F1 的缺口:展示端按「第 n 处引用 ↔ 第 n
  // 条结果」对账,少一条就得往前顶,于是第二处引用画成别的东西(或者什么都不画)。
  // 字节可以内容寻址去重(两条的 path 相同),**引用关联不能**。
  const repeated = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "先看：![预览](output/shot.png)\n" } as AgentEvent;
    yield { kind: "text", text: "再看一眼：![预览](output/shot.png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const twice = attachments(repeated);
  assert.equal(twice.length, 2, "两处引用两条结果");
  assert.equal(twice[0]!.path, twice[1]!.path, "字节没变就复用同一份拷贝");
  assert.deepEqual(twice.map((event) => event.ref), [0, 1], "两处引用各有自己的身份");

  // ④ 红 → 蓝 → 红:三处引用三条结果,第三条指回第一份拷贝(审查第 1 轮 F1 实测 A)。
  // 「结论说恢复红色、画出来是蓝色」就是这一幕:第三条被按「来源+拷贝」去重掉之后,展示
  // 端队列只剩两条,第三处引用只能往前顶到蓝的那一份。
  const red = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 1)]);
  const blue = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 2)]);
  const retake = join(root, "output", "retake.png");
  const retakeEvents = await collect(withMarkdownImages((async function* () {
    writeFileSync(retake, red);
    yield { kind: "text", text: "改前：![改前](output/retake.png)\n" } as AgentEvent;
    writeFileSync(retake, blue);
    yield { kind: "text", text: "改后：![改后](output/retake.png)\n" } as AgentEvent;
    writeFileSync(retake, red);
    yield { kind: "text", text: "回滚了：![恢复](output/retake.png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const takes = attachments(retakeEvents);
  assert.equal(takes.length, 3, "三处引用三条结果,一条都不许被去重抹掉");
  assert.deepEqual(takes.map((event) => event.ref), [0, 1, 2]);
  assert.notEqual(takes[1]!.path, takes[0]!.path, "蓝的那一张另存一份");
  assert.equal(takes[2]!.path, takes[0]!.path, "恢复红色之后字节跟第一次一样,复用那份拷贝");
  assert.deepEqual(readFileSync(takes[2]!.path!), red, "第三处引用拿到的必须是红的那份字节");

  // ⑤ 写法示例不是图:四空格缩进的那段由渲染器画成代码,服务端一条都不许报
  //(报了就会在展示端把附件卡片领走,正文又画不出来 —— 审查第 1 轮 F2 实测)。
  // 带括号的文件名反过来:它是合法图片,正则那一版把目的地截成 `output/result(1`。
  const parens = join(root, "output", "result(1).png");
  writeFileSync(parens, Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(5)]));
  const semantics = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "写法像这样：\n\n    ![示例](output/shot.png)\n\n" } as AgentEvent;
    yield { kind: "text", text: "真图在这儿：![截图](output/result(1).png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(semantics).map((event) => event.source),
    ["output/result(1).png"],
    "缩进代码里的示例不算图;带括号的文件名要完整认出来",
  );

  // ⑥ 解析器自己挂的附件(工具结果截图那类,没有 source)原样放行,一个都不许吞。
  const passed = await collect(withMarkdownImages((async function* () {
    yield { kind: "attachment", path: join(uploads, "zzzzzzzzzzzz-tool.png") } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(attachments(passed).map((event) => event.source), [undefined]);

  console.log("自定义解析器的图片落盘回归通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
