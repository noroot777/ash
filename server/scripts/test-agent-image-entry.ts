// 「正文里那张图的字节,是不是在**协议读到那一行的那一刻**冻住的」——审查第 5 轮 R1、
// 第 6 轮 R1/R2/R3。
//
// 另一份(test-agent-image-stream.ts)验的是「哪几处算图、存不存得下」。这一份只验**时点
// 与文档身份**,而这两样只有把真的缓冲、真的队列、真的消费者等待摆出来才测得到:
//   · 默认 generic 队列:readline 把文本入队,消费者慢一点取,中间 CLI 把文件重拍;
//   · 短子正文:不到 40 字又没有换行,滞留在子活动合并缓冲里,期间父步骤重拍文件;
//   · 定义离引用很远 / 定义多到装不下一个预算;
//   · 同 id 的子智能体 completed 之后又被唤醒接着说;
//   · 消费者自己抛错(落库失败)时,已经露过脸的那张图不许被当垃圾删掉。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import type { CliSpec } from "../src/executors/catalog/types.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const red = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 1)]);
const blue = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 2)]);
const root = mkdtempSync(join(tmpdir(), "ash-image-entry-"));
const uploads = join(root, "data", "uploads");
// uploads 目录在 paths.ts 里是模块级常量,所以必须在**导入它之前**改环境变量 —— 静态
// import 会被提到所有语句之前,这里只能动态导。
process.env.ASH_UPLOADS_DIR = uploads;
// claude 执行器要先导:`catalog/parsers.ts` ↔ `executors/claude.ts` ↔ `catalog/claude.ts`
// 是一条既有的循环依赖,从 parsers 这头进去会读到还没初始化的 `claudeStreamJsonParser`。
const { parseClaudeStream } = await import("../src/executors/claude.js");
const { GenericCliExecutor } = await import("../src/executors/generic.js");
const { withMarkdownImages } = await import("../src/executors/markdown-image-stream.js");
const { childActivity } = await import("../src/executors/native-agent-activity.js");

const attachments = (events: AgentEvent[]) =>
  events.filter((event): event is Extract<AgentEvent, { kind: "attachment" }> => event.kind === "attachment");
/** 子智能体那份抽屉里的附件(裹了一层 activity)。 */
const childShots = (events: AgentEvent[]) =>
  events.flatMap((event) => {
    const work = event.kind === "tool" ? event.nativeWork : undefined;
    return work?.type === "activity" && work.event.kind === "attachment" ? [{ id: work.id, ...work.event }] : [];
  });
const colorOf = (path: string | undefined) =>
  path === undefined ? "NONE" : readFileSync(path).equals(red) ? "RED" : readFileSync(path).equals(blue) ? "BLUE" : "OTHER";

/**
 * **慢消费者**:每收一条事件就办一会儿自己的事。真实消费者在正文上要等 `resolveTitle`、
 * 要等落库,所以这点等待不是测试摆出来的 —— 它就是队列先攒着的那一段窗口。
 */
async function collectSlowly(events: AsyncIterable<AgentEvent>, delay: number): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (delay) await new Promise((done) => setTimeout(done, delay));
  }
  return out;
}
const collect = (events: AsyncIterable<AgentEvent>) => collectSlowly(events, 0);

/** 一个真起进程的假 CLI:按时间表往 stdout 吐几行,中间自己把文件重拍。 */
function stub(name: string, body: string[]): ReturnType<typeof spawn> {
  const script = join(root, `${name}.mjs`);
  writeFileSync(script, body.join("\n"));
  const child = spawn(process.execPath, [script], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.end();
  return child;
}
const jsonLine = (payload: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(payload) + "\n")});`;
const repaint = (file: string, bytes: Buffer) =>
  `writeFileSync(${JSON.stringify(file)}, Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64"));`;

try {
  mkdirSync(join(root, "output"), { recursive: true });

  // ① **默认 generic 队列**:真的 `GenericCliExecutor.run` + 默认 textParser。
  //
  // readline 收到一行就入队,消费者自己来取。记账挂在「消费者取到这条事件那一刻」时,从
  // 「CLI 吐出那一行」到「我们去读那个文件」之间隔着整条队列和一次可暂停的 yield —— 中间
  // CLI 完全来得及把同一个路径重拍一遍,于是正文写着「修改前是红色」,存下来的是后来那张
  // 蓝图(审查第 6 轮 R1 第 1 例实测:应 RED/BLUE,实际 BLUE/BLUE)。
  const timing = join(root, "output", "timing.png");
  writeFileSync(timing, red);
  const genericCode = [
    'import { writeFileSync } from "node:fs";',
    // 先说一句别的:消费者拿着这一条慢慢办事的那会儿,下面两行早就到了队列里。
    'process.stdout.write("开场白。\\n");',
    'await new Promise((done) => setTimeout(done, 40));',
    'process.stdout.write("修改前是红色：![修改前](output/timing.png)\\n");',
    'await new Promise((done) => setTimeout(done, 60));',
    repaint(timing, blue),
    'process.stdout.write("修改后是蓝色：![修改后](output/timing.png)\\n");',
  ];
  const script = join(root, "generic-stub.mjs");
  writeFileSync(script, genericCode.join("\n"));
  const spec: CliSpec = {
    key: "kimi",
    name: "fixture",
    description: "回归夹具",
    bins: [process.execPath],
    docsUrl: "https://example.invalid",
    installCommand: "—",
    exec: { prompt: { via: "arg" }, baseArgs: [script] },
  };
  const handle = new GenericCliExecutor(spec).run({ cwd: root, prompt: "noop", trace: undefined } as never);
  const generic = attachments(await collectSlowly(handle.events, 260));
  await handle.cleanup?.();
  assert.deepEqual(
    generic.map((event) => colorOf(event.path)),
    ["RED", "BLUE"],
    "默认 generic 队列:消费者慢一点,也不能把「修改前」读成后来那张蓝图",
  );
  assert.notEqual(generic[0]!.path, generic[1]!.path, "两处引用各有各的字节,不许指到同一份拷贝");

  // ② **短子正文滞留在子活动合并缓冲里**(审查第 6 轮 R1 第 2 例)。
  //
  // 子智能体的正文按「40 字或一个换行」合并成一条活动再发。`![前](output/short.png)` 不到
  // 40 字、又没有换行,于是它先躺在那个缓冲里;父步骤这时把文件重拍,缓冲再释放 —— 记账
  // 挂在缓冲**之后**的那一版读到的已经是新图。字节要在协议读到那一行的那一刻就冻住。
  const short = join(root, "output", "short.png");
  writeFileSync(short, red);
  const childDelta = (text: string) => ({
    type: "stream_event",
    parent_tool_use_id: "toolu_short",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
  const shortChild = stub("short-child", [
    'import { writeFileSync } from "node:fs";',
    jsonLine(childDelta("![前](output/short.png)")),
    'await new Promise((done) => setTimeout(done, 40));',
    repaint(short, blue),
    // 父会话说一句话 —— 子活动缓冲这时才被别的事件挤出来。
    jsonLine({ type: "assistant", message: { model: "claude-fixture", content: [{ type: "text", text: "父会话继续。\n" }] } }),
    jsonLine({ type: "assistant", parent_tool_use_id: "toolu_short", message: { content: [{ type: "text", text: "![前](output/short.png)" }] } }),
  ]);
  const shortEvents = await collect(
    parseClaudeStream(shortChild as never, undefined, "claude", undefined, null, undefined, undefined, undefined, root),
  );
  assert.deepEqual(
    childShots(shortEvents).map((event) => colorOf(event.path)),
    ["RED"],
    "短子正文:字节要在协议读到那一行的那一刻冻住,不是等合并缓冲放出来才读",
  );

  // ③ **定义隔着一段背景段落才到**(审查第 6 轮 R2 第 1 行)。
  //
  // 引用先到(那时它在解析树里压根不是图片节点),14 KB 背景段落把重解析窗口推过它,定义
  // 最后才来。背景段落**必须超过一个窗口**,否则那处引用还在窗口里、整窗那一遍解析自己
  // 就把定义接上了,这一条就测不到「定义到达时按等待表回查」那条路。上一版只好等收尾那
  // 一遍整篇扫描才认出这是一张图 —— 那时去读文件,读到的是中间被重拍过的新图(实测:应
  // RED/BLUE,实际 BLUE/BLUE)。「语义一旦可解释,立刻冻结字节」。
  const late = join(root, "output", "late.png");
  writeFileSync(late, red);
  const lateEvents = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "修改前是红色：![修改前][late]\n\n" + "背景说明。\n\n".repeat(2000) } as AgentEvent;
    yield { kind: "text", text: "[late]: output/late.png\n\n" } as AgentEvent;
    writeFileSync(late, blue);
    yield { kind: "tool", name: "exec", detail: "重新截图" } as AgentEvent;
    yield { kind: "text", text: "修改后是蓝色：![修改后](output/late.png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(lateEvents).map((event) => colorOf(event.path)),
    ["RED", "BLUE"],
    "定义到达那一刻就把它在等的那处引用的字节冻结,不许拖到收尾",
  );

  // ④ **定义多到装不下任何预算**(审查第 6 轮 R2 第 2 行)。
  //
  // 600 条定义 + 一段背景,然后引用最后那一条。上一版把窗口之外的定义重写成源码带着走,
  // 必须猜一个预算(8 KB),满了就 break —— 后面的定义不进这一窗的解析环境,那处引用照旧
  // 拍不到字节。定义表只装语义(identifier → 目的地),所以压根没有这一档。
  const many = join(root, "output", "many.png");
  writeFileSync(many, red);
  const manyEvents = await collect(withMarkdownImages((async function* () {
    yield {
      kind: "text",
      text: Array.from({ length: 600 }, (_, index) => `[d${index}]: output/many.png\n`).join("")
        + "\n" + "普通正文。\n\n".repeat(900),
    } as AgentEvent;
    yield { kind: "text", text: "修改前是红色：![修改前][d599]\n\n" } as AgentEvent;
    writeFileSync(many, blue);
    yield { kind: "tool", name: "exec", detail: "重新截图" } as AgentEvent;
    yield { kind: "text", text: "修改后是蓝色：![修改后](output/many.png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(manyEvents).map((event) => colorOf(event.path)),
    ["RED", "BLUE"],
    "600 条定义也得全在表里:定义表没有预算,不许溢出就丢",
  );

  // ⑤ **同 id 的子智能体 completed 之后又被唤醒接着说**(审查第 6 轮 R2 第 3 行)。
  //
  // native-work.ts 把同一 thread 的 turn/started、turn/completed 转成 running、completed,
  // 而展示端从头到尾按同一个 id 把它的活动累加成**一份**正文(nativeWorkModel)。所以
  // 「它说收工了」= 这份文档记一次中途的账,**不是**这份文档结束了。跟着收工把账本清掉的
  // 那一版,它醒来再引用上一段的定义,那处引用连图片节点都不是:完整正文 2 处引用、服务端
  // 只剩 1 条结果,页面上两处一起提示「图取不到」。
  const resume = join(root, "output", "resume.png");
  writeFileSync(resume, red);
  const resumed = await collect(withMarkdownImages((async function* () {
    yield childActivity("resumable", { kind: "text", text: "[proof]: output/resume.png\n\n第一次：![第一张][proof]\n\n" });
    yield { kind: "tool", name: "Agent", nativeWork: { type: "agent", id: "resumable", status: "completed" } } as AgentEvent;
    yield { kind: "tool", name: "resume_agent", nativeWork: { type: "agent", id: "resumable", status: "running" } } as AgentEvent;
    yield childActivity("resumable", { kind: "text", text: "继续发言：![第二张][proof]\n\n" });
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    childShots(resumed).map((event) => [event.id, event.source, !!event.path]),
    [["resumable", "output/resume.png", true], ["resumable", "output/resume.png", true]],
    "子智能体收工只是记一次中途的账:它醒来接着说,上一段的定义照旧认得",
  );

  // ⑥ **消费者自己抛错**(落库失败、用户停任务)—— 审查第 6 轮 R3。
  //
  // `for await` 里抛出去会让它对迭代器调 `return()`:生成器从那个 yield 直接进 finally,
  // 没法再 yield 一条 attachment。所以交代必须**跟着正文一起发**(语法一定型就发),而不是
  // 攒到回合收尾;同时清理垃圾那一步要分得清「语法没认下的试探拷贝」和「已经露过脸、只是
  // 还没来得及交出去的快照」。两样都缺的那一版:退出前 uploads 1 个文件,退出后 0 个,
  // 消费到的事件里 attachment 为 0 —— 刚才还看得见的截图,清理原图再打开就没有了。
  const crash = join(root, "output", "crash.png");
  const held = join(root, "output", "held.png");
  writeFileSync(crash, red);
  writeFileSync(held, blue);
  const before = readdirSync(uploads).length;
  const seen: AgentEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of withMarkdownImages((async function* () {
      // 第二处引用**在一处还等着定义的引用之后**:它的语法已经定型、字节也拍下来了,可交
      // 代必须停在那处等待的前面(否则定义一到就插在中间,展示端按第 n 处配对会全体错位)。
      // 所以它正是「已经露过脸、只是还没来得及交出去」的那一类,清垃圾时不许跟试探拷贝
      // 一起删 —— 分不清这两类的那一版,这份字节在退出时就没了。
      yield {
        kind: "text",
        text: "异常前已经出现：![红图](output/crash.png)\n\n等定义：![待定][没有这条定义]\n\n紧接着：![蓝图](output/held.png)\n\n",
      } as AgentEvent;
      yield { kind: "context", context: { used: 1, window: 100, windowEstimated: false } } as AgentEvent;
      yield { kind: "done", exitStatus: 0 } as AgentEvent;
    })(), root)) {
      seen.push(event);
      if (event.kind === "context") throw new Error("fixture consumer persistence failed");
    }
  }, /fixture consumer persistence failed/);
  const delivered = attachments(seen);
  assert.deepEqual(
    delivered.map((event) => [event.source, colorOf(event.path)]),
    [["output/crash.png", "RED"]],
    "语法一定型就交代:消费者后面才抛错,这条记录已经在它手里了",
  );
  rmSync(crash);
  rmSync(held);
  assert.equal(
    readdirSync(uploads).length,
    before + 2,
    "两类都得留:已经交出去的那一份,和已经露过脸、只是还卡在等待后面没交出去的那一份",
  );
  assert.equal(colorOf(delivered[0]!.path), "RED", "删掉原图之后,拷贝照旧是说那句话时的红图");

  // ⑦ **一个块自己就比重解析窗口还长**(没有空行的长段、长表格)。
  //
  // 重解析按比例放慢(SCAN_SLACK)之后,这一截里那张图要等后面一万多字才重新解析一遍 ——
  // 中间工具把文件重拍过,拍到的就是后来那张。字节不许跟着重解析一起放慢:新来那一截语法
  // 已经完整的那几处当场拍下来(投机:语法最后不认的由清理那一步删掉)。
  const giant = join(root, "output", "giant.png");
  writeFileSync(giant, red);
  const giantEvents = await collect(withMarkdownImages((async function* () {
    yield { kind: "text", text: "开头：" + "背景说明。".repeat(1800) } as AgentEvent;
    yield { kind: "text", text: "修改前是红色：![修改前](output/giant.png) " } as AgentEvent;
    writeFileSync(giant, blue);
    yield { kind: "text", text: "继续说。" + "普通正文。".repeat(400) + "\n\n" } as AgentEvent;
    yield { kind: "text", text: "修改后是蓝色：![修改后](output/giant.png)\n" } as AgentEvent;
    yield { kind: "done", exitStatus: 0 } as AgentEvent;
  })(), root));
  assert.deepEqual(
    attachments(giantEvents).map((event) => colorOf(event.path)),
    ["RED", "BLUE"],
    "重解析可以放慢,拍字节不许放慢:大块中间那张图也得是说那句话时的那一版",
  );

  console.log("协议入口记账与文档身份回归通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
