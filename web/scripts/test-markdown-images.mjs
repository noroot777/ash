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
      // 「读的时候再去工作目录里取」那一档。只有还在的那个路径吐字节，另一个按真实情形
      // 回 404（目录被清掉 / 文件被删）—— 那一张必须整个消失，不许留裂图标。
      vite.middlewares.use("/api/tasks", (req, res) => {
        const path = new URL(req.url ?? "/", "http://fixture.invalid").searchParams.get("path") ?? "";
        if (path.includes("gone")) {
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
  // 每一张站内图都得真拿到字节 —— 只看 src 不看 naturalWidth 等于没验。
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('img[src^="/api/uploads"], img[src*="/file/raw"]')];
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
  });

  // ── ① 审查报告：截图跟 report.md 同目录，这是审查 prompt 交代的写法 ──────────
  const report = page.locator(".report-fixture .task-markdown img");
  assert.deepEqual(
    await srcs(report),
    [
      "/api/tasks/T1/free-workflow/review-file?run=R1&round=1&name=shot.png",
      `/api/tasks/T1/free-workflow/review-file?run=R1&round=1&name=${encodeURIComponent("第一屏 空.png")}`,
    ],
    "同目录那两张(含带空格中文名)解到证据接口；子目录那张服务端取不到就别画",
  );

  // ── ② 对话结论：相对路径 + 绝对路径，都靠服务端那份 uploads 拷贝落地 ────────
  const conclusion = page.locator(".conclusion-fixture");
  assert.deepEqual(
    await srcs(conclusion.locator(".task-markdown img")),
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
  assert.equal(await single.locator(".task-markdown img").count(), 1, "唯一那张图要画在正文里");
  assert.equal(await single.locator(".task-message-attachments").count(), 0, "卡片排整个空了就别出");
  assert.equal(
    await single.locator(".task-agent-segment").count(),
    1,
    "附件被正文领走后那一段什么都画不出来，不该再占一个 section",
  );

  // ── ④ 同一路径重拍：两处引用各拿自己那一次（F1 的要害）────────────────────
  assert.deepEqual(
    await srcs(page.locator(".retake-fixture .task-markdown img")),
    [uploads("eeeeeeeeeeee-shot.svg"), uploads("ffffffffffff-shot.svg")],
    "「修改前」那句画第一次的字节，「修改后」那句画第二次的 —— 画错那张比不画更坏",
  );

  // ── ⑤ 站外地址不许被同名本地附件顶掉；同一份字节的两个名字都要画得出 ───────
  // 这一条还兼着守「取不到就收掉」的边界：`example.invalid` 根本解析不出来、必然加载失败，
  // 它仍然要留在这儿 —— 站外取不到可能只是此刻连不上，不归那一条收（见 MarkdownImage）。
  const alias = page.locator(".alias-fixture");
  assert.deepEqual(
    await srcs(alias.locator(".task-markdown img")),
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
  assert.equal(await fenced.locator(".task-markdown img").count(), 0, "代码块里的写法示例不是图");
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
    await srcs(page.locator(".awkward-fixture .task-markdown img")),
    [uploads("iiiiiiiiiiii-结果-图.svg"), uploads("jjjjjjjjjjjj-by-url.svg")],
    "转义过的目的地和 file URL 都要配上；配不上的那条 file URL 一个 img 都不留",
  );

  // ── ⑧ 配不上来源的本机路径：什么都不画 ───────────────────────────────────
  const orphan = page.locator(".orphan-fixture");
  assert.equal(await orphan.locator("img").count(), 0, "解释不了的本机路径要静默收掉，绝不留裂开的图标");
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

  console.log("Markdown 图片解析回归通过");
} finally {
  await browser?.close();
  await server.close();
}
