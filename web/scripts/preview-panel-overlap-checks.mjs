import assert from "node:assert/strict";
import { join } from "node:path";

export async function checkPreviewPanelOverlap(page, draft) {
  const button = name => page.getByRole("button", { name, exact: true });
  const header = page.locator(".preview-workspace-header"), controls = page.locator(".preview-workspace-controls");
  const iframe = await page.locator('iframe[title="任务页面预览"]').elementHandle();
  const items = (await draft()).items;
  await button("收起意见栏").click();
  const drag = async (panel, name, horizontal, vertical) => {
    const bounds = await page.locator(".preview-workspace").boundingBox();
    const box = await panel.boundingBox(), grip = await button(name).boundingBox();
    const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + bounds.x + (bounds.width - box.width) * horizontal - box.x,
      y + bounds.y + (bounds.height - box.height) * vertical - box.y, { steps: 8 });
    await page.mouse.up();
  };
  const accessible = async (context) => {
    // Allow resize observers to finish positioning, then hit-test the actual buttons.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const name of ["关闭预览工作区", "移动预览操作栏（拖动或方向键）", "移动标注工具（拖动或方向键）",
      await button("还原预览").count() ? "还原预览" : "放大预览",
      await button("收起标注工具").count() ? "收起标注工具" : "展开标注工具"]) {
      assert(await button(name).evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), `${context}: ${name} stays visible and clickable`);
    }
    const a = await header.boundingBox(), b = await controls.boundingBox();
    assert(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
      `${context}: panels do not cover each other`);
    assert(await iframe.evaluate(element => element.isConnected), "positioning keeps the original iframe");
    assert.deepEqual((await draft()).items, items, "positioning preserves annotations");
  };
  const headerGrip = "移动预览操作栏（拖动或方向键）", toolsGrip = "移动标注工具（拖动或方向键）";
  await drag(controls, toolsGrip, 1, 1);
  await drag(header, headerGrip, .7, 1);
  await accessible("dragging the header onto the tools");
  if (process.env.PREVIEW_WORKSPACE_SCREENSHOTS) await page.screenshot({ path: join(process.env.PREVIEW_WORKSPACE_SCREENSHOTS, "overlap-expanded.png") });
  await drag(header, headerGrip, 0, 1);
  await accessible("panels in opposite bottom corners");
  await button("还原预览").click();
  await accessible("restoring to compact view clamps both panels");
  if (process.env.PREVIEW_WORKSPACE_SCREENSHOTS) await page.screenshot({ path: join(process.env.PREVIEW_WORKSPACE_SCREENSHOTS, "overlap-compact.png") });
  await button("收起标注工具").click();
  await accessible("collapsing tools");
  await button("展开标注工具").click();
  await accessible("expanding tools");
  await button("放大预览").click();
  await drag(controls, toolsGrip, 0, 1);
  await accessible("dragging tools onto the header");
  for (let i = 0; i < 6; i++) await button(headerGrip).press("ArrowDown");
  await accessible("keyboard movement into the other panel");
  await button("展开意见栏").click();
  await accessible("revealing notes");
  await page.setViewportSize({ width: 760, height: 500 });
  await accessible("narrow viewport");
  await page.setViewportSize({ width: 1400, height: 900 });
  await accessible("restoring desktop viewport");
  await button("关闭预览工作区").click();
  assert.equal(await page.locator(".preview-workspace").count(), 0, "the close button remains operable after moving and resizing");
  await button("打开预览工作区").click();
  await page.waitForFunction(() => document.querySelector('.preview-workspace-modes button')?.disabled === false);
  console.log("floating panel overlap: drag in both directions, compact clamp, tool expansion, keyboard collision, notes, viewport resize and closing passed");
}
