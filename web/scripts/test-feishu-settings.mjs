// 设置 → 飞书 分区。跑：npm -w web run test:feishu-settings
//
// 钉这几条：
//   ① 什么都没配：状态写「未配置」、开通顺序默认展开、Secret 是空密码框；填完保存走真人凭据，
//      状态跟着轮询从「连接中」走到「已连接」，Secret 收成「已配置（不回显）」。
//   ② 已连上：显示本月额度（次数 / 上限 / 百分比）、当前水位、可展开的按种类明细、发件积压。
//   ③ 绑定 none → code → pending → bound：码只在生成那一刻显示；飞书那头认领后两秒内出现
//      「是你吗」；确认后落「已绑定」，而且**确认之前已发出的那次轮询晚回也拽不回「待确认」**；
//      已绑定的卡上没有「当前项目」（飞书里在建任务表单、/tasks 卡上选项目）。
//   ④ 刷新后拿不回明文：显示「有一个未用的码」并能重新生成。
//   ⑤ 清除凭证必须经过确认框：点「清除」只开框、不发请求；取消不发；确认才发 DELETE。
//   ⑥ 群：已绑的群列出来；被群认领的码显示群名和目标项目，确认走真人凭据后进列表；
//      新生成的群码显示明文；解绑同样先过确认框。
//   真人专属动作每一下都带页面凭据，且用的是上一个响应轮换下来的那一份。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { chooseOption, selectedValue, selectTrigger } from "./select-helpers.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const errors = [];
  const open = async (query) => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${web.origin}/scripts/fixtures/feishu-settings.html?${query}`);
    await page.locator('[data-settings-anchor="feishu-connection"]').waitFor({ timeout: 10_000 });
    await page.locator('[data-settings-anchor="feishu-binding"]').waitFor({ timeout: 10_000 });
    return page;
  };
  const calls = (page, method, path) => page.evaluate(
    ([m, p]) => window.__feishu.calls.filter((call) => call.method === m && call.path === p),
    [method, path],
  );
  const chip = (page) => page.locator('[data-settings-anchor="feishu-connection"] .ui-status-chip');
  const waitChip = (page, text) => page.waitForFunction(
    (wanted) => document.querySelector('[data-settings-anchor="feishu-connection"] .ui-status-chip')?.textContent === wanted,
    text, { timeout: 6000 },
  );

  // ① 未配置 → 保存凭证 → 连上
  {
    const page = await open("scenario=unconfigured");
    assert.equal(await chip(page).textContent(), "未配置");
    assert.equal(await page.locator(".feishu-guide").evaluate((node) => node.open), true, "没连上时开通顺序应默认展开");
    await page.getByText("im:message.p2p_msg:readonly", { exact: true }).waitFor();
    const secret = page.getByLabel("App Secret", { exact: true });
    assert.equal(await secret.getAttribute("type"), "password");
    assert.equal(await secret.getAttribute("autocomplete"), "new-password");
    assert.equal(await page.getByText("已配置（不回显）").count(), 0);
    const save = page.getByRole("button", { name: "保存凭证", exact: true });
    assert.equal(await save.isDisabled(), true, "什么都没填时保存按钮应灰着");
    await page.getByLabel("App ID", { exact: true }).fill("cli_new_app");
    assert.equal(await save.isDisabled(), true, "第一次配置没填 Secret 时不该能保存");
    await secret.fill("s3cret-value");
    await save.click();
    await waitChip(page, "已连接");
    const [put] = await calls(page, "PUT", "/api/im/feishu/credentials");
    assert.deepEqual(put.body, { appId: "cli_new_app", domain: "feishu", appSecret: "s3cret-value" });
    assert.equal(put.token, "tok-0", "保存凭证要带页面凭据");
    await page.getByText("已配置（不回显）", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("App Secret", { exact: true }).count(), 0, "保存后 Secret 应收起，不再摆一个空密码框");

    // 绑定按钮在未绑定态出现；第二个真人动作用的是上一个响应轮换下来的凭据。
    await page.getByText("还没绑定飞书", { exact: true }).waitFor();
    await page.getByRole("button", { name: "绑定飞书", exact: true }).click();
    await page.getByLabel("绑定码", { exact: true }).waitFor();
    const [code] = await calls(page, "POST", "/api/im/feishu/binding/code");
    assert.equal(code.token, "tok-1");
    await page.close();
  }

  // ② 已连接：额度与水位 ③ 绑定状态机 ⑤ 清除凭证
  {
    const page = await open("scenario=connected");
    assert.equal(await chip(page).textContent(), "已连接");
    assert.equal(await page.locator(".feishu-guide").evaluate((node) => node.open), false, "连上之后开通顺序应默认收起");
    const figure = await page.locator(".feishu-usage-figure").textContent();
    assert.match(figure, /7,400\s*\/\s*10,000/);
    assert.match(figure, /74%/);
    assert.match(await page.locator(".feishu-levels .is-current").textContent(), /省着用/);
    assert.equal(await page.locator(".feishu-levels > div").count(), 4, "四档水位都要列出来");
    const kindRow = page.getByRole("row", { name: /发消息 \/ 发卡片/ });
    assert.equal(await kindRow.isVisible(), false, "按种类明细默认收起");
    await page.getByText("按调用种类看明细", { exact: true }).click();
    await kindRow.waitFor();
    assert.match(await kindRow.textContent(), /5,200/);
    await page.getByText("待发 2 条 · 已放弃 1 条").waitFor();
    await page.getByText("已配置（不回显）", { exact: true }).waitFor();

    // none → code：明文码 + 复制 + 倒计时
    await page.getByRole("button", { name: "绑定飞书", exact: true }).click();
    const shown = page.getByLabel("绑定码", { exact: true });
    await shown.waitFor();
    assert.equal(await shown.textContent(), "K7Q2-9XM1");
    await page.getByText(/^\d\d:\d\d 后过期$/).waitFor();
    assert.equal(await page.getByRole("button", { name: "复制", exact: true }).count(), 1);
    const [code] = await calls(page, "POST", "/api/im/feishu/binding/code");
    assert.equal(code.token, "tok-0");

    // code → pending：飞书那头有人发来了码，轮询（有码时两秒一次）把它带上来
    await page.evaluate(() => window.__feishu.claim("a1b2c3"));
    const question = page.getByText(/飞书用户 …a1b2c3 在 .+ 发来了这串码，是你吗？/);
    await question.waitFor({ timeout: 5000 });
    assert.equal(await page.getByLabel("绑定码", { exact: true }).count(), 0);

    // pending → bound，且确认之前发出的轮询晚回不许把界面拽回「待确认」
    await page.evaluate(() => { window.__feishu.bindingDelay = 1500; });
    await page.waitForFunction(() => window.__feishu.bindingInFlight > 0, undefined, { timeout: 5000 });
    await page.getByRole("button", { name: "确认绑定", exact: true }).click();
    await page.getByText("已绑定飞书用户 …a1b2c3", { exact: true }).waitFor();
    await page.waitForFunction(() => window.__feishu.bindingInFlight === 0, undefined, { timeout: 5000 });
    await page.waitForTimeout(150);
    assert.equal(await question.count(), 0, "确认前发出的那次轮询晚回，把界面拽回了「待确认」");
    await page.getByText("已绑定飞书用户 …a1b2c3", { exact: true }).waitFor();
    await page.evaluate(() => { window.__feishu.bindingDelay = 0; });
    const [accept] = await calls(page, "POST", "/api/im/feishu/binding/confirm");
    assert.deepEqual(accept.body, { codeId: "code-1" });
    assert.equal(accept.token, "tok-1", "确认绑定要带页面凭据");
    await page.getByRole("button", { name: "发一张测试卡", exact: true }).waitFor();
    assert.equal(await selectTrigger(page, "飞书里的当前项目").count(), 0, "飞书里不固定一个当前项目（建任务时在表单上选）");

    // 清除凭证：先开框，取消不发请求，确认才发
    await page.getByRole("button", { name: "清除", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "清除飞书凭证" });
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /清除后机器人立刻下线，已发出的卡片按钮全部失效/);
    assert.equal((await calls(page, "DELETE", "/api/im/feishu/credentials")).length, 0, "只开了确认框就发了 DELETE");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal((await calls(page, "DELETE", "/api/im/feishu/credentials")).length, 0, "取消之后不该发 DELETE");
    await page.getByRole("button", { name: "清除", exact: true }).click();
    await dialog.getByRole("button", { name: "清除凭证", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await waitChip(page, "未配置");
    const deletes = await calls(page, "DELETE", "/api/im/feishu/credentials");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].token, "tok-2", "清除凭证要带页面凭据");
    await page.getByLabel("App Secret", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("操作反馈").textContent(), "飞书凭证已清除，机器人已下线");
    await page.close();
  }

  // ④ 刷新前生成过码：明文拿不回来，只能重新生成
  {
    const page = await open("scenario=connected&binding=code");
    await page.getByText(/^有一个未用的码，\d+ 分钟后过期$/).waitFor();
    assert.equal(await page.getByLabel("绑定码", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "重新生成", exact: true }).click();
    await page.getByLabel("绑定码", { exact: true }).waitFor();
    await page.close();
  }

  // ⑥ 群绑定
  {
    const page = await open("scenario=connected&groups=demo");
    const groups = page.locator('[data-settings-anchor="feishu-groups"]');
    await groups.getByText("ash 开发群", { exact: true }).waitFor();
    assert.equal(await selectedValue(selectTrigger(groups, "ash 开发群 绑定的项目")), "p-ash");
    await groups.getByText(/群「日报群」在 .+ 发来了绑定码，要把它绑到项目「daily-report」吗？/).waitFor();
    await groups.getByRole("button", { name: "确认绑定群", exact: true }).click();
    await groups.getByText("日报群", { exact: true }).waitFor();
    const [accept] = await calls(page, "POST", "/api/im/feishu/groups/confirm");
    assert.deepEqual(accept.body, { codeId: "gcode-1" });
    assert.equal(accept.token, "tok-0", "确认绑定群要带页面凭据");

    await chooseOption(selectTrigger(groups, "要绑群的项目"), "p-daily");
    await groups.getByRole("button", { name: "生成群绑定码", exact: true }).click();
    await groups.getByLabel("群绑定码", { exact: true }).waitFor();
    const [code] = await calls(page, "POST", "/api/im/feishu/groups/code");
    assert.deepEqual(code.body, { projectId: "p-daily" });
    assert.equal(code.token, "tok-1");

    await groups.getByRole("switch", { name: "卡片发单聊" }).first().click();
    await groups.getByRole("switch", { name: "卡片发到群里" }).first().waitFor();
    const [patch] = await calls(page, "PATCH", "/api/im/feishu/groups/oc_team");
    assert.deepEqual(patch.body, { pushCards: true });

    await groups.getByRole("button", { name: "解绑", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "解绑飞书群" });
    await dialog.waitFor();
    assert.equal((await calls(page, "DELETE", "/api/im/feishu/groups/oc_team")).length, 0);
    await dialog.getByRole("button", { name: "解绑", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await groups.getByText("ash 开发群", { exact: true }).waitFor({ state: "detached" });
    await page.close();
  }

  assert.deepEqual(errors, []);
  console.log("feishu settings: unconfigured → save → connected, quota levels, binding none→code→pending→bound (stale poll dropped), refresh-lost code, clear via confirm dialog, group claim/confirm/code/unbind verified");
} finally {
  await browser?.close();
  await web.close();
}
