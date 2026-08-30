import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/ui-polish.html`);

  const render = (html) => page.locator("#root").evaluate((node, value) => { node.innerHTML = value; }, html);
  const renderProbe = (name) => page.locator("#root").evaluate((node, value) => {
    const template = document.querySelector(`#${value}-probe`);
    if (!(template instanceof HTMLTemplateElement)) throw new Error(`Unknown UI polish probe: ${value}`);
    node.replaceChildren(template.content.cloneNode(true));
  }, name);

  await renderProbe("settings");
  for (const [width, columns] of [[420, "176px 244px"], [600, "176px 424px"], [640, "176px 464px"], [641, "176px 465px"], [660, "176px 484px"], [680, "176px 504px"], [681, "240px 441px"], [760, "240px 520px"]]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator(".settings-shell").evaluate((node) => getComputedStyle(node).gridTemplateColumns), columns);
  }

  for (const width of [420, 600, 640]) {
    await page.setViewportSize({ width, height: 800 });
    const navigation = await page.locator(".settings-shell").evaluate((node) => {
      const sidebar = node.querySelector(".settings-sidebar");
      const main = node.querySelector(".settings-main");
      const last = node.querySelector(".settings-nav-group:last-child button:last-child");
      const sidebarRect = sidebar.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      const hit = document.elementFromPoint(lastRect.left + lastRect.width / 2, lastRect.top + lastRect.height / 2);
      return {
        sidebarBottom: sidebarRect.bottom,
        sidebarClientHeight: sidebar.clientHeight,
        sidebarScrollHeight: sidebar.scrollHeight,
        mainTop: mainRect.top,
        mainHeight: mainRect.height,
        lastBottom: lastRect.bottom,
        lastIsClickable: hit === last || last.contains(hit),
      };
    });
    assert.ok(navigation.lastBottom <= navigation.sidebarBottom + 0.5, `${width}px 下最后一项应留在侧栏内：${JSON.stringify(navigation)}`);
    assert.ok(navigation.sidebarScrollHeight <= navigation.sidebarClientHeight, `${width}px 下设置导航不应被截断：${JSON.stringify(navigation)}`);
    assert.equal(navigation.mainTop, 0, `${width}px 下设置正文不应被挤到第二行`);
    assert.equal(navigation.mainHeight, 800, `${width}px 下设置正文应保持整屏高度`);
    assert.equal(navigation.lastIsClickable, true, `${width}px 下最后一个设置入口应可点击`);
  }

  await page.setViewportSize({ width: 1280, height: 700 });
  await renderProbe("auth");
  const authTop = await page.locator(".auth-shell").evaluate((node) => {
    node.scrollTop = 0;
    const shell = node.getBoundingClientRect();
    const heading = node.querySelector("[data-auth-heading]").getBoundingClientRect();
    return { clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, shellTop: shell.top, headingTop: heading.top };
  });
  assert.ok(authTop.scrollHeight > authTop.clientHeight, `身份页探针必须真实高于视口：${JSON.stringify(authTop)}`);
  assert.ok(authTop.headingTop >= authTop.shellTop, `身份页滚到最顶时标题必须可达：${JSON.stringify(authTop)}`);
  const authBottom = await page.locator(".auth-shell").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    const shell = node.getBoundingClientRect();
    const last = node.querySelector("[data-auth-last]").getBoundingClientRect();
    return { shellBottom: shell.bottom, lastBottom: last.bottom };
  });
  assert.ok(authBottom.lastBottom <= authBottom.shellBottom, `身份页滚到底时末项必须可达：${JSON.stringify(authBottom)}`);

  await renderProbe("settings-key");
  const settingsKeyReveal = await page.locator(".auth-key-reveal").evaluate((node) => {
    const heading = node.querySelector("h2");
    const keyValue = node.querySelector(".auth-key-value");
    const check = node.querySelector(".auth-check");
    const button = node.querySelector(".ui-button--primary");
    return {
      eyebrow: getComputedStyle(heading, "::before").content,
      headingSize: getComputedStyle(heading).fontSize,
      keyBorderStyle: getComputedStyle(keyValue).borderTopStyle,
      checkBorderWidth: getComputedStyle(check).borderTopWidth,
      buttonHeight: button.getBoundingClientRect().height,
    };
  });
  assert.ok(!settingsKeyReveal.eyebrow.includes("ASH ACCESS"), `设置页不应出现身份页眉题：${JSON.stringify(settingsKeyReveal)}`);
  assert.equal(settingsKeyReveal.headingSize, "17px", "设置页 KeyReveal 标题应使用卡片层级");
  assert.equal(settingsKeyReveal.keyBorderStyle, "solid", "设置页 key 应保留紧凑卡片样式");
  assert.equal(settingsKeyReveal.checkBorderWidth, "0px", "设置页确认项不应套用身份页方框");
  assert.equal(settingsKeyReveal.buttonHeight, 28, "设置页确认按钮不应放大成身份页主操作");

  await page.setViewportSize({ width: 1000, height: 800 });
  await render(`
    <section class="task-confirm-dialog">
      <header class="task-confirm-header"><span class="is-danger">!</span><div><small>HIGH IMPACT ACTION</small><h2>删除</h2></div><button>×</button></header>
      <footer><button>取消</button><button class="is-danger">删除</button></footer>
    </section>
    <button class="create-project-mode"><span>□</span><span><b>本地目录</b></span></button>
    <button class="auth-choice"><b>只有我自己</b><span>零鉴权</span></button>
    <main class="settings-main">
      <div class="users-row"><div class="users-row-main">用户</div></div>
      <div class="pmem-row"><div class="pmem-who">成员</div></div>
    </main>
  `);

  const dangerColors = await page.locator(".task-confirm-header > span.is-danger").evaluate((node) => {
    const reference = document.createElement("i");
    reference.style.cssText = "background:color-mix(in srgb,var(--red) 9%,var(--panel));border:1px solid color-mix(in srgb,var(--red) 24%,var(--line))";
    document.body.append(reference);
    const actual = getComputedStyle(node);
    const expected = getComputedStyle(reference);
    const result = {
      background: actual.backgroundColor,
      border: actual.borderColor,
      expectedBackground: expected.backgroundColor,
      expectedBorder: expected.borderColor,
    };
    reference.remove();
    return result;
  });
  assert.equal(dangerColors.background, dangerColors.expectedBackground, "危险图标底色应按 sRGB 混出淡红");
  assert.equal(dangerColors.border, dangerColors.expectedBorder, "危险图标描边应按 sRGB 混出红色");

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const selector of [".create-project-mode", ".task-confirm-dialog > footer button", ".auth-choice", ".settings-main .users-row", ".settings-main .pmem-row"]) {
    const motion = await page.locator(selector).first().evaluate((node) => {
      const style = getComputedStyle(node);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });
    assert.equal(motion.property, "none", `${selector} 在减弱动态效果时不应保留过渡`);
    assert.equal(motion.duration, "0s", `${selector} 在减弱动态效果时过渡时长应归零`);
    await page.locator(selector).first().hover();
    assert.equal(await page.locator(selector).first().evaluate((node) => getComputedStyle(node).transform), "none");
  }

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1000, height: 800 });
  await render(`
    <section class="notes-panel"><header>随手记</header><div class="notes-body"></div><footer></footer></section>
    <section class="groups-panel"><header>分组</header><div class="groups-panel-body"></div></section>
    <section class="composer-preset-dialog"><header><span>◇</span><div><h2>保存当前组合</h2></div></header></section>
  `);
  for (const panel of [".notes-panel", ".groups-panel"]) {
    const geometry = await page.locator(panel).evaluate((node) => {
      const header = node.querySelector(":scope > header").getBoundingClientRect();
      const body = node.children[1].getBoundingClientRect();
      return { headerHeight: header.height, headerBottom: header.bottom, bodyTop: body.top };
    });
    assert.ok(Math.abs(geometry.headerHeight - 56) < 1, `${panel} 头部轨道应接近焕新后的 56px：${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.headerBottom - geometry.bodyTop) < 0.1, `${panel} 头部不应溢出并压住正文：${JSON.stringify(geometry)}`);
  }
  const presetIcon = await page.locator(".composer-preset-dialog > header > span").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  assert.ok(Math.abs(presetIcon.width - presetIcon.height) < 0.1, `执行模式弹窗图标应保持正方形：${JSON.stringify(presetIcon)}`);
  assert.ok(Math.abs(presetIcon.width - 42) < 1, `执行模式弹窗图标应接近 42px：${JSON.stringify(presetIcon)}`);

  await page.setViewportSize({ width: 1000, height: 700 });
  await render(`
    <form class="free-review-dialog">
      <header><span>◇</span><div><h2>派发审查</h2><p>选择审查者</p></div><button>×</button></header>
      <div class="free-review-dialog-body"><div style="height:580px"></div><aside></aside></div>
      <footer><button>取消</button><button class="is-primary">派发</button></footer>
    </form>
  `);
  const reviewGeometry = await page.locator(".free-review-dialog").evaluate((node) => {
    const dialog = node.getBoundingClientRect();
    const footer = node.querySelector(":scope > footer").getBoundingClientRect();
    return { dialogBottom: dialog.bottom, footerBottom: footer.bottom, dialogHeight: dialog.height };
  });
  assert.ok(reviewGeometry.footerBottom <= reviewGeometry.dialogBottom, `派审弹窗页脚不应被裁：${JSON.stringify(reviewGeometry)}`);
  assert.ok(reviewGeometry.dialogHeight <= 644, `700px 视口下弹窗不应超过 92vh：${JSON.stringify(reviewGeometry)}`);

  console.log("[ui-polish] responsive reachability, auth scoping, panel geometry, danger color and reduced-motion checks passed");
} finally {
  await browser?.close();
  await server.close();
}
