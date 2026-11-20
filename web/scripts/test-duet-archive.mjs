import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { settlePage } from "./wait-until.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async (query = "") => {
    await page.goto(`${web.origin}/scripts/fixtures/duet-archive.html${query}`);
    await page.locator(".duet-control-shell, .duet-terminal-handoff").waitFor({ timeout: 10_000 }).catch((error) => {
      throw new Error(`${error.message}\n${errors.join("\n")}`);
    });
    await settlePage(page);
  };
  const toggle = () => page.getByRole("button", { name: "切换归档", exact: true }).dispatchEvent("click");
  const countPosts = async () => Number(await page.getByTestId("mutations").innerText());
  const frozenGate = async () => {
    await page.getByText("已归档，取消归档后再裁决", { exact: true }).waitFor();
    for (const name of ["交给任务", "放行结束", "打回终止", "注入意见", "提问继续"]) {
      assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, `${name} is absent while archived`);
    }
    assert.equal(await page.locator(".duet-gate-composer, .duet-gate-uploads, .duet-handoff-modal").count(), 0);
    assert.match(await page.locator(".duet-gate-conclusions").innerText(), /共用冻结门禁/);
  };
  await open();
  await frozenGate();
  await page.keyboard.press("Control+Enter");
  assert.equal(await countPosts(), 0, "archived initial load cannot send gate, create or launch requests");
  await page.reload();
  await frozenGate();
  await toggle();
  for (const name of ["交给任务", "放行结束", "打回终止", "注入意见", "提问继续"]) {
    assert.equal(await page.getByRole("button", { name, exact: true }).isEnabled(), true, `${name} restores after unarchive`);
  }
  await page.getByRole("button", { name: "注入意见", exact: true }).click();
  await page.locator(".duet-gate-composer textarea").fill("保留这段尚未发送的意见");
  await toggle();
  await frozenGate();
  await page.keyboard.press("Control+Enter");
  assert.equal(await countPosts(), 0, "archiving an open editor prevents keyboard submission");
  await toggle();
  assert.equal(await page.locator(".duet-gate-composer textarea").inputValue(), "保留这段尚未发送的意见");
  await page.getByRole("button", { name: "提交并继续", exact: true }).click();
  await page.locator(".duet-gate-composer").waitFor({ state: "detached" });
  assert.equal(await countPosts(), 1, "restored inject reaches the gate exactly once");
  await page.getByRole("button", { name: "提问继续", exact: true }).click();
  await page.locator(".duet-gate-composer textarea").fill("需要确认什么？");
  await toggle();
  await frozenGate();
  await toggle();
  await page.getByRole("button", { name: "提交并继续", exact: true }).click();
  await page.locator(".duet-gate-composer").waitFor({ state: "detached" });
  assert.equal(await countPosts(), 2, "restored ask reaches the gate");
  await page.getByRole("button", { name: "交给任务", exact: true }).click();
  await page.getByRole("dialog", { name: "交给任务落实" }).waitFor();
  await toggle();
  await frozenGate();
  assert.equal(await countPosts(), 2, "an open handoff modal freezes without task creation or launch");
  await toggle();
  for (const name of ["放行结束", "打回终止"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await settlePage(page);
  }
  assert.equal(await countPosts(), 4, "approve and reject work after unarchive");
  for (const width of [1000, 420, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await open();
    await frozenGate();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px archived gate fits`);
  }
  await page.setViewportSize({ width: 1000, height: 900 });
  await open("?linked=1");
  await frozenGate();
  await page.getByRole("button", { name: /已经派出的落实任务/ }).click();
  assert.match(await page.getByTestId("notice").innerText(), /打开：已经派出的落实任务/);
  assert.equal(await countPosts(), 0, "linked tasks remain navigable without mutation");
  for (const status of ["done", "failed", "canceled"]) {
    await open(`?status=${status}`);
    assert.equal(await page.locator(".duet-terminal-handoff .duet-new-team").count(), 0, `${status}: archived terminal handoff is frozen`);
    assert.equal(await page.locator(".duet-terminal-handoff .acc-bar .acc-btn:enabled").count(), 0);
    assert.equal(await countPosts(), 0);
    await toggle();
    assert.equal(await page.getByRole("button", { name: "交给任务", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "打回再讨论", exact: true }).click();
    await page.getByRole("textbox", { name: "打回意见" }).fill("尚未发送的打回意见");
    await toggle();
    assert.equal(await page.getByRole("textbox", { name: "打回意见" }).count(), 0, "an already-open return editor freezes too");
    await page.keyboard.press("Control+Enter");
    assert.equal(await countPosts(), 0);
  }
  assert.deepEqual(errors, [], "real duet hosts render without runtime errors");
  console.log("duet archive DOM: five decisions, drafts, open modals, terminal handoff, acceptance and narrow layouts passed");
} finally {
  await browser?.close();
  await web.close();
}
