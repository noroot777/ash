import assert from "node:assert/strict";

const navigationKeys = ["ArrowDown", "ArrowUp", "j", "k", "f", "\\", "c", "r", "g", "t"];
const shortcutActions = (page) => page.evaluate(() => window.workspaceShortcutActions);

async function assertPreviewRetained(page, context) {
  assert.equal(await page.locator(".preview-workspace").count(), 1, `${context}: shortcuts cannot unmount the preview`);
  assert.equal(await page.locator("#workspace-selected-task").textContent(), "fixture", `${context}: the task stays selected`);
  assert.deepEqual(await shortcutActions(page), [], `${context}: no background workspace action runs`);
}

export async function checkExpandedPreviewShortcuts(page) {
  // The opener remains outside the overlay, as it can in TaskDetail after opening a preview.
  await page.locator("#preview-external-opener").focus();
  for (const key of [...navigationKeys, "Control+k", "Meta+k"]) {
    await page.keyboard.press(key);
    await assertPreviewRetained(page, `expanded preview, external focus, ${key}`);
  }
}

export async function checkPreviewControlShortcuts(page, draft) {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const iframe = await page.locator('iframe[title="任务页面预览"]').elementHandle();
  const items = (await draft()).items;
  await checkExpandedPreviewShortcuts(page);
  await button("展开标注工具").click();
  for (const expanded of [true, false]) {
    if (!expanded) await button("还原预览").click();
    for (const [name, selector] of [
      ["移动预览操作栏（拖动或方向键）", ".preview-workspace-header"],
      ["移动标注工具（拖动或方向键）", ".preview-workspace-controls"],
    ]) {
      const panel = page.locator(selector), handle = button(name);
      const bounds = await page.locator(".preview-workspace").boundingBox();
      const movePanel = async (left, top) => {
        const box = await panel.boundingBox(), grip = await handle.boundingBox();
        const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x + left - box.x, y + top - box.y, { steps: 5 });
        await page.mouse.up();
      };
      // Center each panel within its current bounds so all four directions can move.
      const box = await panel.boundingBox();
      await movePanel(bounds.x + (bounds.width - box.width) / 2, bounds.y + (bounds.height - box.height) / 2);
      for (const [key, dx, dy] of [
        ["ArrowDown", 0, 32], ["ArrowUp", 0, -32], ["ArrowLeft", -32, 0], ["ArrowRight", 32, 0],
        ["Shift+ArrowDown", 0, 8], ["Shift+ArrowUp", 0, -8],
      ]) {
        const before = await panel.boundingBox();
        await handle.press(key);
        await assertPreviewRetained(page, `${expanded ? "expanded" : "compact"} ${name}, ${key}`);
        const after = await panel.boundingBox();
        assert.equal(after.x, before.x + dx, `${name}: ${key} moves horizontally`);
        assert.equal(after.y, before.y + dy, `${name}: ${key} moves vertically`);
      }
      await movePanel(box.x, box.y);
    }
    await button("关闭预览工作区").focus();
    for (const key of navigationKeys) {
      await page.keyboard.press(key);
      await assertPreviewRetained(page, `${expanded ? "expanded" : "compact"} preview button, ${key}`);
    }
    assert(await iframe.evaluate((element) => element.isConnected), "keyboard movement retains the original iframe document");
    assert.deepEqual((await draft()).items, items, "keyboard movement retains every annotation and comment");
  }

  // Compact preview only owns keys from inside itself; task navigation remains available outside.
  await page.locator("#preview-external-opener").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator("#workspace-selected-task").textContent(), "next");
  assert.equal(await page.locator(".preview-workspace").count(), 0);
  for (const key of ["ArrowUp", "k", "j"]) await page.keyboard.press(key);
  assert.deepEqual(await shortcutActions(page), ["task:next", "task:fixture", "task:previous", "task:fixture"]);
  await page.evaluate(() => { window.workspaceShortcutActions = []; });
  await button("打开预览工作区").click();
  await button("还原预览").waitFor();
  await button("关闭预览工作区").click();
  await page.locator("#preview-external-opener").focus();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp");
  assert.deepEqual(await shortcutActions(page), ["task:next", "task:fixture"], "closing expanded preview restores workspace navigation");
  await page.evaluate(() => { window.workspaceShortcutActions = []; });
  await button("打开预览工作区").click();
  await button("还原预览").waitFor();
  console.log("preview keyboard scope: real window-capture shortcuts, external focus, both handles in expanded/compact views, draft retention and navigation after closing passed");
}
