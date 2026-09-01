import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object");
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
  const fixture = `http://127.0.0.1:${address.port}/scripts/fixtures/system-notices.html`;
  await page.goto(fixture);
  await page.locator(".system-event-digest.is-aligned").waitFor();
  assert.equal(await page.locator(".system-event-digest.is-aligned").count(), 1, "生产环境默认使用备选二");
  assert.equal(await page.locator(".system-notice-mode-switch").count(), 0, "普通页面不显示方案比较开关");

  await page.goto(`${fixture}?systemNotices=unknown`);
  assert.equal(await page.locator(".system-event-digest.is-aligned").count(), 1, "非法模式参数应回落到正式默认方案二");
  assert.equal(await page.locator('.system-notice-mode-switch a[aria-current="page"]').innerText(), "备选二 · 头像轴提示");

  await page.goto(`${fixture}?systemNotices=footnote`);

  const action = page.locator(".system-action-note.is-conflict");
  await action.waitFor();
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

  const digest = page.locator(".system-event-digest.is-footnote");
  assert.equal(await digest.count(), 1, "连续系统事件应合成一条会话脚注");
  assert.match(await digest.locator("summary").innerText(), /工作区已恢复.*5 条记录/s, "摘要必须显示组内最新状态");
  const latestPair = await digest.evaluate((el) => {
    const summary = el.querySelector("summary");
    const latest = el.querySelector("li:last-child");
    return {
      summaryText: summary.querySelector(":scope > span").textContent,
      summaryTime: summary.querySelector(":scope > time")?.textContent,
      latestText: latest.querySelector(":scope > span").textContent,
      latestTime: latest.querySelector(":scope > time")?.textContent,
    };
  });
  assert.equal(latestPair.summaryText, latestPair.latestText, "摘要文字必须来自最新事件");
  assert.equal(latestPair.summaryTime, latestPair.latestTime, "摘要时间必须来自同一条最新事件");
  assert.equal(await digest.evaluate((el) => el.classList.contains("is-recovery")), true, "摘要语气必须与最新恢复事件一致");
  assert.equal(await digest.evaluate((el) => el.classList.contains("is-error")), false, "恢复文字不能被旧失败染成整行红色");
  assert.match(await digest.locator(".system-event-issues").innerText(), /其中 1 条异常/, "组内旧失败仍应用可读文字提示");
  const marker = await digest.evaluate((el) => {
    const style = getComputedStyle(el, "::before");
    return { width: style.width, height: style.height, radius: style.borderRadius, content: style.content };
  });
  assert.deepEqual(marker, { width: "4px", height: "4px", radius: "50%", content: '""' }, "脚注使用无方向性的 4px 圆点，不再显示弯箭头");
  const compactLine = await digest.locator("summary").evaluate((el) => {
    const timeElement = el.querySelector(":scope > time");
    const time = timeElement.getBoundingClientRect();
    const previous = timeElement.previousElementSibling.getBoundingClientRect();
    return {
      gap: Math.round(time.left - previous.right),
      lineWidth: Math.round(el.getBoundingClientRect().width),
      containerWidth: Math.round(el.parentElement.getBoundingClientRect().width),
    };
  });
  assert.ok(compactLine.gap <= 16, "时间应紧跟在最后一个摘要信息块之后");
  assert.equal(compactLine.lineWidth, compactLine.containerWidth, "系统提示应按内容收缩，不铺成整行");
  assert.ok(compactLine.containerWidth < 500, "短系统提示不应占满会话内容宽度");
  await digest.locator("summary").click();
  assert.match(await digest.innerText(), /已预约完成后审查.*验收阶段更新.*本回合没有交卷.*工作区已恢复/s);
  assert.equal(await page.locator(".system-event-row").count(), 0, "任务会话不再逐条铺系统事件");
  assert.equal(await page.locator(".system-boundary").count(), 1);
  assert.equal(await page.locator(".task-message--agent").count(), 2, "普通 agent 消息结构没有改");
  assert.equal(await page.locator(".system-notice-mode-switch a").count(), 4, "带模式参数时显示两套备选与两种早期方向");
  assert.equal(await page.locator('.system-notice-mode-switch a[aria-current="page"]').innerText(), "备选一 · 轻量脚注");

  await page.goto(`${fixture}?systemNotices=aligned`);
  const aligned = page.locator(".system-event-digest.is-aligned");
  await aligned.waitFor();
  const alignedGeometry = await page.evaluate(() => {
    const agentAvatar = document.querySelector(".task-message-avatar").getBoundingClientRect();
    const agentBody = document.querySelector(".task-message-content").getBoundingClientRect();
    const digest = document.querySelector(".system-event-digest.is-aligned");
    const digestIcon = digest.querySelector(".system-event-avatar").getBoundingClientRect();
    const digestLine = digest.querySelector("summary").getBoundingClientRect();
    const action = document.querySelector(".system-action-note");
    const actionIcon = action.querySelector(".system-action-icon").getBoundingClientRect();
    const actionMain = action.querySelector(".system-action-main").getBoundingClientRect();
    const boundary = document.querySelector(".system-boundary.notice-mode-aligned");
    const digestBox = digest.getBoundingClientRect();
    const boundaryBox = boundary.getBoundingClientRect();
    return {
      avatarCenter: Math.round(agentAvatar.left + agentAvatar.width / 2),
      bodyLeft: Math.round(agentBody.left),
      digestIconCenter: Math.round(digestIcon.left + digestIcon.width / 2),
      digestLineLeft: Math.round(digestLine.left),
      actionIconCenter: Math.round(actionIcon.left + actionIcon.width / 2),
      actionMainLeft: Math.round(actionMain.left),
      iconSize: `${Math.round(digestIcon.width)}x${Math.round(digestIcon.height)}`,
      iconBackground: getComputedStyle(digest.querySelector(".system-event-avatar")).backgroundColor,
      boundaryIcon: !!boundary?.querySelector(".system-event-avatar"),
      boundaryWiderThanDigest: boundaryBox.width > digestBox.width,
      boundaryRule: !!boundary?.querySelector(".system-boundary-rule"),
    };
  });
  assert.equal(alignedGeometry.digestIconCenter, alignedGeometry.avatarCenter, "系统节点应与智能体头像中心对齐");
  assert.equal(alignedGeometry.actionIconCenter, alignedGeometry.avatarCenter, "系统长提示同样进入头像轴");
  assert.equal(alignedGeometry.digestLineLeft, alignedGeometry.bodyLeft, "系统摘要正文应与智能体正文起点对齐");
  assert.equal(alignedGeometry.actionMainLeft, alignedGeometry.bodyLeft, "系统长提示正文应与智能体正文起点对齐");
  assert.equal(alignedGeometry.iconSize, "16x16", "系统节点外圈应比智能体头像更克制");
  assert.notEqual(alignedGeometry.iconBackground, "rgba(0, 0, 0, 0)", "备选二用轻底色提高一点辨识度");
  assert.equal(alignedGeometry.boundaryIcon, true, "回合边界也应使用同一系统节点");
  assert.equal(alignedGeometry.boundaryRule, true, "回合边界应保留横贯细线");
  assert.equal(alignedGeometry.boundaryWiderThanDigest, true, "回合边界应明显宽于普通系统旁注");
  assert.equal(await page.locator('.system-notice-mode-switch a[aria-current="page"]').innerText(), "备选二 · 头像轴提示");

  await page.goto(`${fixture}?systemNotices=collapsed`);
  const collapsed = page.locator(".system-event-digest.is-collapsed");
  await collapsed.waitFor();
  assert.match(await collapsed.locator("summary").innerText(), /系统记录 · 工作区已恢复/);
  assert.equal(await page.locator('.system-notice-mode-switch a[aria-current="page"]').innerText(), "系统记录折叠");

  await page.goto(`${fixture}?systemNotices=attached`);
  const attached = page.locator(".system-event-digest.is-attached");
  await attached.waitFor();
  const attachedStyle = await attached.evaluate((el) => {
    const style = getComputedStyle(el);
    const line = el.querySelector("summary");
    const timeElement = line.querySelector(":scope > time");
    const time = timeElement.getBoundingClientRect();
    const previous = timeElement.previousElementSibling.getBoundingClientRect();
    return {
      marginTop: Number.parseFloat(style.marginTop),
      border: getComputedStyle(line).borderTopWidth,
      timeGap: Math.round(time.left - previous.right),
    };
  });
  assert.ok(attachedStyle.marginTop < 0, "消息尾注应贴近上一段会话");
  assert.notEqual(attachedStyle.border, "0px", "消息尾注用细线表达它属于上一段消息");
  assert.ok(attachedStyle.timeGap <= 16, "消息尾注的时间同样应紧跟最后一个摘要信息块");
  assert.equal(await page.locator('.system-notice-mode-switch a[aria-current="page"]').innerText(), "消息尾注");

  await page.setViewportSize({ width: 390, height: 900 });
  const geometry = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    actionWidth: Math.round(document.querySelector(".system-action-note").getBoundingClientRect().width),
  }));
  assert.equal(geometry.overflow, false, "窄屏不能横向溢出");
  assert.ok(geometry.actionWidth <= 370, "系统旁注应收进窄屏可用宽度");

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/review-system-prompts.html`);
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
  console.log("system-notices-dom ok");
} finally {
  await browser?.close();
  await server.close();
}
