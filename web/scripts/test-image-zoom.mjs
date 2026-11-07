import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { afterFrames, animationsSettled } from "./wait-until.mjs";

// 看图缩放（`useImageZoom` + `ImageZoomControls`），灯箱与文件查看器共用一份。这里钉三条
// `test-image-preview` 的 6×6 小图夹具测不到的：
// ① 原图比容器大但不到 1.5 倍时，「实际大小」就是 100%，不能跳到两倍；
// ② 真实触屏双指捏合时，不动的那根手指下面始终是图上同一处；
// ③ 文件树/生成物点开的图片在中栏原地缩放，图被裁在查看区里。

const grid = (W, H) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#678" stroke-width="2"/></pattern></defs><rect width="${W}" height="${H}" fill="#eef"/><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
const PIXELS = grid(1200, 800);
// 1280 宽的视口里灯箱给图留 1128px，这张只宽出 8px：适应时缩到 99.3%。
const NEAR = grid(1136, 400);

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, hasTouch: true });
  const page = await context.newPage();
  // Playwright 后注册的路由先匹配：兜底的 404 得最先挂。
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
  const svg = (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: PIXELS });
  await page.route("**/image-zoom-large.svg", svg);
  await page.route("**/image-zoom-near.svg", (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: NEAR }));
  await page.route("**/api/tasks/demo/file/raw?*", svg);
  await page.route("**/api/tasks/demo/file?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      root: { path: "/tmp/image-zoom", branch: "main", gitRepo: true, source: "session" },
      file: { path: "shots/large.png", name: "large.png", size: 4096, mtime: null, kind: "image", text: null, truncated: false, absPath: "/tmp/image-zoom/shots/large.png", mime: "image/png" },
      pageUrl: null,
      pageNotice: null,
    }),
  }));
  await page.goto(`${web.origin}/scripts/fixtures/image-zoom.html`);

  const percentOf = async (scope) => Number((await scope.getByRole("button", { name: "适应窗口 / 实际大小" }).textContent()).replace("%", ""));
  const fitPercent = async (image) => image.evaluate((img) => Math.round(img.clientWidth / img.naturalWidth * 100));

  // ① 灯箱：适应时不到 100%，切「实际大小」正好 100%。
  await page.locator("#thumb img").first().click();
  const dialog = page.getByRole("dialog", { name: /图片预览/ });
  await dialog.waitFor();
  const lightboxImage = dialog.locator("img");
  await page.waitForFunction(() => document.querySelector(".image-preview-lightbox img")?.complete);
  const fit = await fitPercent(lightboxImage);
  assert(fit > 67 && fit < 100, `fixture should fit between 67% and 100%, got ${fit}%`);
  await page.waitForFunction((value) => document.querySelector(".image-preview-lightbox .image-zoom-controls button:nth-child(2)")?.textContent === `${value}%`, fit);
  await dialog.getByRole("button", { name: "适应窗口 / 实际大小" }).click();
  assert.equal(await percentOf(dialog), 100, "actual size of a mildly downscaled image is 100%, not 2x");
  await dialog.getByRole("button", { name: "适应窗口 / 实际大小" }).click();
  assert.equal(await percentOf(dialog), fit);

  // ①b 只被缩小了不到 1% 的图，「实际大小」同样是 100%，不是两倍。
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.locator("#thumb img").nth(1).click();
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector(".image-preview-lightbox img")?.complete);
  const nearFit = await fitPercent(lightboxImage);
  assert.equal(nearFit, 99, `fixture should fit at 99%, got ${nearFit}%`);
  await page.waitForFunction(() => document.querySelector(".image-preview-lightbox .image-zoom-controls button:nth-child(2)")?.textContent === "99%");
  await dialog.getByRole("button", { name: "适应窗口 / 实际大小" }).click();
  assert.equal(await percentOf(dialog), 100, "an image downscaled by under 1% still toggles to exactly 100%");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  // ①c 刚打开、容器尺寸观察器还没报第一次尺寸时就缩放：那次「首报」不是尺寸变了，不能把缩放撤掉。
  await page.evaluate(async () => {
    document.querySelector("#thumb img").click();
    await Promise.resolve();
    const button = document.querySelector(".image-preview-lightbox [aria-label='放大图片']");
    if (!button) throw new Error("lightbox did not open synchronously");
    button.click();
  });
  // 尺寸观察器的回调在渲染那一步派发：走过两帧，「首报」一定已经报过，它引起的提交再冲刷掉。
  await afterFrames(page, 2);
  assert(await percentOf(dialog) > fit, "zooming right after opening survives the observer's first report");
  await page.keyboard.press("0");

  // ② 双指：A 指不动、B 指往外拉，A 指下面的图像点不该漂。先放到两条轴都超出视口——还没
  // 超出的那条轴按规矩居中，锚点会被拉回中线，那是有意的，不是漂移。
  await dialog.getByRole("button", { name: "放大图片", exact: true }).click();
  await dialog.getByRole("button", { name: "放大图片", exact: true }).click();
  await animationsSettled(page);
  const zoomed = await percentOf(dialog);
  const cy = 380;
  const a = { x: 400, y: cy };
  const start = await lightboxImage.boundingBox();
  const under = { x: (a.x - start.x) / start.width, y: (a.y - start.y) / start.height };
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((point, id) => ({ x: point.x, y: point.y, id })),
  });
  await touch("touchStart", [a, { x: a.x + 120, y: cy }]);
  for (let i = 1; i <= 4; i++) await touch("touchMove", [a, { x: a.x + 120 + i * 20, y: cy }]);
  await touch("touchEnd", []);
  const pinched = await percentOf(dialog);
  // 拉到 200/120 ≈ 1.67 倍，停在 4 倍上限以内——碰到上限就不再以手指为锚了。
  assert(pinched > zoomed * 1.5, `spreading two fingers should zoom in, got ${pinched}% from ${zoomed}%`);
  const end = await lightboxImage.boundingBox();
  const landed = { x: end.x + under.x * end.width, y: end.y + under.y * end.height };
  assert(Math.abs(landed.x - a.x) < 1 && Math.abs(landed.y - a.y) < 1,
    `the image point under the still finger moved to ${JSON.stringify(landed)}, finger at ${JSON.stringify(a)}`);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  // ③ 文件查看器：中栏原地缩放，工具条与顶栏「放大」（铺满窗口）各管各的。
  const viewer = page.locator("#viewer");
  const viewerImage = viewer.locator(".file-viewer__media img");
  await viewerImage.waitFor();
  await page.waitForFunction(() => document.querySelector("#viewer .file-viewer__media img")?.complete);
  const viewerFit = await fitPercent(viewerImage);
  assert(viewerFit < 100, `the viewer should downscale the large image, got ${viewerFit}%`);
  const [fitBox, mediaBox] = [await viewerImage.boundingBox(), await viewer.locator(".file-viewer__media").boundingBox()];
  assert(fitBox.y + fitBox.height <= mediaBox.y + mediaBox.height, "at fit the whole image is inside the viewer, nothing clipped");
  await page.waitForFunction((value) => document.querySelector("#viewer .image-zoom-controls button:nth-child(2)")?.textContent === `${value}%`, viewerFit);
  assert.equal(await viewer.getByRole("button", { name: "放大", exact: true }).count(), 1, "the pane-level zoom button stays");
  await viewer.getByRole("button", { name: "放大图片", exact: true }).click();
  // 读数各自取整，差 1 个百分点不算错。
  assert(Math.abs(await percentOf(viewer) - viewerFit * 1.5) <= 1, "zoom-in steps by 1.5x");
  assert.match(await viewerImage.evaluate((img) => img.style.transform), /scale\(1\.5\)/);
  assert.equal(await viewer.locator(".file-viewer__media").evaluate((el) => getComputedStyle(el).overflow), "hidden", "zoomed image is clipped to the viewer");
  await viewer.getByRole("button", { name: "缩小图片", exact: true }).click();
  assert.equal(await percentOf(viewer), viewerFit);
  const viewerBox = await viewerImage.boundingBox();
  await page.mouse.move(viewerBox.x + viewerBox.width / 2, viewerBox.y + viewerBox.height / 2);
  await page.mouse.wheel(0, -300);
  await page.waitForFunction((value) => document.querySelector("#viewer .image-zoom-controls button:nth-child(2)")?.textContent !== `${value}%`, viewerFit);
  assert(await percentOf(viewer) > viewerFit, "wheel zooms the image in the viewer");
  await page.mouse.click(viewerBox.x + viewerBox.width / 2, viewerBox.y + viewerBox.height / 2);
  assert.equal(await percentOf(viewer), viewerFit, "clicking a zoomed image returns to fit");
  assert.equal(await page.getByRole("dialog").count(), 0, "the file viewer zooms in place, no lightbox");

  console.log("image zoom test passed");
} finally {
  await browser?.close();
  await web.close();
}
