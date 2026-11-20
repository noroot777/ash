import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "../../web/scripts/chrome-path.mjs";
import { startQuestionCardStage } from "./question-card-stage.mjs";

const stage = await startQuestionCardStage();
let browser;
try {
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => assert.equal(new URL(request.url()).origin, stage.origin, "隔离测试不能连接真实服务"));
  const card = page.getByTestId("question-card");
  const inputs = card.getByRole("textbox");
  const send = card.getByRole("button", { name: "发送答复", exact: true });
  const assertArchived = async (id) => {
    await card.getByText("已归档，取消归档后再答", { exact: true }).waitFor();
    assert.equal(await inputs.count(), 0, `${id}:归档没有输入`);
    assert.equal(await card.getByRole("button").count(), 0, `${id}:归档没有选项或发送按钮`);
    assert.equal(stage.answers.length, 0, `${id}:没有发出答复请求`);
  };
  for (const id of ["single", "multi", "team", "team-multi"]) {
    await page.goto(`${stage.origin}/mobile/app/task/${id}`);
    await assertArchived(id);
    const multi = id.includes("multi");
    await card.getByText(multi ? "保留第一题" : "保留问题", { exact: true }).waitFor();
    if (multi) await card.getByText("何时可以答复？", { exact: true }).waitFor();
    await page.reload();
    await assertArchived(`${id}/reload`);
    if (process.env.NAVI_MOBILE_SCREENSHOTS) {
      await mkdir(process.env.NAVI_MOBILE_SCREENSHOTS, { recursive: true });
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.NAVI_MOBILE_SCREENSHOTS}/${id}-archived.png` });
    }
    await page.getByRole("button", { name: "取消归档", exact: true }).click();
    await inputs.first().waitFor();
    assert.equal(await inputs.count(), multi ? 2 : 1, `${id}:取回恢复输入`);
    await inputs.first().fill("归档前写了一半");
    await page.request.post(`${stage.origin}/__fixture/tasks/${id}`, { data: { archived: true } });
    await assertArchived(`${id}/poll`);
    await page.getByRole("button", { name: "取消归档", exact: true }).click();
    await inputs.first().waitFor();
    assert.equal(await inputs.first().inputValue(), "归档前写了一半", `${id}:取回保留草稿`);
    await card.getByRole("button", { name: new RegExp(multi ? "保留第一题" : "保留问题") }).click();
    assert.match(await inputs.first().inputValue(), /归档前写了一半/);
    assert.match(await inputs.first().inputValue(), multi ? /保留第一题/ : /保留问题/);
  }
  await page.goto(`${stage.origin}/mobile/app/task/settling`);
  await inputs.waitFor();
  assert.equal(await inputs.isEditable(), false, "普通任务提问回合未结束时仍不能答复");
  assert.equal(await send.isDisabled(), true);
  await page.goto(`${stage.origin}/mobile/app/task/team-running`);
  await inputs.waitFor();
  assert.equal(await inputs.isEditable(), true, "团队调度者运行时仍能接收答复");
  await inputs.fill("正常答复");
  await send.click();
  await card.getByText("已发送，等待刷新", { exact: true }).waitFor();
  assert.deepEqual(stage.answers, [{ taskId: "team-running", answer: "正常答复" }]);
  assert.deepEqual(errors, []);
  console.log("✓ Expo 手机答题卡：普通/团队、单题/多题归档只读，刷新与轮询冻结、取回保留草稿，未归档答复不退化");
} finally {
  await browser?.close();
  await stage.close();
}
