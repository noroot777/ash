// 文案里的「设置 → 项目设置 → 预览 → 自定义脚本」是一条**能点着走过去的路**。
// 跑：npm -w web run test:settings-path-jump
//
// 钉四条：
//   ① 那段路径渲染成一颗能点的链接，且**一个字都没改**——这段话本身还要拿来照抄。
//   ② 点一下就进项目设置那一节。
//   ③ 而且停在**预览那张卡**上（滚进视口 + 点一下它），不是把人扔在页首自己找。
//   ④ 认不出去处的路径（设置里没有那一节）照旧是普通文字，不给一颗点了去错地方的链接。
//   ⑤ 设置页自己指的路同样能点：「默认规则」里那句「worktree 默认值搬去项目级了」一点
//      就落到项目设置的工作目录那张卡上。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${web.origin}/scripts/fixtures/settings-path-jump.html`);

  // ① 报一句「预览起不来」，那条路成了链接，原话没被改动。
  await page.getByTestId("raise-ambiguous").click();
  const link = page.getByRole("button", { name: "「设置 → 项目设置 → 预览 → 选择服务」" });
  await link.waitFor();
  const expected = await page.evaluate(() => window.__ambiguous);
  assert.equal(
    await page.evaluate(() => document.querySelector(".workspace-toast.is-sticky .workspace-toast-text")?.textContent),
    expected, "加了链接之后报错原文被改动了",
  );

  // ② + ③ 点它：进项目设置，并停在预览那张卡上。
  await link.click();
  await page.locator(".settings-shell").waitFor();
  const anchored = page.locator('[data-settings-anchor="preview"]');
  await anchored.waitFor();
  // 「就是这张」那一下（is-anchor-flash）证明落点找着了；类名 1.6s 后自己掉，所以先等它。
  await page.waitForFunction(
    () => document.querySelector('[data-settings-anchor="preview"]')?.classList.contains("is-anchor-flash") ?? false,
  );
  // 平滑滚动要几帧才停，等它真进视口再断言 —— 只看类名的话，选择器写错高度也发现不了。
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-settings-anchor="preview"]')?.getBoundingClientRect();
    return !!rect && rect.top >= -2 && rect.top < window.innerHeight * 0.5;
  });

  // ④ 指向不存在的一节：只当普通文字，不长链接。
  await page.getByTestId("raise-unknown").click();
  const unknown = await page.evaluate(() => window.__unknownPath);
  await page.waitForFunction(
    (text) => document.querySelector(".workspace-toast.is-sticky .workspace-toast-text")?.textContent === text,
    unknown,
  );
  assert.equal(
    await page.evaluate(() => document.querySelectorAll(".workspace-toast .settings-path-link").length), 0,
    "认不出去处的路径也被画成了链接",
  );

  // ⑤ 设置页内部指路：默认规则 → 项目设置 → 工作目录，同样要真的停在那张卡上。
  await page.getByTestId("open-defaults").click();
  const moved = page.getByRole("button", { name: "「设置 → 项目设置 → 工作目录」" });
  await moved.waitFor();
  await moved.click();
  await page.waitForFunction(
    () => document.querySelector('[data-settings-anchor="worktree"]')?.classList.contains("is-anchor-flash") ?? false,
  );

  console.log("settings path jump: ok");
} finally {
  await browser?.close();
  await web.close();
}
