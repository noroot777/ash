import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { resizeViewport } from "./wait-until.mjs";

const artifacts = fileURLToPath(new URL("../../output/playwright/", import.meta.url));
const web = await startWebServer();
const messages = Array.from({ length: 10 }, (_, index) => ({
  id: `monitor-${index}`, taskId: "task-a", text: `【哨兵结束】检查 ${index}，退出码 0。命令自己跑完了。`,
  attachments: [], agent: "codex", executorId: null, model: null, reasoningEffort: null, sessionRole: null,
  origin: `monitor:${index}`, mode: "queued", sendAt: "2026-10-24T10:00:00.000Z", status: "pending",
  createdAt: "2026-10-24T10:00:00.000Z", sentAt: null,
}));
let browser;
try {
  await mkdir(artifacts, { recursive: true });
  const base = web.origin;
  browser = await launchChrome();
  for (const variant of ["single", "team"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 400 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", (route) => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/scheduled-messages") ? messages : [] }));
    try {
      await page.goto(`${base}/scripts/fixtures/scheduled-message-reply.html?variant=${variant}`);
      const input = page.locator(variant === "single" ? ".task-reply-box textarea" : ".team-reply-box textarea");
      const send = page.getByRole("button", { name: variant === "single" ? "排队发送" : "发送给调度者", exact: true });
      const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const visibleSend = async (label) => {
        const result = await send.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { top: box.top, bottom: box.bottom, height: innerHeight, hit: element.contains(hit), scrollTop: document.scrollingElement.scrollTop };
        });
        assert.ok(result.top >= 0 && result.bottom <= result.height, `${variant} ${label}: ${JSON.stringify(result)}`);
        assert.equal(result.hit, true, `${variant} ${label}: 发送按钮不能被裁剪或覆盖`);
        assert.equal(result.scrollTop, 0, `${variant} ${label}: 不能依赖页面滚动找回发送按钮`);
        return result;
      };
      const toggle = page.getByRole("button", { name: "排队 10", exact: true });
      await toggle.waitFor();
      await input.fill("要发送的草稿");
      const before = await visibleSend("短窗口折叠");
      await toggle.click();
      await settle();
      const after = await visibleSend("短窗口展开");
      assert.ok(Math.abs(after.bottom - before.bottom) < 1, `${variant}: 展开不将发送区向下推`);
      await page.screenshot({ path: `${artifacts}scheduled-message-reply-${variant}-short.png` });
      await page.setViewportSize({ width: 390, height: 700 });
      await page.getByRole("separator").focus();
      await page.keyboard.press("End");
      await settle();
      await visibleSend("拉到最大高度");
      await input.fill(Array.from({ length: 80 }, (_, index) => `保留草稿第 ${index} 行`).join("\n"));
      assert.equal(await input.evaluate((element) => getComputedStyle(element).overflowY), "auto");
      assert.equal(await input.evaluate((element) => element.scrollHeight > element.clientHeight), true);
      await page.screenshot({ path: `${artifacts}scheduled-message-reply-${variant}-resized.png` });
      await page.getByRole("button", { name: "加入附件", exact: true }).click();
      await page.locator(".task-upload-chip").first().waitFor();
      for (const [width, height] of [[320, 320], [390, 400], [1024, 500], [390, 700]]) {
        await resizeViewport(page, { width, height });
        await settle();
        await visibleSend(`${width}×${height}，拉高且有附件`);
        assert.equal(await page.locator(".reply-context").evaluate((element) => element.scrollHeight > element.clientHeight), true, "辅助内容在共同预算内滚动");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      assert.equal(await input.inputValue(), Array.from({ length: 80 }, (_, index) => `保留草稿第 ${index} 行`).join("\n"), "调整布局不改动草稿");
      await page.getByRole("separator").press("Home");
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await settle();
      await visibleSend("收起后");
      assert.deepEqual(errors, []);
      console.log(`✓ ${variant} 真实回复框：短视口、最大拉高、附件/操作栏、窗口变化和收起均保持发送按钮可见`);
    } catch (error) {
      await page.screenshot({ path: `${artifacts}scheduled-message-reply-${variant}-failure.png`, fullPage: true });
      throw error;
    } finally {
      await context.close();
    }
  }
  // 摘要那一列不许被挤没:一条长的等待说明(等同队任务)、一颗「直接发送」(前置任务已删)、一条审查答复
  // 摆在一起,所有宽度下每条摘要都留着能读、能点的宽度,点下去摊开的是它的全文。
  // 2026-11-15 审查实测:540px 时四列网格把摘要列算成 0 宽,两个宿主都中。
  // 收着那一行在任何宽度下都只占一行:摘要、要留意、引导键(任务侧)同排且够得着。第 2 轮审查实测:为保摘要
  // 让那一行允许折行后,320px 下引导键掉到了第二行。
  const failing = (id) => ({ ...messages[0], id, origin: `monitor:${id}`, text: `【哨兵结束】检查 ${id}，退出码 1。` });
  const mixed = [
    { ...messages[0], id: "mine", origin: null, agent: "codex", text: "顺手调整上限", steerable: true,
      wait: { kind: "queue", blockers: [{ id: "other", title: "这是一个正常长度的正在运行的前置任务", running: true }] } },
    { ...messages[0], id: "review", origin: null, sessionRole: "reviewer", agent: "codex", text: "审查答复",
      wait: { kind: "queue", blockers: [{ id: "other", title: "这是一个正常长度的正在运行的前置任务", running: true }] } },
    { ...messages[0], id: "after", origin: null, agent: "codex", text: "无需再等的原话", mode: "after", afterTaskId: "deleted", afterDoneAt: null },
    failing("fail-0"),
  ];
  const crowded = [mixed[0], ...Array.from({ length: 99 }, (_, index) => failing(`fail-${index}`))];
  /** 收着那一行:只占一行(各项同排、高度一行),摘要能读能点,任务侧引导键在、够得着。 */
  const collapsedLine = (page) => page.evaluate(() => {
    const line = document.querySelector(".scheduled-tray-line");
    const items = [...line.children].map((element) => element.getBoundingClientRect());
    const reach = (selector) => {
      const element = line.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + Math.min(box.width / 2, 10), box.top + box.height / 2);
      return { width: Math.round(box.width), hit: element.contains(hit) };
    };
    return {
      height: Math.round(line.getBoundingClientRect().height),
      sameRow: items.every((box) => Math.abs(box.top + box.height / 2 - (items[0].top + items[0].height / 2)) < 2),
      overflow: line.scrollWidth > line.clientWidth + 1,
      summary: reach(".scheduled-tray-head-summary"),
      guide: reach(".scheduled-message-guide"),
      attention: reach(".scheduled-tray-attention"),
    };
  });
  const assertOneLine = (state, variant, label) => {
    assert.ok(state.height <= 30 && state.sameRow && !state.overflow, `${variant} ${label} 收着只占一行：${JSON.stringify(state)}`);
    assert.ok(state.summary && state.summary.width >= 24 && state.summary.hit, `${variant} ${label} 收着那一行的摘要能读能点：${JSON.stringify(state)}`);
    assert.ok(state.attention?.hit, `${variant} ${label} 要留意够得着：${JSON.stringify(state)}`);
    if (variant === "single") assert.ok(state.guide?.hit, `${variant} ${label} 引导键在这一行上、够得着：${JSON.stringify(state)}`);
    else assert.equal(state.guide, null, "团队回复框没有引导");
  };
  for (const variant of ["single", "team"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 750 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let pending = mixed;
    await page.route("**/api/**", (route) => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/scheduled-messages") ? pending : [] }));
    try {
      await page.goto(`${base}/scripts/fixtures/scheduled-message-reply.html?variant=${variant}`);
      const toggle = page.getByRole("button", { name: `排队 ${mixed.length}`, exact: true });
      await toggle.waitFor();
      const reachable = (selector) => page.evaluate((selector) => [...document.querySelectorAll(selector)].map((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + Math.min(box.width / 2, 20), box.top + box.height / 2);
        return { text: element.textContent, width: Math.round(box.width), hit: element.contains(hit) };
      }), selector);
      for (const width of [1280, 1024, 800, 640, 600, 560, 540, 500, 480, 420, 390, 360, 320]) {
        await resizeViewport(page, { width, height: 750 });
        if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
        assertOneLine(await collapsedLine(page), variant, `${width}px`);
        await toggle.click();
        await page.locator(".scheduled-tray-list").waitFor();
        const summaries = await reachable(".scheduled-message-summary");
        assert.equal(summaries.length, mixed.length);
        for (const summary of summaries) {
          assert.ok(summary.width >= 60 && summary.hit, `${variant} ${width}px 摘要「${summary.text}」能读能点：${JSON.stringify(summary)}`);
        }
        assert.equal(await page.locator(".scheduled-message-actions").getByRole("button", { name: /直接发出/ }).count(), 1, `${variant} ${width}px 直接发送还在`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${variant} ${width}px 页面不横溢`);
      }
      await page.locator('[data-message-id="after"] .scheduled-message-summary').click();
      await page.locator('[data-message-id="after"] .scheduled-message-full').waitFor();
      await resizeViewport(page, { width: 540, height: 750 });
      await page.screenshot({ path: `${artifacts}scheduled-message-reply-${variant}-mixed-540.png` });
      // 多位数条数 + 多位数要留意:最挤的那种,收着仍是一行;点要留意再 Esc 收回来也一样。
      pending = crowded;
      await page.reload();
      const crowdedToggle = page.getByRole("button", { name: "排队 100", exact: true });
      await crowdedToggle.waitFor();
      for (const width of [800, 480, 390, 360, 320, 300]) {
        await resizeViewport(page, { width, height: 750 });
        assertOneLine(await collapsedLine(page), variant, `${width}px / 100 条`);
      }
      await page.getByRole("button", { name: "查看 99 条退出码非零的输入" }).click();
      await page.locator(".scheduled-tray-list").waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await crowdedToggle.getAttribute("aria-expanded"), "false");
      assertOneLine(await collapsedLine(page), variant, "300px / 100 条 Esc 收回后");
      await page.screenshot({ path: `${artifacts}scheduled-message-reply-${variant}-crowded-300.png` });
      assert.deepEqual(errors, []);
      console.log(`✓ ${variant} 混合输入：1280–300px 收着只占一行（含 100 条 / 99 条要留意）且摘要、引导够得着，点开后每条摘要都能读能点`);
    } finally {
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const demo = fileURLToPath(new URL("../../docs/demos/pending-input-demo.html", import.meta.url));
  await page.goto(`${base}/@fs${demo}`);
  await page.getByRole("button", { name: "展开全部 10 条", exact: true }).click();
  const footer = await page.locator(".composer-footer").boundingBox();
  const frame = await page.locator(".app-window").boundingBox();
  assert.ok(footer.y + footer.height <= frame.y + frame.height, "原型同类边界也不能挤出发送区");
  assert.match(await page.locator("#cancel-dialog").textContent(), /不执行停止哨兵操作/);
  console.log("✓ 原型共用高度边界与中性取消说明通过");
} finally {
  await browser?.close();
  await web.close();
}
