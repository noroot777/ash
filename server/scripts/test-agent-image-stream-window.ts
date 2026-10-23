// 「withMarkdownImages 的滑动窗口」—— 从 test-agent-image-stream.ts 拆出来的那一族
// (单文件 700 行闸),编号沿用原文件:
//   ⑬ 超长块的放慢档  ⑭ 裁剪保快照  ⑮/⑮b 分片到达的引用式定义  ⑯ 隔任意距离的定义
//   ⑰ 永无定义的候选  ⑲/⑲b/⑲c/⑲d 被裁出窗口的定义「带着走」
// 真起进程那端(①)、写盘失败(⑱⑳)和专用适配器(㉑ 之后)仍在原文件里。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const root = mkdtempSync(join(tmpdir(), "ash-image-stream-window-"));
const uploads = join(root, "data", "uploads");
// uploads 目录在 paths.ts 里是模块级常量,所以必须在**导入它之前**改环境变量 —— 静态
// import 会被提到所有语句之前,这里只能动态导。
process.env.ASH_UPLOADS_DIR = uploads;
const { withMarkdownImages } = await import("../src/executors/markdown-image-stream.js");

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const attachments = (events: AgentEvent[]) =>
  events.filter((event): event is Extract<AgentEvent, { kind: "attachment" }> => event.kind === "attachment");

try {
  mkdirSync(join(root, "output"), { recursive: true });
  writeFileSync(join(root, "output", "shot.png"), Buffer.from(PNG_BASE64, "base64"));
  const red = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 1)]);
  const blue = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 2)]);

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

  console.log("滑动窗口与定义携带回归通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
