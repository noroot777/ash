import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./dom-stage.mjs";
import { createServer } from "vite";
import { resizeViewport } from "./wait-until.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", define: { "import.meta.env.VITE_ASH_PREVIEW": '"1"' },
  server: { host: "127.0.0.1", port: 0, strictPort: false } });

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object");
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
  const fixture = `http://127.0.0.1:${address.port}/scripts/fixtures/system-notices.html`;
  await page.goto(fixture);

  const action = page.locator(".system-action-note.is-conflict");
  await action.waitFor();
  assert.equal(await page.locator(".system-notice-mode-switch").count(), 0, "四套试验摆法连同切换条一起拿掉了");
  assert.equal(await action.count(), 1, "冲突流程只占一条系统旁注");
  assert.match(await action.innerText(), /验收遇到冲突.*目标分支未改动/s);
  assert.equal(await action.locator(".system-action-files").isHidden(), true, "冲突文件默认收进详情，不在会话里铺开");
  assert.equal(await page.locator(".task-message--user.is-system-authored:not(.system-action-wrap)").count(), 0, "不再保留旧系统消息块");
  const visual = await action.evaluate((el) => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow };
  });
  assert.equal(visual.background, "rgba(0, 0, 0, 0)", "系统指令不再使用卡片底色");
  assert.equal(visual.border, "0px", "系统指令不再使用卡片描边");
  assert.equal(visual.shadow, "none", "系统指令不再使用卡片阴影");
  await action.getByText("查看处理步骤", { exact: true }).click();
  assert.deepEqual(await action.locator(".system-action-files code").allInnerTexts(), ["server/package.json", "web/src/App.tsx"]);
  await action.getByText("流程记录 3 条", { exact: true }).click();
  assert.match(await action.innerText(), /开始验收.*验收未完成.*冲突交接/s, "原始流程记录仍可展开核对");

  // —— 会话里占行的只有你说的、它说的；ash 的话是所属回合最后那一句小灰字（尾注） ——
  assert.equal(await page.locator(".notice-line, .review-milestone").count(), 0, "图标落在头像轴上的独占一行整个退役");
  const owner = page.locator(".task-message--agent").filter({ hasText: "冲突已经解决并提交。" });
  const footnotes = page.locator(".turn-footnote");
  assert.equal(await footnotes.count(), 1, "回执、明面的话都不在会话里另占一行");
  const footnote = owner.locator(".turn-footnote");
  assert.deepEqual(
    await footnote.locator(".turn-footnote-text").allInnerTexts(),
    ["已验收，合并到 main", "工作区已恢复，会话内容都在"],
    "几件事并成一句；明面的话只留最近那一句",
  );
  assert.equal(await footnote.locator("svg").count(), 0, "尾注没有图标");
  assert.equal(await footnote.locator(".turn-footnote-dot").count(), 0, "通过、已验收、中性的话不带任何颜色");
  const look = await page.evaluate(() => {
    const message = [...document.querySelectorAll(".task-message--agent")].find((el) => el.textContent.includes("冲突已经解决并提交。"));
    const note = message.querySelector(".turn-footnote");
    const body = message.querySelector(".task-turn-markdown, .task-markdown") ?? message.querySelector(".task-message-content");
    const acts = message.querySelector(".turn-acts").getBoundingClientRect();
    const mono = note.querySelector(".turn-footnote-mono");
    const style = getComputedStyle(note);
    return {
      left: Math.round(note.getBoundingClientRect().left),
      body: Math.round(body.getBoundingClientRect().left),
      aboveActs: note.getBoundingClientRect().bottom <= acts.top + 1,
      fontSize: style.fontSize,
      color: style.color,
      headColor: getComputedStyle(message.querySelector(".turn-head")).color,
      background: style.backgroundColor,
      mono: mono.textContent,
      monoFamily: getComputedStyle(mono).fontFamily,
      monoBackground: getComputedStyle(mono).backgroundColor,
      weights: [...note.querySelectorAll("*")].map((el) => getComputedStyle(el).fontWeight),
    };
  });
  assert.equal(look.left, look.body, "尾注的左缘跟正文对齐，不在头像那一列");
  assert.equal(look.aboveActs, true, "尾注在回合尾那排悬停操作上面");
  assert.equal(look.fontSize, "12px", "跟回合头那句起因同一档字号");
  assert.equal(look.color, look.headColor, "跟回合头同一种次级灰");
  assert.equal(look.background, "rgba(0, 0, 0, 0)", "不垫底色");
  assert.equal(look.mono, "main", "分支名换成等宽字");
  assert.match(look.monoFamily, /mono|Menlo|Consolas|Courier/i);
  assert.equal(look.monoBackground, "rgba(0, 0, 0, 0)", "等宽字不垫底色");
  assert.ok(look.weights.every((weight) => ["400", "500", "600"].includes(weight)), `字重只用 400/500/600：${look.weights}`);

  // 指到尾注才出最近那一句的时刻；它跟在字后面。
  const tail = footnote.locator(".turn-footnote-tail");
  await page.mouse.move(990, 5);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-footnote-tail")).opacity === "0");
  await footnote.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-footnote-tail")).opacity === "1");
  assert.match(await tail.innerText(), /09\/01 \d\d:10/, "取最近那一句的时刻");

  // 有原文细节的那半句点了就地摊开原文；能点的是一颗键（键盘走得到）。
  const recovery = footnote.locator("button.turn-footnote-part").filter({ hasText: "工作区已恢复" });
  await recovery.focus();
  await page.keyboard.press("Enter");
  assert.match(await footnote.locator(".turn-footnote-detail").innerText(), /原目录已不存在/);
  assert.equal(await recovery.getAttribute("aria-expanded"), "true");
  assert.equal(await footnote.locator(".turn-footnote-part.is-static").filter({ hasText: "已验收" }).count(), 1, "验收那句不能点");
  await recovery.evaluate((el) => el.blur());

  // —— 回执、连同尾注里的每一句，都记在这一回合上：指到这一回合才有「N 条记录」 ——
  const receipts = owner.locator(".turn-acts");
  assert.equal(await owner.locator(".turn-receipts-toggle").count(), 1, "回执记到了它之前最近的那一回合上");
  const actsOpacity = () => receipts.evaluate((el) => getComputedStyle(el).opacity);
  await page.mouse.move(990, 5);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-acts:has(.turn-receipts-toggle)")).opacity === "0");
  await owner.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-acts:has(.turn-receipts-toggle)")).opacity === "1");
  const toggle = receipts.locator(".turn-receipts-toggle");
  assert.equal(await toggle.innerText(), "8 条记录");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  const log = owner.locator(".turn-receipt-log");
  assert.deepEqual(
    await log.locator(".turn-receipt-text").allInnerTexts(),
    [
      "审查已预约，这一轮跑完自动开始", "不再等哨兵「全量回归」了，它已经跑完", "已验收，合并到 main", "验收阶段：验收完成",
      "合并有冲突，但没能叫醒任务去解", "本回合没有交卷：产物仍保留，可直接重试。", "工作区已恢复，会话内容都在", "本轮执行结束",
    ],
    "流水里每一条写的是结果；尾注里的那几句也在这里（删除在这里）",
  );
  const leading = await log.locator(".turn-receipt").first().evaluate((el) => {
    const time = el.querySelector(":scope > time");
    const text = el.querySelector(".turn-receipt-text").getBoundingClientRect();
    return { first: el.firstElementChild === time, before: time.getBoundingClientRect().right <= text.left, label: time.getAttribute("aria-label") };
  });
  assert.equal(leading.first, true, "时刻排在每一条最前面");
  // 每一条前面一枚图标，贴在字前面；读屏不念它（字已经说清了）。
  assert.equal(await log.locator(".turn-receipt-body > .notice-icon svg").count(), 8, "每一条都有图标");
  const icon = await log.locator(".turn-receipt").nth(1).evaluate((el) => {
    const glyph = el.querySelector(".turn-receipt-body > .notice-icon");
    const text = el.querySelector(".turn-receipt-text").getBoundingClientRect();
    return { hidden: glyph.getAttribute("aria-hidden"), before: glyph.getBoundingClientRect().right <= text.left };
  });
  assert.deepEqual(icon, { hidden: "true", before: true });
  // 窄栏：字在图标后面那一列里折行，不整句掉到图标下面（审查第 1 轮实测的那种）。
  await resizeViewport(page, { width: 320, height: 1300 });
  const rows = await log.locator(".turn-receipt").evaluateAll((items) => items.map((el) => {
    const glyph = el.querySelector(".turn-receipt-body > .notice-icon").getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el.querySelector(".turn-receipt-text"));
    const lines = range.getClientRects();
    const timeNode = el.querySelector(":scope > time");
    const timeRange = document.createRange();
    if (timeNode) timeRange.selectNodeContents(timeNode);
    const time = timeNode ? timeRange.getClientRects()[0] : null;
    return {
      sameLine: Math.abs(lines[0].top - glyph.top) < glyph.height && (!time || Math.abs(lines[0].top - time.top) < 3),
      after: glyph.right <= lines[0].left,
      lines: lines.length,
    };
  }));
  assert.ok(rows.some((row) => row.lines > 1), "窄栏里至少有一条真折了行，不然这一条什么都没证明");
  assert.ok(rows.every((row) => row.sameLine && row.after), `字的第一行跟图标、时刻同一行（时刻不沿整段居中）：${JSON.stringify(rows)}`);
  await resizeViewport(page, { width: 1000, height: 1300 });
  assert.equal(leading.before, true);
  assert.match(leading.label, /\d\d\/\d\d \d\d:\d\d/, "读屏拿到完整的日期时刻");
  await page.mouse.move(990, 5);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-acts:has(.turn-receipts-toggle)")).opacity === "1");
  assert.equal(await actsOpacity(), "1", "点开以后一直在，不等指到");
  const released = log.locator(".turn-receipt").nth(1);
  await released.locator(".turn-receipt-more").click();
  assert.match(await released.locator(".turn-receipt-detail").innerText(), /exit 0/, "原文点那一条再看");

  // 键盘：Tab 走到「N 条记录」时它现形，焦点看得见。
  await page.reload();
  await page.locator(".turn-receipts-toggle").first().waitFor({ state: "attached" });
  await page.mouse.move(990, 5);
  await page.locator(".turn-receipts-toggle").first().focus();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-acts:has(.turn-receipts-toggle)")).opacity === "1", null, { timeout: 2000 });

  // 触屏没有「指到」：回执那颗键与尾注的时刻常显。
  const touch = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true });
  const touchPage = await touch.newPage();
  await touchPage.goto(fixture);
  await touchPage.locator(".turn-footnote").first().waitFor();
  assert.equal(await touchPage.evaluate(() => matchMedia("(hover: none)").matches), true, "模拟的触屏得真是「没有指到」");
  assert.equal(await touchPage.locator(".turn-footnote-tail").first().evaluate((el) => getComputedStyle(el).opacity), "1", "触屏上时刻常显");
  assert.equal(await touchPage.locator(".turn-acts:has(.turn-receipts-toggle)").first().evaluate((el) => getComputedStyle(el).opacity), "1", "触屏上「N 条记录」常显");
  await touch.close();

  // —— 颜色只说现在的事：前一个回合上的「未通过」是灰字，最后一个回合上的字前有红点 ——
  for (const theme of ["light", "dark"]) {
    const dots = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme: theme });
    await dots.goto(`${fixture}?dots`);
    await dots.locator(".turn-footnote").nth(1).waitFor();
    const state = await dots.locator(".turn-footnote").evaluateAll((notes) => notes.map((note) => ({
      text: note.querySelector(".turn-footnote-text").textContent,
      dot: note.querySelector(".turn-footnote-dot") ? getComputedStyle(note.querySelector(".turn-footnote-dot")).backgroundColor : null,
      size: note.querySelector(".turn-footnote-dot")?.getBoundingClientRect().width ?? null,
      color: getComputedStyle(note.querySelector(".turn-footnote-text")).color,
    })));
    const red = await dots.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(--red)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    assert.deepEqual(state.map((entry) => entry.text), ["第 1 轮审查未通过", "第 2 轮审查未通过"]);
    assert.equal(state[0].dot, null, `${theme}：后面又起了回合，点熄掉`);
    assert.equal(state[1].dot, red, `${theme}：最后一个回合上没办成的那一句字前一颗红点`);
    assert.equal(state[1].size, 6, "6px 的小圆点");
    assert.equal(state[0].color, state[1].color, `${theme}：字本身一律是灰的，颜色只在点上`);
    await dots.close();
  }

  // —— 收了口的审查轮：被审回合之后靠右一颗气泡，结论之后的验收贴在它下面（靠右、时刻在字前面）——
  for (const theme of ["light", "dark"]) {
    const reviewed = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme: theme });
    await reviewed.goto(`${fixture}?verdicts`);
    await reviewed.locator(".review-verdict").nth(1).waitFor();
    const flow = await reviewed.locator(".task-conversation > *").evaluateAll((els) => els.flatMap((el) =>
      el.classList.contains("review-verdict") ? [`结论:${el.querySelector(".review-verdict-text").textContent}`]
        : el.classList.contains("task-message--agent") ? ["回合"] : []));
    assert.deepEqual(flow, ["回合", "结论:第 1 轮审查未通过", "回合", "结论:第 2 轮审查通过"], `${theme}：结论夹在被审回合和下一回合之间`);
    assert.equal(await reviewed.locator(".task-conversation > .task-message--agent .turn-footnote").count(), 0, "最后那个回合下面没有这两句");
    assert.equal(await reviewed.locator(".turn-footnote-dot").count(), 0, `${theme}：后面又起了回合的未通过、通过都不带颜色`);
    const trailing = reviewed.locator(".review-verdict").nth(1).locator(":scope > .turn-footnote.is-trailing");
    assert.deepEqual(await trailing.locator(".turn-footnote-text").allTextContents(), ["已验收，合并到 main"]);
    const edges = await reviewed.locator(".review-verdict").nth(1).evaluate((el) => {
      const bubble = el.querySelector(".review-verdict-bubble").getBoundingClientRect();
      const text = el.querySelector(".turn-footnote.is-trailing .turn-footnote-part").getBoundingClientRect();
      const tail = el.querySelector(".turn-footnote.is-trailing .turn-footnote-tail").getBoundingClientRect();
      const style = getComputedStyle(el.querySelector(".review-verdict-bubble"));
      return { right: Math.abs(bubble.right - text.right) <= 3, below: text.top >= bubble.bottom, tailFirst: tail.right <= text.left, background: style.backgroundColor };
    });
    assert.deepEqual(edges, { right: true, below: true, tailFirst: true, background: "rgba(0, 0, 0, 0)" }, `${theme}：贴在气泡下面、右缘对齐；藏着的时刻在字前面`);
    await reviewed.close();

    const failed = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme: theme });
    await failed.goto(`${fixture}?verdicts=failed`);
    await failed.locator(".review-verdict").waitFor();
    const red = await failed.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(--red)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    assert.equal(await failed.locator(".review-verdict[role=status] .review-verdict-text .turn-footnote-dot").evaluate((el) => getComputedStyle(el).backgroundColor), red, `${theme}：最后一件事是未通过，字前一颗红点`);
    await failed.close();
  }

  await resizeViewport(page, { width: 390, height: 900 });
  const geometry = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    actionWidth: Math.round(document.querySelector(".system-action-note").getBoundingClientRect().width),
  }));
  assert.equal(geometry.overflow, false, "窄屏不能横向溢出");
  assert.ok(geometry.actionWidth <= 370, "系统旁注应收进窄屏可用宽度");

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/review-system-prompts.html`);
  await page.locator('[data-surface="team"] .is-system-authored').waitFor();
  const authoredStyles = await page.evaluate(() => {
    const read = (surface) => {
      const root = document.querySelector(`[data-surface="${surface}"]`);
      const authored = root.querySelector(".is-system-authored");
      const authoredBubble = authored.querySelector(surface === "task" ? ".task-user-bubble" : ":scope > div");
      const authoredText = authoredBubble.querySelector(".task-markdown");
      const user = root.querySelector(surface === "task"
        ? ".task-message--user:not(.is-system-authored)"
        : ".team-feed-user:not(.is-system-authored)");
      const userBubble = user.querySelector(surface === "task" ? ".task-user-bubble" : ":scope > div");
      const articleStyle = getComputedStyle(authored);
      const bubbleStyle = getComputedStyle(authoredBubble);
      const userArticleStyle = getComputedStyle(user);
      const userBubbleStyle = getComputedStyle(userBubble);
      return {
        justify: articleStyle.justifyContent,
        background: bubbleStyle.backgroundColor,
        borderTop: bubbleStyle.borderTopWidth,
        borderLeft: bubbleStyle.borderLeftWidth,
        radius: bubbleStyle.borderRadius,
        fontSize: getComputedStyle(authoredText).fontSize,
        userJustify: userArticleStyle.justifyContent,
        userBackground: userBubbleStyle.backgroundColor,
        userBorderTop: userBubbleStyle.borderTopWidth,
        userRadius: userBubbleStyle.borderRadius,
      };
    };
    return { task: read("task"), team: read("team") };
  });
  for (const [surface, styles] of Object.entries(authoredStyles)) {
    assert.equal(styles.justify, "flex-start", `${surface} 审查系统提示必须左对齐`);
    assert.equal(styles.background, "rgba(0, 0, 0, 0)", `${surface} 审查系统提示不使用用户气泡底色`);
    assert.equal(styles.borderTop, "0px", `${surface} 审查系统提示不使用用户气泡外框`);
    assert.equal(styles.borderLeft, "2px", `${surface} 审查系统提示保留原来的短竖线`);
    assert.equal(styles.radius, "0px", `${surface} 审查系统提示不使用用户气泡圆角`);
    assert.equal(styles.fontSize, "12px", `${surface} 审查系统提示保留原字号`);
    assert.equal(styles.userJustify, "flex-end", `${surface} 普通用户消息仍右对齐`);
    assert.notEqual(styles.userBackground, "rgba(0, 0, 0, 0)", `${surface} 普通用户气泡仍保留底色`);
    assert.notEqual(styles.userBorderTop, "0px", `${surface} 普通用户气泡仍保留外框`);
    assert.notEqual(styles.userRadius, "0px", `${surface} 普通用户气泡仍保留圆角`);
  }

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  await page.goto(`${fixture}?boundaries`);
  await page.locator("[data-surface] .system-boundary").first().waitFor();
  for (const width of [1100, 390]) {
    await resizeViewport(page, { width, height: 1000 });
    const boundaries = await page.locator("[data-surface] .system-boundary").evaluateAll((elements) =>
      elements.map((element) => ({
        surface: element.closest("[data-surface]").dataset.surface,
        error: element.classList.contains("is-error"),
        rules: [...element.querySelectorAll(".system-boundary-rule")].map((rule) => {
          const box = rule.getBoundingClientRect();
          return { width: box.width, height: box.height, hidden: rule.getAttribute("aria-hidden") };
        }),
      })),
    );
    assert.equal(boundaries.length, 4, "两种会话和两种结束状态都应覆盖");
    for (const boundary of boundaries) {
      const label = `${width}px ${boundary.surface}/${boundary.error ? "error" : "neutral"}`;
      assert.equal(boundary.rules.length, 2, `${label} 两侧各一条分隔线`);
      for (const rule of boundary.rules) {
        assert.equal(rule.height, 1, `${label} 分隔线应为 1px`);
        assert.ok(rule.width > 0, `${label} 分隔线应保持可见`);
        assert.equal(rule.hidden, "true", `${label} 装饰横线不应进入无障碍朗读`);
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px 回合边界不应横向溢出`);
  }
  if (process.env.BOUNDARY_SHOT) {
    await resizeViewport(page, { width: 1100, height: 1000 });
    await page.screenshot({ path: process.env.BOUNDARY_SHOT, fullPage: true });
  }
  console.log("system-notices-dom ok");
} finally {
  await browser?.close();
  await server.close();
}
