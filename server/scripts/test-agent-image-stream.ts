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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // ⑦ 引用式图的**定义后到**:`![引用截图][r]` 先到,`[r]: output/shot.png` 随后才到。
  // 按碎片扫的那一版在第一片就给这处引用定了性(还没有定义 → 不是图),扫完又把交代过的
  // 前文裁掉,后到的定义再也修正不了它 —— 拼回来明明有一张图,结果一条都没存(审查第 2
  // 轮 F2 的证明输入)。
  const late = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "![引用截图][r]\n\n[r]: " } as AgentEvent;
    yield { kind: "text", text: "output/shot.png\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(late).map((event) => event.source),
    ["output/shot.png"],
    "定义后到的引用式图要认出来",
  );

  // ⑧ 反过来:一对反引号被切在两片里。前半片里 `![示例](output/shot.png)` 看着是真图,
  // 等后半片的反引号到了它才是行内代码 —— 一条都不许发(发了就会在展示端把附件卡片领走,
  // 而展示端扫完整正文压根不认它)。
  const fenced = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "行内 `![示例](output/shot.png)" } as AgentEvent;
    yield { kind: "text", text: "` 不算图。\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(attachments(fenced).map((event) => event.source), [], "拼全了是行内代码的,一条都不发");

  // ⑨ 脚注里的真截图:方言得跟渲染器一致(核心语法把它当四空格缩进代码 → 0 张,
  // GFM 当脚注正文 → 1 张;渲染器挂的就是 remark-gfm,所以必须是 1)。
  const footnote = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "结论见脚注[^a]。\n\n[^a]: 证据：\n\n    ![脚注截图](output/shot.png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(footnote).map((event) => event.source),
    ["output/shot.png"],
    "脚注里的真截图要认出来(方言跟渲染器一致)",
  );

  // ⑩ 「先拍字节、后认身份」的边界:重拍发生在**引用的文字还没写完**的那一刻。
  // 第一处引用的括号刚闭合(字节=红)→ 文件被改成蓝 → 第二处引用写完。两处引用必须各自
  // 拿到自己那一刻的字节,而不是一起拿收尾时的蓝。
  const mid = join(root, "output", "mid.png");
  const amber = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 3)]);
  const midEvents = await collect(withMarkdownImages((async function* () {
    writeFileSync(mid, red);
    yield { kind: "text", text: "改前：![改前](output/mid.png)" } as AgentEvent;
    writeFileSync(mid, amber);
    yield { kind: "text", text: "\n\n改后：![改后](output/mid.png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const two = attachments(midEvents);
  assert.equal(two.length, 2, "两处引用两条结果");
  assert.deepEqual(readFileSync(two[0]!.path!), red, "第一处引用拿到的是它写完那一刻的字节");
  assert.deepEqual(readFileSync(two[1]!.path!), amber, "第二处引用拿到的是改过之后的字节");

  // ⑪ 攒过窗口要裁时**按块边界裁**:裁掉的只是已经交代过的那几个块,块状态一个都不许被
  // 裁断。上一版按字符数硬裁(留个头 + 留尾),开栏的 ``` 被裁走之后,围栏里的写法示例就
  // 成了「真图」—— 多存一份、多一张卡片,而展示端扫完整正文压根不认它。
  const long = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "真图：![真图](output/shot.png)\n\n" + "填充。\n\n".repeat(2000) } as AgentEvent;
    yield { kind: "text", text: "再一张：![再一张](output/shot.png)\n\n" } as AgentEvent;
    yield { kind: "text", text: "```md\n![示例](output/shot.png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(long).map((event) => [event.source, event.ref]),
    [["output/shot.png", 0], ["output/shot.png", 1]],
    "裁过之后:两处真引用各一条、身份接着往下数,未闭合围栏里的示例一条都不许报",
  );
  // 第一条必须是**攒过窗口、裁走前缀那一刻**交代的(第二处引用在那之后才到,收尾才交代)
  // —— 否则上面那条断言换成「整条消息攒着从不裁」也成立,裁剪这条路压根没被走到。
  const fenceAt = long.findIndex((event) => event.kind === "text" && event.text.startsWith("```md"));
  assert.ok(fenceAt > 0, "围栏那一片要在事件流里");
  assert.equal(
    long.slice(0, fenceAt).filter((event) => event.kind === "attachment").length,
    1,
    "攒过窗口那一刻就把定型的块交代了",
  );

  // ⑫ 拍下来却没人领走的快照要删掉(行内代码跨片那一例:字节在前半片就拍了,拼全了却是
  // 代码)。留着就是谁都引用不到的磁盘垃圾。
  const before = readdirSync(uploads).length;
  await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "行内 `![示例](output/result(1).png)" } as AgentEvent;
    yield { kind: "text", text: "` 不算图。\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.equal(readdirSync(uploads).length, before, "没人领走的拷贝不许留在 uploads 里");

  // ⑬ 一个块自己就超过天花板(一整份日志灌进一个段落):放弃管这条消息 —— 一条事件都不发,
  // 展示端把这几处引用当成「服务端没管过」,退一档去工作目录取。宁可退档,也不按半截正文
  // 定性。正文仍然一个字都不许改动或吞掉。
  const huge = "开头 ![真图](output/shot.png) " + "填充 ".repeat(400_000);
  const overflowed = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: huge } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(attachments(overflowed), [], "裁不动就放弃管,不按半截正文发结果");
  assert.equal(
    overflowed.filter((event) => event.kind === "text").map((event) => (event as { text: string }).text).join(""),
    huge,
    "放弃管的只是落图,正文照旧原样转发",
  );

  console.log("自定义解析器的图片落盘回归通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
