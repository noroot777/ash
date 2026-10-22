// 「agent 说的那张图，用户看不看得到」的 DOM 回归。
//
// 盯的是用户 2026-10-21 报的那一幕（结论和审查报告里的图**永远是一个裂开的图标**），以及
// 审查第 1 轮按它复现出来的那几种配错：
//   ① 解得出来的，`<img>` 必须指向真能吐出字节的站内接口，而且**真的吐出来了**（naturalWidth）；
//   ② 同一个路径被重拍过时，两处引用各拿自己那一次 —— 画错那张比不画更坏（F1）；
//   ③ 站外地址、同名别名、围栏代码块里的例子、带空格中文名、`file://` 一处都不许配串（F2）；
//   ④ 解不出来的本机路径**一个 `<img>` 都不许留**；
//   ⑤ 画进正文的那张不再挂一张附件卡片，正文没提的照旧挂着。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";
import { markdownImageRefs } from "@ash/shared/markdown-images";
import { IMAGE_SHAPES } from "./fixtures/markdown-shapes.ts";

// uploads 接口在这个夹具里吐**真字节**：只断言 src 长什么样，证明不了那个地址真能取到图
// 并解码成功（审查第 1 轮把这条列成「回归的证明范围」不足）。
const PIXELS = '<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6"><rect width="6" height="6" fill="#4b7"/></svg>';

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "fixture-uploads",
    configureServer(vite) {
      vite.middlewares.use("/api/uploads", (_req, res) => {
        res.setHeader("content-type", "image/svg+xml");
        res.end(PIXELS);
      });
      // 证据接口（`?name=`）只认真在证据目录里的那几个名字，工作目录接口（`?path=`）只有
      // 还在的那个路径吐字节 —— 两边都得按真实情形回 404，不然「取不到那一档」根本没被验到：
      //   · 证据目录没有 → 报告里那一处只留一行「图取不到」，**不许**换成工作目录里同名
      //     的那一份（审查第 3 轮 R3 第 1 条：端上来的是另一张图）；
      //   · 两边都没有 → 那一张整个消失，只留一行「图取不到」，不许留裂图标。
      const EVIDENCE = new Set(["shot.png", "第一屏 空.png", "shots/deep.png"]);
      vite.middlewares.use("/api/tasks", (req, res) => {
        const query = new URL(req.url ?? "/", "http://fixture.invalid").searchParams;
        const name = query.get("name");
        const missing = name !== null ? !EVIDENCE.has(name) : (query.get("path") ?? "").includes("gone");
        if (missing) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end('{"error":"没有这个文件"}');
          return;
        }
        res.setHeader("content-type", "image/svg+xml");
        res.end(PIXELS);
      });
    },
  }],
});

const uploads = (name) => `/api/uploads/${encodeURIComponent(name)}`;
// 「正文里画出来的图」。执行步骤和附件卡片现在跟正文**排在同一棵语法树里**(整条消息只解
// 析一次,见 components/markdownLayout),所以它们都在 `.task-markdown` 底下 —— 数正文的图
// 必须把卡片排里的那些排除掉,否则「正文没画」和「卡片还挂着」会被算成同一件事。
const bodyImages = (scope) => scope.locator(".task-markdown img:not(.task-message-attachments img)");
// 站内地址归一成 path+query（灯箱会把同源地址绝对化），站外的原样留着。
const srcs = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => {
  const raw = node.getAttribute("src") ?? "";
  try {
    const url = new URL(raw, location.origin);
    return url.origin === location.origin ? `${url.pathname}${url.search}` : raw;
  } catch {
    return raw;
  }
}));

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/markdown-images.html`);
  await page.locator(".orphan-fixture .task-markdown").first().waitFor();
  // 每一张站内图都得真拿到字节 —— 只看 src 不看 naturalWidth 等于没验。证据接口那几张
  // 一起算（取不到的那一处会被收成一行小字，到不了这个选择器里）。
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll(
      'img[src^="/api/uploads"], img[src*="/file/raw"], img[src*="review-file"]',
    )];
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
  });

  // ── ① 审查报告：截图跟 report.md 同目录，这是审查 prompt 交代的写法 ──────────
  const report = page.locator(".report-fixture .task-markdown img");
  // 证据目录里没有的那个相对路径会 404 → 收成一行小字，等那一步落定再数。
  await page.waitForFunction(() => !!document.querySelector(
    ".report-fixture .task-markdown-image-missing",
  ));
  assert.deepEqual(
    await srcs(report),
    [
      "/api/tasks/T1/free-workflow/review-file?run=R1&round=1&name=shot.png",
      `/api/tasks/T1/free-workflow/review-file?run=R1&round=1&name=${encodeURIComponent("第一屏 空.png")}`,
      `/api/tasks/T1/free-workflow/review-file?run=R1&round=1&name=${encodeURIComponent("shots/deep.png")}`,
      "/api/tasks/T1/file/raw?path=%2FUsers%2Fdemo%2Fcode%2Fash%2F.worktrees%2Fx%2Foutput%2Fshot.svg&workspaceOnly=1",
    ],
    // 子目录那张曾经画不出来:两边都只认 basename,审查者把截图归进 shots/ 就等于没放
    // (审查第 1 轮非阻塞项 2)。证据接口现在服务证据目录内的相对路径。
    "相对路径(含带空格中文名、子目录)一律解到证据接口;工作目录那一份靠绝对路径显式指明",
  );
  // **证据目录里没有它,不等于这处引用说的是另一个根**:那一处只留一行「图取不到」加上原
  // 地址,绝不许换成工作目录里同名的那一份(审查第 3 轮 R3 第 1 条:端上来的是另一张图)。
  assert.match(
    await page.locator(".report-fixture .task-markdown-image-missing").innerText(),
    /图取不到[\s\S]*missing\.png/,
    "证据目录里没有的那一处要如实报「图取不到 + 原地址」",
  );
  assert.equal(
    await page.locator('.report-fixture img[src*="missing"]').count(),
    0,
    "取不到的那一处不许换一个根再试 —— 加载失败只能证明此刻取不到",
  );

  // ── ② 对话结论：相对路径 + 绝对路径，都靠服务端那份 uploads 拷贝落地 ────────
  const conclusion = page.locator(".conclusion-fixture");
  assert.deepEqual(
    await srcs(bodyImages(conclusion)),
    [uploads("aaaaaaaaaaaa-wake-input-desktop.svg"), uploads("bbbbbbbbbbbb-wake-input-mobile.svg")],
    "相对路径和绝对路径都要配到各自那份拷贝，且不许配串",
  );
  // 同一张图不能说两遍：画进正文的撤出卡片排，正文没提的那张照旧留着。
  assert.deepEqual(
    await srcs(conclusion.locator(".task-message-attachments img")),
    [uploads("cccccccccccc-tool-screenshot.svg")],
    "正文已经画出来的不该再挂卡片；工具结果截图这类正文没提的仍要铺",
  );

  // ── ③ 只有一张图：领走之后那一段空了，不许留一个占着间距的空 section ──────
  const single = page.locator(".single-fixture");
  assert.equal(await bodyImages(single).count(), 1, "唯一那张图要画在正文里");
  assert.equal(await single.locator(".task-message-attachments").count(), 0, "卡片排整个空了就别出");
  assert.equal(
    await single.locator(".task-markdown > *").count(),
    2,
    // 整条消息只有一棵语法树,步骤位置就是「插在第几个顶层块之间」(见 markdownLayout)。
    // 附件被正文领走的那一步一个字都画不出来 → 一个节点都不该留,否则它照旧占着间距、
    // 把正在读的人往下拽(贴底判据只看得见高度,见 segment-layout 那份夹具)。
    "正文两个块;被领走的那一步一个节点都不留",
  );

  // ── ④ 同一路径重拍：两处引用各拿自己那一次（F1 的要害）────────────────────
  assert.deepEqual(
    await srcs(bodyImages(page.locator(".retake-fixture"))),
    [uploads("eeeeeeeeeeee-shot.svg"), uploads("ffffffffffff-shot.svg")],
    "「修改前」那句画第一次的字节，「修改后」那句画第二次的 —— 画错那张比不画更坏",
  );

  // ── ⑤ 站外地址不许被同名本地附件顶掉；同一份字节的两个名字都要画得出 ───────
  // 这一条还兼着守「取不到就收掉」的边界：`example.invalid` 根本解析不出来、必然加载失败，
  // 它仍然要留在这儿 —— 站外取不到可能只是此刻连不上，不归那一条收（见 MarkdownImage）。
  const alias = page.locator(".alias-fixture");
  assert.deepEqual(
    await srcs(bodyImages(alias)),
    [
      "https://example.invalid/remote.svg",
      uploads("gggggggggggg-same-a.svg"),
      uploads("gggggggggggg-same-a.svg"),
    ],
    "站外那张保持站外；两个名字指向同一份拷贝时两处都要画",
  );
  assert.equal(
    await alias.locator(".task-message-attachments").count(),
    0,
    "那份拷贝已经被正文领走，不该再剩一张卡片",
  );

  // ── ⑥ 围栏代码块里的例子不是图：不画，也不许吃掉那张卡片 ───────────────────
  const fenced = page.locator(".fenced-fixture");
  assert.equal(await bodyImages(fenced).count(), 0, "代码块里的写法示例不是图");
  assert.match(
    await fenced.locator(".task-code-block").innerText(),
    /!\[示例\]\(output\/fenced\.svg\)/,
    "示例原文一个字都不能改",
  );
  assert.deepEqual(
    await srcs(fenced.locator(".task-message-attachments img")),
    [uploads("hhhhhhhhhhhh-fenced.svg")],
    "正文没真提它，那张附件卡片要留着",
  );

  // ── ⑦ 带空格中文名、file:// —— 前者会被转义，后者会被 react-markdown 清空 ───
  assert.deepEqual(
    await srcs(bodyImages(page.locator(".awkward-fixture"))),
    [uploads("iiiiiiiiiiii-结果-图.svg"), uploads("jjjjjjjjjjjj-by-url.svg")],
    "转义过的目的地和 file URL 都要配上；配不上的那条 file URL 一个 img 都不留",
  );

  // ── ⑧ 配不上来源的本机路径：什么都不画 ───────────────────────────────────
  const orphan = page.locator(".orphan-fixture");
  assert.equal(await orphan.locator("img").count(), 0, "解释不了的本机路径绝不留裂开的图标");
  // 但也不许无声蒸发:那一行小字是用户唯一能看出「这不是界面坏了」的东西,而且得指出是
  // 哪个地址取不到(审查第 1 轮非阻塞项:存/读失败时任务内没有任何可见提示)。
  assert.match(
    await orphan.locator(".task-markdown-image-missing").innerText(),
    /图取不到[\s\S]*output\/playwright\/gone\.png/,
    "取不到的那张要留一行「图取不到 + 原地址」",
  );
  assert.match(
    await orphan.locator(".task-markdown").innerText(),
    /当时的截图/,
    "收掉的只是那张图，正文一个字都不能少",
  );

  // ── ⑨ 存量消息退一档：现在去工作目录里取。文件还在就真画出来 ────────────────
  const live = page.locator(".live-fixture .task-markdown img");
  assert.deepEqual(
    await srcs(live),
    ["/api/tasks/T1/file/raw?path=output%2Flive.svg&workspaceOnly=1"],
    "没有快照拷贝的引用改写到任务工作目录的原始字节接口",
  );
  assert.ok(
    await live.first().evaluate((node) => node.complete && node.naturalWidth > 0),
    "那个地址必须真把字节吐出来",
  );

  // ── ⑩ 文件已经没了（404）：那一张整个消失，正文一个字不少 ───────────────────
  // 这一条是用户 2026-10-21 报的那一幕的下界：解析器判得出「这地址站内服务得了」，判不出
  // 「那个文件此刻还在不在」，所以必须由渲染点兜住 —— 不然裂图标照旧。
  await page.waitForFunction(() => document.querySelectorAll(".gone-fixture img").length === 0);
  assert.match(
    await page.locator(".gone-fixture .task-markdown").innerText(),
    /当时的截图/,
    "收掉的只是那张图，正文一个字都不能少",
  );
  // 地址解得出来、字节取不到,也要留下那一行小字 —— 这一档是「加载失败」,跟 ⑧ 的「地址
  // 压根解不出来」是两条不同的路,都得收口到同一个提示上。
  assert.match(
    await page.locator(".gone-fixture .task-markdown-image-missing").innerText(),
    /图取不到[\s\S]*output\/gone\.svg/,
    "404 之后也要报是哪个地址取不到",
  );

  // ── ⑭ 协议相对网址留在站外;解不出来的 file: 留一行小字(F3 / F2 的失败分支)──────
  const protocol = page.locator(".protocol-fixture");
  assert.deepEqual(
    await srcs(bodyImages(protocol)),
    ["//cdn.example.invalid/remote.svg"],
    "`//host/x.png` 是网址,不许被改写成「去任务工作目录取」",
  );
  assert.match(
    await protocol.locator(".task-markdown-image-missing").innerText(),
    /图取不到[\s\S]*\/Users\/demo\/code\/ash\/output\/vanished\.svg/,
    // react-markdown 默认会把它不认的协议整个清空,于是这一张连「哪个文件」都报不出来。
    "解不出来的 file: 要报出那个本机路径,而不是被清成空串后无声消失",
  );

  // ── ⑪ 扫描器认的那几处 == 渲染器画出来的那几个（F2 的根:两边必须是同一套语义）───
  // 只比「两次调用同一个扫描器」证明不了任何事(上一版服务端和展示端共用同一份错正则,
  // 两边一致地把带括号的文件名截断、把缩进代码里的示例当成真图)。所以这里在 Node 里数
  // 解析结果,在浏览器里数同一段正文真渲染出来的 `<img>`,两个数字必须相等。
  for (const shape of IMAGE_SHAPES) {
    // 比的是「扫描器说**渲染器会画**的那几处」:没人引用的脚注定义里那种,扫描器照旧逐处
    // 交代(服务端流式扫的时候还不知道引用会不会来,见 shared 的 `rendered`),但它不该画。
    const expected = markdownImageRefs(shape.markdown).filter((ref) => ref.rendered).length;
    assert.equal(
      await page.locator(`.shape-${shape.key} .task-markdown img`).count(),
      expected,
      `${shape.key}（${shape.about}）：扫描器认 ${expected} 处,渲染器画出来的得是同一个数`,
    );
  }
  // 代码里的示例原文一个字都不许被改写(改写了就是正文显示成代码、却指向一个站内地址)。
  for (const key of ["indented", "fenced", "inline-code"]) {
    assert.match(
      await page.locator(`.shape-${key} .task-markdown`).innerText(),
      /!\[示例\]\(output\/shot\.svg\)/,
      `${key}:写法示例的原文要原样留着`,
    );
  }

  // ── ⑫ 明确没有副本的那处引用 → 现在去工作目录取,取到了就真画出来 ─────────────
  const nocopy = page.locator(".nocopy-fixture .task-markdown img");
  assert.deepEqual(
    await srcs(nocopy),
    ["/api/tasks/T1/file/raw?path=output%2Flive.svg&workspaceOnly=1"],
    "服务端明确报了「这处引用没存下副本」,才退到当前文件",
  );
  assert.ok(
    await nocopy.first().evaluate((node) => node.complete && node.naturalWidth > 0),
    "那个地址必须真把字节吐出来",
  );

  // ── ⑬ 配不上、而本该有一条:第二处什么都不画,也不许顶一份别的拷贝(F1)──────────
  const short = page.locator(".short-fixture");
  assert.equal(
    await bodyImages(short).count(),
    0,
    // 连第一处也不画:序列对不上说明「这段正文不是服务端扫过的那一段」,那时「第一处」未必
    // 就是记录的那一条(审查第 2 轮 F1:投影重建后幸存的那句其实是第三处,顶上去画的是红图)。
    "正文两处引用、记录只有一条 → 一处都不画,绝不按位置顶上去",
  );
  assert.equal(
    await short.locator(".task-markdown-image-missing").count(),
    2,
    "两处都留一行小字 —— 不画不等于无声蒸发",
  );
  assert.deepEqual(
    await srcs(short.locator(".task-message-attachments img")),
    [uploads("kkkkkkkkkkkk-short.svg")],
    "一处都没领走,那份拷贝必须留在卡片里:画不出来不等于让人拿不到",
  );
  assert.match(
    await short.locator(".task-markdown").last().innerText(),
    /又提一次/,
    "收掉的只是那张图,正文一个字都不能少",
  );
  assert.match(
    await short.locator(".task-markdown-image-missing").first().innerText(),
    /图取不到[\s\S]*output\/short\.svg/,
    "不敢画的那几处也要留一行小字,而不是让那几句话指向空气",
  );

  // ── ⑮ 文档级的定义跨过一个执行步骤:照旧全局有效(R2)────────────────────────
  // 「整条消息解析一次」的要害就在这儿:定义在后半截、引用在前半截,按段渲染两头都落空。
  const crossdef = page.locator(".crossdef-fixture");
  assert.deepEqual(
    await srcs(bodyImages(crossdef)),
    [uploads("llllllllllll-ref.svg"), uploads("mmmmmmmmmmmm-foot.svg")],
    "链接引用定义和脚注定义都在执行步骤之后,两张图照旧画得出来",
  );
  assert.equal(
    await crossdef.locator(".task-markdown-image-missing").count(),
    0,
    "画得出来就不该有「图取不到」",
  );
  assert.equal(
    await crossdef.locator(".task-message-attachments").count(),
    0,
    // 这是 R2 最坏的那一半:正文画不出来、卡片又已经被认领吃掉,用户两头拿不到。
    "两份拷贝都画进正文了,卡片排才该空",
  );
  assert.match(
    await crossdef.locator(".task-markdown").innerText(),
    /复现截图/,
    "脚注正文要真渲染出来(定义没人引用时 GFM 会把它整个丢掉)",
  );

  console.log("Markdown 图片解析回归通过");
} finally {
  await browser?.close();
  await server.close();
}
