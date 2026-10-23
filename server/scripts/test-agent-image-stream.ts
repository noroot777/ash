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
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { parseClaudeStream } = await import("../src/executors/claude.js");
const { GenericCliExecutor } = await import("../src/executors/generic.js");
const { withMarkdownImages } = await import("../src/executors/markdown-image-stream.js");
const { childActivity } = await import("../src/executors/native-agent-activity.js");

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

/**
 * **慢消费者**:每收一条事件就办一会儿自己的事(真实消费者在正文上要等 `resolveTitle`、
 * 等落库)。记账挂在「消费者取到这条事件那一刻」时,这点等待就足以让字节读成后来那张
 * (审查第 5 轮 R1)。
 */
async function collectSlowly(events: AsyncIterable<AgentEvent>, delay: number): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) {
    out.push(event);
    await new Promise((done) => setTimeout(done, delay));
  }
  return out;
}

/** 上游抛错时:已经送到手里的事件和那个异常都要拿到。 */
async function collectUntilThrow(events: AsyncIterable<AgentEvent>): Promise<{ events: AgentEvent[]; error: unknown }> {
  const out: AgentEvent[] = [];
  try {
    for await (const event of events) out.push(event);
    return { events: out, error: null };
  } catch (error) {
    return { events: out, error };
  }
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

  // ⑪ 攒过窗口时往前挪的是**重解析的窗口**,正文一个字都不裁。窗口按块边界挪,块状态一个
  // 都不许被挪断 —— 上一版按字符数硬裁(留个头 + 留尾),开栏的 ``` 被裁走之后,围栏里的
  // 写法示例就成了「真图」:多存一份、多一张卡片,而展示端扫完整正文压根不认它。
  //
  // 另一半是**窗口挪过去之后,前面那几处引用的字节还在**:挪窗口只是不再重解析那一段,
  // 不是把它交代掉、更不是把它拍下来的字节扔掉。扔掉的那一版会让「修改前」那一处退回
  // 收尾时重读文件,于是画出来是后来的蓝图(审查第 3 轮 R1 反例二的同类)。
  writeFileSync(shot, red);
  const long = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "真图：![真图](output/shot.png)\n\n" + "填充。\n\n".repeat(2000) } as AgentEvent;
    writeFileSync(shot, blue);
    yield { kind: "text", text: "再一张：![再一张](output/shot.png)\n\n" } as AgentEvent;
    yield { kind: "text", text: "```md\n![示例](output/shot.png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const longShots = attachments(long);
  assert.deepEqual(
    longShots.map((event) => [event.source, event.ref]),
    [["output/shot.png", 0], ["output/shot.png", 1]],
    "挪过窗口之后:两处真引用各一条、身份接着往下数,未闭合围栏里的示例一条都不许报",
  );
  assert.deepEqual(readFileSync(longShots[0]!.path!), red, "窗口挪过去了,第一处引用那一刻的字节照旧是它自己的");
  assert.deepEqual(readFileSync(longShots[1]!.path!), blue, "第二处引用是改过之后的");
  // **语法一定型就交代**,不等文档收尾:交代的权威依据是整篇扫描,但扫描结论只在「这一块
  // 已经写完」之后才不会被后文推翻(见 shared 的 stableBlockBoundary)。所以两处真引用在
  // 围栏那一片之前就该交代完 —— 等到收尾才发的那一版,消费者半路不取了(用户停任务、落库
  // 抛错)时这两条记录从来没出过门,而清理垃圾那一步又把拷贝删了(审查第 6 轮 R3)。
  // 未闭合的围栏反过来:它那一块压根没定型,一条都不许提前发。
  const fenceAt = long.findIndex((event) => event.kind === "text" && event.text.startsWith("```md"));
  assert.ok(fenceAt > 0, "围栏那一片要在事件流里");
  assert.equal(
    long.slice(0, fenceAt).filter((event) => event.kind === "attachment").length,
    2,
    "语法已经定型的那两处,文档没收尾也要先交代出去",
  );
  assert.equal(
    long.filter((event) => event.kind === "attachment").length,
    2,
    "未闭合围栏里的示例不许凑数",
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

  // ⑬ 一个块自己就超过天花板(一整份日志灌进一个段落):窗口挪不动,于是这一段**不再逐片
  // 重解析**(否则每来一片都要把这一兆重扫一遍)。但「有没有这张图」照旧由收尾那一遍整篇
  // 扫描说了算 —— 上一版在这里放弃整份文档、一条事件都不发,于是一条正常正文只因为后面跟
  // 了一大坨日志就失去全部持久副本。正文仍然一个字都不许改动或吞掉。
  const huge = "开头 ![真图](output/shot.png) " + "填充 ".repeat(400_000);
  const overflowed = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: huge } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(overflowed).map((event) => [event.source, !!event.path]),
    [["output/shot.png", true]],
    "块大到不值得逐片重解析,也不等于这张图不存在",
  );
  assert.equal(
    overflowed.filter((event) => event.kind === "text").map((event) => (event as { text: string }).text).join(""),
    huge,
    "正文照旧原样转发",
  );

  // ⑭ 裁剪必须**保住留下来那一段的快照**。红图引用在最后一段里,后面追 8200 字触发裁剪
  // —— 那一刻它还没被交代,快照一清空就等于「字节丢了」:工具随后把文件改蓝,收尾那一遍
  // 重新读文件,两处引用一起画成蓝图(审查第 3 轮 R1 实测反例二)。
  const keep = join(root, "output", "keep.png");
  writeFileSync(keep, red);
  const retained = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: `前言。\n\n修改前应为红色：![修改前](output/keep.png)${"填".repeat(8200)}` } as AgentEvent;
    writeFileSync(keep, blue);
    yield { kind: "tool", name: "exec", detail: "重新截图" } as AgentEvent;
    yield { kind: "text", text: "\n\n修改后为蓝色：![修改后](output/keep.png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const kept = attachments(retained);
  assert.equal(kept.length, 2, "两处引用两条结果");
  assert.deepEqual(readFileSync(kept[0]!.path!), red, "裁剪保住了「说那句话时」的红图");
  assert.deepEqual(readFileSync(kept[1]!.path!), blue, "第二处引用是改过之后的蓝图");

  // ⑮ 引用式图的**定义分两片到达**,后一片一个标点都不带(`[r]: ` + `output/def.png`)。
  // 那一片不沾 `)`/`]`/换行,靠「还在写的定义行」这一档才会去扫 —— 漏掉它,这处引用的字节
  // 要等到下一片带标点时才拍,中间工具把文件重拍一遍,红图就记成蓝图(R1 实测反例一)。
  const def = join(root, "output", "def.png");
  writeFileSync(def, red);
  const bare = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "修改前是红色：![修改前][r]\n\n[r]: " } as AgentEvent;
    yield { kind: "text", text: "output/def.png" } as AgentEvent;
    writeFileSync(def, blue);
    yield { kind: "tool", name: "exec", detail: "重新截图" } as AgentEvent;
    yield { kind: "text", text: "\n\n修改后是蓝色：![修改后](output/def.png)" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const defs = attachments(bare);
  assert.equal(defs.length, 2, "引用式图和行内图各一条");
  assert.deepEqual(readFileSync(defs[0]!.path!), red, "定义刚写完那一刻就把红图拍下来了");
  assert.deepEqual(readFileSync(defs[1]!.path!), blue, "后一处引用是蓝图");

  // ⑮b 同一形状落在**放慢档**里(第 9 轮复审第 2 轮 R2 longBareDefinition):先铺 100 KB 的
  // 超长块,窗口已经畸形地大,此后每一片都走 freezeTail。`output/def2.png` 这一片一个标点都
  // 没有,快速闸若只认 `)`/`]`/换行就直接 return —— 快车道的「还在写的定义行」第四档在放慢
  // 档同样得有,否则短正文拍到红图、长正文等到重拍后的蓝图,同一份语义两个结果。
  const def2 = join(root, "output", "def2.png");
  writeFileSync(def2, red);
  const bareSlow = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "修改前是红色：![修改前][r2]\n\n" } as AgentEvent;
    yield { kind: "text", text: "铺".repeat(100_000) } as AgentEvent;
    yield { kind: "text", text: "\n\n[r2]: " } as AgentEvent;
    yield { kind: "text", text: "output/def2.png" } as AgentEvent;
    writeFileSync(def2, blue);
    yield { kind: "text", text: "\n\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const defsSlow = attachments(bareSlow);
  assert.equal(defsSlow.length, 1, "放慢档里的引用式图同样有一条结果");
  assert.deepEqual(readFileSync(defsSlow[0]!.path!), red, "定义目的地刚写完那一刻(放慢档)就拍下红图");

  // ⑯ 定义**隔着多远**才到,都得认得回那处引用:`![真实][shot]` 在最前面,定义在 70 KB
  // 之后。那处引用在解析树里还只是一段普通文字(定义没到之前压根不是图片节点),正文一
  // 按距离裁走,定义再到也没人认领它 —— 这份文档从此没有持久副本,原图一清理就彻底没了。
  //
  // 距离**没有上限**,所以任何「攒到 N 就裁」的数都是在猜:上一版猜 32 KB,70 KB 的同一份
  // 内容就从 1 条结果变成 0 条(审查第 5 轮 R2A 实测:177 字 → 1 条,70037 字 → 0 条)。
  // 现在正文整份留着,这里的长度只是「比当年那个数大得多」,不是新的那个数。
  const lateDefinition = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "真实引用：![真实][shot]\n\n" + "普通正文。\n\n".repeat(6000) } as AgentEvent;
    yield { kind: "text", text: "[shot]: output/shot.png\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(lateDefinition).map((event) => [event.source, !!event.path]),
    [["output/shot.png", true]],
    "隔了 70 KB 的定义仍然认得回那处引用,而且真留下了副本",
  );

  // ⑰ 正文里一句孤零零的 `![从未定义]` 永远不会有定义。它既不该把这份文档拖垮,也不该让
  // 同一份文档里**真**的那张图漏掉 —— 收尾那一遍按整篇认,它本来就不是图片节点。
  const stray = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "孤零零 ![从未定义] 一句。\n\n" + "填充。\n\n".repeat(7000) } as AgentEvent;
    yield { kind: "text", text: "真图：![真图](output/shot.png)\n\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(stray).map((event) => event.source),
    ["output/shot.png"],
    "没有定义的候选只压一段距离,不拖垮同一条消息里真的那张图",
  );

  // ⑱ 字节读到了、写盘失败了(盘满、权限)= 这一刻的画面**丢了**,结果里要带 `lost`。
  // 展示端据此显式作废那一处,而不是拿「现在的文件」去画 —— 文件可能已经被重拍过,那就是
  // 把后来的画面当成旧结论(审查第 3 轮 R1 同类位置)。
  chmodSync(uploads, 0o500);
  let lostEvents: AgentEvent[];
  try {
    lostEvents = await collect(withMarkdownImages((async function* () {
      yield { kind: "text", text: "存不下去：![存不下](output/shot.png)\n" } as AgentEvent;
      yield { kind: "done", exitStatus: 0 } as AgentEvent;
    })(), root));
  } finally {
    chmodSync(uploads, 0o700);
  }
  assert.deepEqual(
    attachments(lostEvents).map((event) => [event.source, event.path, event.lost]),
    [["output/shot.png", undefined, true]],
    "写盘失败要如实报成「这一刻的字节丢了」",
  );

  // ⑲ **定义在前、引用在后,中间隔着一次裁剪**。`[r]: output/pre.png` 先到,11 KB 普通正文
  // 把它顶过窗口被裁走,之后才出现 `![前置定义][r]`。定义是**整篇文档的**,按块边界裁剪
  // 只保证块结构不被切断,证明不了「留下来这几个块不再依赖裁走的那几个」—— 定义一裁走,
  // 后面那处引用在解析树里连图片节点都不是,这条消息从此没有持久副本,原图一清理就彻底
  // 没了(审查第 3 轮 R2 实测:完整正文 1 处真图、服务端 0 条结果)。窗口从 8 KB 放到
  // 32 KB 同样不解决:那是在猜距离,而距离没有上限。所以裁剪方把定义**带着走**。
  const pre = join(root, "output", "pre.png");
  writeFileSync(pre, red);
  const definitionPrefix = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "[r]: output/pre.png\n\n" + "普通正文。\n\n".repeat(1600) } as AgentEvent;
    yield { kind: "text", text: "![前置定义][r]\n" } as AgentEvent;
    // 说完那句话之后文件被重拍 —— 字节必须是**说那句话时**的那一张。
    writeFileSync(pre, blue);
    yield { kind: "tool", name: "exec", detail: "重新截图" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const prefixed = attachments(definitionPrefix);
  assert.deepEqual(
    prefixed.map((event) => event.source),
    ["output/pre.png"],
    "窗口之外的链接引用定义要带着走,否则这处引用在窗口里压根不是图片节点",
  );
  assert.deepEqual(readFileSync(prefixed[0]!.path!), red, "带着定义走,字节才拍得在「说那句话的那一刻」");

  // ⑲b 带着走的是**定义环境**,不是正文:定义自己不产生任何可见节点,所以不许凭空多出
  // 一处引用,也不许把同名定义的后一条顶掉(CommonMark 取第一条)。
  const sameName = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "[r]: output/pre.png\n\n" + "普通正文。\n\n".repeat(1600) } as AgentEvent;
    yield { kind: "text", text: "[r]: output/shot.png\n\n![同名][r]\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(sameName).map((event) => event.source),
    ["output/pre.png"],
    "同名定义照 CommonMark 取第一条(也就是被裁走的那条),而且只有一处引用",
  );

  // ⑲c 定义写在**容器里**(引用块、列表项),而且目的地折到了下一行 —— 带着走只能带它的
  // 语义。照抄源码切出来的是 `[nested]:\n>   output/cross.svg`,离开那个引用块之后第二行
  // 的 `>` 成了正文,它再也不是一条定义:携带等于没携带,后面那处引用一条结果都发不出来
  // (审查第 4 轮 R2 实测:完整正文 1 处真图、最终 attachment 为 0)。
  const nested = join(root, "output", "cross.svg");
  writeFileSync(nested, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  const containerDefinition = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "> [nested]:\n>   output/cross.svg\n\n" + "普通正文。\n\n".repeat(1600) } as AgentEvent;
    yield { kind: "text", text: "![容器定义][nested]\n" } as AgentEvent;
    writeFileSync(nested, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" id="after"/>'));
    yield { kind: "tool", name: "exec", detail: "重新截图" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const carried = attachments(containerDefinition);
  assert.deepEqual(
    carried.map((event) => event.source),
    ["output/cross.svg"],
    "容器里的定义重写出来的那一行仍然是一条定义",
  );
  assert.deepEqual(
    readFileSync(carried[0]!.path!).toString(),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    "重写出来的定义真的生效了,字节才拍在说那句话的那一刻",
  );

  // ⑲d 重写出来的定义要跟原来**指同一个地方**:带空格的目的地、折行、大小写不同的引用,
  // 一处都不许走丢(目的地一律用 `<>` 包起来,标识符用归一化后的那一份)。
  const spaced = join(root, "output", "cross shot.svg");
  writeFileSync(spaced, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  const trickyDefinition = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "- [Mixed Case]:\n  <output/cross shot.svg>\n\n" + "普通正文。\n\n".repeat(1600) } as AgentEvent;
    yield { kind: "text", text: "![带空格][mixed case]\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(trickyDefinition).map((event) => [event.source, !!event.path]),
    [["output/cross shot.svg", true]],
    "列表项里的定义、带空格的目的地、大小写不同的引用都要对得上",
  );

  // ⑳ **写盘失败是单调的**:第一处引用的字节读到了、存不下来(临时权限失败),之后文件被
  // 重拍成蓝色、权限也恢复了 —— 那一处仍然必须报成「丢了」,不许被后面任何一遍扫描洗成
  // 蓝图。流式阶段每来一片都会重扫同一段正文,少了这道单调性,收尾那一遍(或者下一片的
  // 捕获)就会重新读盘,于是「修改前」那一处画出来是修改后的蓝图 —— 比不画更坏
  // (审查第 3 轮 R1:期望 `[LOST, BLUE]`,实际 `[BLUE, BLUE]`)。
  const flaky = join(root, "output", "flaky.png");
  writeFileSync(flaky, red);
  chmodSync(uploads, 0o500);
  let flakyEvents: AgentEvent[];
  try {
    flakyEvents = await collect(withMarkdownImages((async function* () {
      yield { kind: "text", text: "修改前应为红色：![修改前](output/flaky.png)\n\n" } as AgentEvent;
      // 这一刻盘能写了,而文件已经被重拍成蓝色 —— 两件事同时恢复才是真实现场。
      chmodSync(uploads, 0o700);
      writeFileSync(flaky, blue);
      yield { kind: "tool", name: "exec", detail: "重新截图" } as AgentEvent;
      yield { kind: "text", text: "修改后为蓝色：![修改后](output/flaky.png)\n" } as AgentEvent;
      yield { kind: "done", exitStatus: 0 } as AgentEvent;
    })(), root));
  } finally {
    chmodSync(uploads, 0o700);
  }
  const flakyShots = attachments(flakyEvents);
  assert.equal(flakyShots.length, 2, "两处引用两条结果");
  assert.deepEqual(
    [flakyShots[0]!.path, flakyShots[0]!.lost],
    [undefined, true],
    "第一处引用那一刻的字节丢了就一直是丢了 —— 不许在后面某一遍扫描里重新读盘捡回来",
  );
  assert.deepEqual(readFileSync(flakyShots[1]!.path!), blue, "第二处引用照常拿到蓝图");

  // ㉑ **专用适配器也按「一份文档」认身份**(审查第 4 轮 R2 第 1、2 行)。
  //
  // claude / codex 这几家原先逐 text block 调 persistMarkdownImages:上一条模型消息给定义、
  // 下一条引用它时,展示端按整条正文解析得出一张图,保存端按单条消息解析压根不认 —— 那张图
  // 没有持久副本,原文件一清理就彻底没了(实测:claude 主链 attachment 为 0,同样内容交给
  // generic 流是 1)。「模型的一条消息结束了」证明不了「这一段能独立解释 Markdown」。
  //
  // 这一条从真起一个假 CLI 进程那一端验:两条 assistant 消息,定义在前、引用在后。
  const crossMessage = join(root, "output", "cross.svg");
  writeFileSync(crossMessage, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  const claudeLines = (lines: unknown[]) => {
    const script = join(root, `claude-stub-${Math.random().toString(36).slice(2, 8)}.mjs`);
    writeFileSync(script, lines.map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + "\n")});`).join("\n"));
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin?.end();
    return parseClaudeStream(child as never, undefined, "claude", undefined, null, undefined, undefined, undefined, root);
  };
  /** 一条模型消息:文本走 delta(真 claude 就是这样),末尾那条 assistant 收口成一段。 */
  const assistantMessage = (text: string, parent?: string) => [
    { type: "stream_event", ...(parent ? { parent_tool_use_id: parent } : {}), event: { type: "content_block_delta", delta: { type: "text_delta", text } } },
    { type: "assistant", ...(parent ? { parent_tool_use_id: parent } : {}), message: { model: "claude-fixture", content: [{ type: "text", text }] } },
  ];
  const crossEvents = await collect(claudeLines([
    ...assistantMessage("[proof]: output/cross.svg\n"),
    ...assistantMessage("![跨消息截图][proof]\n"),
  ]));
  const crossShots = attachments(crossEvents);
  assert.deepEqual(
    crossShots.map((event) => [event.source, !!event.path]),
    [["output/cross.svg", true]],
    "定义写在上一条消息、引用写在下一条时,claude 这条链也必须认出这张图",
  );

  // ㉑b 子智能体那份抽屉正文是**另一份文档**:它自己的跨消息定义要认,而主会话的定义
  // 不许泄到它那儿去(两份正文在同一条事件流里交错到达,混在一起扫就会凭空多出/少掉
  // 图片节点)。
  const childShot = join(root, "output", "child.svg");
  writeFileSync(childShot, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" role="img"/>'));
  const childEvents = await collect(claudeLines([
    ...assistantMessage("[main-only]: output/cross.svg\n"),
    ...assistantMessage("[c]: output/child.svg\n", "toolu_child"),
    ...assistantMessage("![子图][c]\n", "toolu_child"),
    ...assistantMessage("![抢主会话的定义][main-only]\n", "toolu_child"),
  ]));
  const childAttachments = childEvents.flatMap((event) => {
    const work = event.kind === "tool" ? event.nativeWork : undefined;
    return work?.type === "activity" && work.event.kind === "attachment" ? [{ id: work.id, ...work.event }] : [];
  });
  assert.deepEqual(
    childAttachments.map((event) => [event.id, event.source, !!event.path]),
    [["toolu_child", "output/child.svg", true]],
    "子智能体的跨消息定义要认,主会话的定义不许被它用上",
  );
  assert.deepEqual(attachments(childEvents).map((event) => event.source), [], "主会话这一侧只有定义、没有引用");

  // ㉒ **字节在协议读到那一行的那一刻就冻住,跟消费者快慢无关**(审查第 5 轮 R1)。
  //
  // 三家专用适配器都是「readline 收到一行 → push 进 queue → 消费者自己来取」。记账挂在
  // 下游取事件那一刻时,从 CLI 吐出那一行到我们去读文件之间隔着整条队列和一次可暂停的
  // yield —— 中间 agent 完全来得及把同一个路径重拍一遍,于是正文写着「修改前是红色」、
  // 存下来的是后来那张蓝图。实测反例:同一份正文、同一个假 CLI,只把消费端每条事件之后的
  // 等待从 0 改成 240 ms,两处引用的字节就一起变成蓝色(两条记录甚至指向同一份拷贝)。
  const timing = join(root, "output", "timing.png");
  const stub = join(root, "claude-timing.mjs");
  const line = (payload: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(payload) + "\n")});`;
  const message = (text: string) => [
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } },
    { type: "assistant", message: { model: "claude-fixture", content: [{ type: "text", text }] } },
  ];
  writeFileSync(stub, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(timing)}, Buffer.from(${JSON.stringify(red.toString("base64"))}, "base64"));`,
    // 先说一句别的:消费者拿着这一条慢慢办事的那会儿,下面两行早就到了队列里 —— 这正是
    // 「队列先攒着」的真实形状,也是把记账挂在下游时读晚了的那一段窗口。
    ...message("开场白。\n").map(line),
    ...message("修改前是红色：![修改前](output/timing.png)\n").map(line),
    // CLI 自己把文件重拍成蓝色 —— 它跟我们读文件之间的竞争是真的,不是测试摆出来的。
    "await new Promise((done) => setTimeout(done, 120));",
    `writeFileSync(${JSON.stringify(timing)}, Buffer.from(${JSON.stringify(blue.toString("base64"))}, "base64"));`,
    ...message("\n修改后是蓝色：![修改后](output/timing.png)\n").map(line),
  ].join("\n"));
  const timingChild = spawn(process.execPath, [stub], { stdio: ["pipe", "pipe", "pipe"] });
  timingChild.stdin?.end();
  const timed = attachments(await collectSlowly(
    parseClaudeStream(timingChild as never, undefined, "claude", undefined, null, undefined, undefined, undefined, root),
    240,
  ));
  assert.equal(timed.length, 2, "两处引用两条结果");
  assert.deepEqual(readFileSync(timed[0]!.path!), red, "慢消费者也不能把「修改前」读成后来那张蓝图");
  assert.deepEqual(readFileSync(timed[1]!.path!), blue, "第二处引用是改过之后的");
  assert.notEqual(timed[0]!.path, timed[1]!.path, "两处引用各有各的字节,不许指到同一份拷贝");

  // ㉓ 带着走的定义**原样写回标识符**:`[a\*b]` 的标识符里那个反斜杠是源码转义,再转义一遍
  // 就变成了字面反斜杠,同一篇文档里的 `![图][a\*b]` 归一出来跟它对不上(审查第 5 轮 R2B:
  // 完整正文 1 图、带着走之后 0 图)。这里从字节那头验 —— 对不上时那处引用在窗口里压根不是
  // 图片节点,字节就要拖到收尾才读,读到的是重拍之后那张。
  const escaped = join(root, "output", "escaped.png");
  writeFileSync(escaped, red);
  const escapedLabel = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "[a\\*b]: output/escaped.png\n\n" + "普通正文。\n\n".repeat(1600) } as AgentEvent;
    yield { kind: "text", text: "![转义标签][a\\*b]\n" } as AgentEvent;
    writeFileSync(escaped, blue);
    yield { kind: "tool", name: "exec", detail: "重新截图" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const escapedShots = attachments(escapedLabel);
  assert.deepEqual(escapedShots.map((event) => event.source), ["output/escaped.png"], "转义标签的引用照样是一张图");
  assert.deepEqual(readFileSync(escapedShots[0]!.path!), red, "重写出来的定义要跟原来是同一个标识符");

  // ㉔ **父回合收尾不等于子文档收尾**(审查第 5 轮 R2C)。
  //
  // 抽屉里那份正文跨父回合累加成同一份文档(web 的 nativeWorkModel 按同一个 id 合并),
  // 所以上一个回合给定义、这一个回合引用它是真实用法。跟着父回合一起把子账本清掉的那一版,
  // 这处引用连图片节点都不是 —— 展示端整篇解析是 1 图,流里 0 条。
  //
  // 反过来主会话**就是**一回合一份文档(一个回合一个气泡),跨回合的定义本来就不该认。
  const across = join(root, "output", "across.svg");
  writeFileSync(across, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" id="across"/>'));
  const childAcross = await collect(withMarkdownImages((async function* () {
    yield childActivity("toolu_across", { kind: "text", text: "[s]: output/across.svg\n" });
    yield { kind: "text", text: "[m]: output/across.svg\n" } as AgentEvent;
    yield { kind: "turnEnd" } as AgentEvent;
    yield childActivity("toolu_across", { kind: "text", text: "![跨父回合][s]\n" });
    yield { kind: "text", text: "![主会话跨回合][m]\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const acrossChild = childAcross.flatMap((event) => {
    const work = event.kind === "tool" ? event.nativeWork : undefined;
    return work?.type === "activity" && work.event.kind === "attachment" ? [work.event] : [];
  });
  assert.deepEqual(
    acrossChild.map((event) => [event.source, !!event.path]),
    [["output/across.svg", true]],
    "子抽屉跨父回合是同一份文档:上一回合的定义这一回合还认得",
  );
  assert.deepEqual(attachments(childAcross).map((event) => event.source), [], "主会话一回合一份文档,跨回合的定义不该认");

  // ㉔b 子智能体自己收工了,它那份文档当场结账 —— 不必等整条流到头。
  const closing = await collect(withMarkdownImages((async function* () {
    yield childActivity("toolu_close", { kind: "text", text: "![收工截图](output/across.svg)\n" });
    yield { kind: "tool", name: "Agent", nativeWork: { type: "agent", id: "toolu_close", status: "completed" } } as AgentEvent;
    yield { kind: "text", text: "父会话还在说话。\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  const closedAt = closing.findIndex((event) => {
    const work = event.kind === "tool" ? event.nativeWork : undefined;
    return work?.type === "activity" && work.event.kind === "attachment";
  });
  const doneAt = closing.findIndex((event) => event.kind === "done");
  assert.ok(closedAt > 0 && closedAt < doneAt - 1, "子智能体收工那一刻就结账,不是拖到 done");

  // ㉕ **上游抛错也要收口**(审查第 5 轮 R3)。正常收尾那几句被异常跳过,finally 里的清理
  // 就把「字节已经拍下、附件记录还没发出」的拷贝当成无人引用的垃圾删掉 —— 于是刚才还看得
  // 见的截图,清理原图之后再打开就没有了(实测:attachments 为空、新文件 0 个)。
  const crash = join(root, "output", "crash.png");
  writeFileSync(crash, red);
  const crashed = await collectUntilThrow(withMarkdownImages((async function* () {
    yield { kind: "text", text: "崩之前这张图已经在屏幕上了：![崩前](output/crash.png)\n" } as AgentEvent;
    throw new Error("fixture parser failed");
  })(), root));
  assert.match(String((crashed.error as Error)?.message), /fixture parser failed/, "异常照旧往上抛,不许吞掉");
  const crashShots = attachments(crashed.events);
  assert.deepEqual(crashShots.map((event) => event.source), ["output/crash.png"], "抛错之前先把已经露过脸的正文交代完");
  rmSync(crash);
  assert.deepEqual(readFileSync(crashShots[0]!.path!), red, "那份拷贝不许被清理当成垃圾删掉");

  // ㉖ 整窗与尾窗必须同一把尺推进(第 9 轮审查 R2):一大片正文整窗掠过时,同一片里开着
  //   两个未决节点 —— 第一个交代后,回看锚要推进到**下一个未决节点**上,不是直接丢掉。
  //   丢掉的话第二个节点(title 还开着)的后续片回不到上文,终态只能按当下文件重拍:
  //   两张都该是首见那一刻的红图,第二张却成了重写后的蓝图。
  {
    const red26 = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 1)]);
    const blue26 = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 2)]);
    const tail = join(root, "output", "tail.png");
    writeFileSync(tail, red26);
    const events = await collect(withMarkdownImages((async function* () {
      yield { kind: "text", text: "铺垫".repeat(50000) + "\n" } as AgentEvent;
      yield { kind: "text", text: "继续".repeat(9000) + '第一处 ![一](output/tail.png) 第二处 ![二](output/tail.png "' } as AgentEvent;
      for (let index = 0; index < 45; index += 1) yield { kind: "text", text: "说明".repeat(100) } as AgentEvent;
      yield { kind: "text", text: '")\n' } as AgentEvent;
      writeFileSync(tail, blue26);
      yield { kind: "tool", name: "exec", detail: "重拍" } as AgentEvent;
      yield { kind: "done", exitStatus: 0 } as AgentEvent;
    })(), root));
    assert.deepEqual(
      attachments(events).map((event) => [event.source, readFileSync(event.path!).equals(red26) ? "RED" : "BLUE"]),
      [["output/tail.png", "RED"], ["output/tail.png", "RED"]],
      "同片两个未决节点:第一个交代后第二个仍有回看锚,两张都冻在首见那一刻",
    );
  }

  console.log("自定义解析器的图片落盘回归通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
