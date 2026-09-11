import assert from "node:assert/strict";

const editorText = async (editor) => editor.locator(".cm-line").evaluateAll((lines) => lines.map((line) => line.querySelector(".cm-placeholder") ? "" : line.textContent).join("\n"));
const waitForText = (page, expected) => page.waitForFunction((text) =>
  [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')].map((line) => line.querySelector(".cm-placeholder") ? "" : line.textContent).join("\n") === text, expected);

export async function testPreviewCommandEditor(page, editor, save) {
  const container = page.locator(".preview-command-editor").first();
  const wrap = page.getByRole("checkbox", { name: "启动脚本 自动换行" });
  assert.equal(await wrap.isChecked(), false, "默认沿用不换行的命令显示方式");
  await wrap.check();
  assert.equal(await save.isDisabled(), true, "只切换换行不应产生待保存的项目改动");
  await wrap.uncheck();

  const script = '# 预览服务\nif [ -n "$PORT" ]; then\n  npm run dev -- --port "$PORT"\nfi';
  await editor.fill(script);
  await waitForText(page, script);
  assert.deepEqual(await container.locator(".cm-lineNumbers .cm-gutterElement").evaluateAll((numbers) =>
    numbers.filter((number) => getComputedStyle(number).visibility !== "hidden").map((number) => number.textContent)), ["1", "2", "3", "4"]);
  const colors = await editor.locator(".cm-line span").evaluateAll((tokens) => [...new Set(tokens.map((token) => getComputedStyle(token).color))]);
  assert.ok(colors.length >= 3, "命令、变量、注释应显示不同高亮颜色");

  await editor.fill("echo ready");
  await editor.press("ControlOrMeta+Home");
  await editor.press("Tab");
  await waitForText(page, "  echo ready");
  await editor.press("Shift+Tab");
  await waitForText(page, "echo ready");
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await page.keyboard.insertText("echo next");
  await waitForText(page, "echo ready\necho next");
  await editor.press("ControlOrMeta+z");
  assert.notEqual(await editorText(editor), "echo ready\necho next", "撤销应恢复之前的文本");
  await editor.press("ControlOrMeta+Shift+z");
  await waitForText(page, "echo ready\necho next");

  await editor.press("ControlOrMeta+Home");
  await editor.press("Shift+ArrowRight");
  await editor.press("Shift+ArrowRight");
  await wrap.check();
  await editor.focus();
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "ec", "切换换行应保留选区");
  await editor.press("ControlOrMeta+z");
  assert.notEqual(await editorText(editor), "echo ready\necho next", "切换换行后撤销历史应仍然可用");
  await editor.press("Escape");
  await editor.press("Tab");
  assert.equal(await editor.evaluate((node) => node.contains(document.activeElement)), false, "键盘应能移出编辑器");

  const long = `echo "${"a-long-command-".repeat(35)}"\necho 完成`;
  await editor.fill(long);
  await waitForText(page, long);
  await page.setViewportSize({ width: 390, height: 740 });
  await container.scrollIntoViewIfNeeded();
  const scroller = container.locator(".cm-scroller");
  await page.waitForFunction(() => {
    const scroller = document.querySelector(".preview-command-editor .cm-scroller");
    return scroller && scroller.scrollWidth <= scroller.clientWidth + 1;
  });
  const wrappedHeight = await editor.locator(".cm-line").first().evaluate((line) => line.getBoundingClientRect().height);
  assert.ok(wrappedHeight > 21, "长命令应在编辑器宽度内软换行");
  assert.equal(await editorText(editor), long, "软换行不能插入实际换行符");
  if (process.env.PREVIEW_EDITOR_NARROW_SHOT) await container.screenshot({ path: process.env.PREVIEW_EDITOR_NARROW_SHOT });
  await wrap.uncheck();
  await page.waitForFunction(() => {
    const scroller = document.querySelector(".preview-command-editor .cm-scroller");
    return scroller && scroller.scrollWidth > scroller.clientWidth;
  });
  assert.ok(await scroller.evaluate((node) => node.scrollWidth > node.clientWidth), "不换行时应在编辑器内横向滚动");
  const box = await container.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, "长命令不能撑出窄屏");
  assert.equal(await editorText(editor), long);
  await page.setViewportSize({ width: 1000, height: 1200 });
  await editor.fill(script);
  if (process.env.PREVIEW_EDITOR_SHOT) await container.screenshot({ path: process.env.PREVIEW_EDITOR_SHOT });

  await editor.fill("x".repeat(16_000));
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("x");
  await container.getByRole("alert").waitFor();
  await save.click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="stored-projects"]').textContent)["p-one"].previewCommand?.length === 16_000);
  assert.equal(JSON.parse(await page.getByTestId("stored-projects").textContent())["p-one"].previewCommand, "x".repeat(16_000), "长脚本应完整保存，键盘输入不能绕过长度限制");
  await editor.fill("echo intact");
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("y".repeat(16_001));
  await container.getByRole("alert").waitFor();
  assert.equal(await editorText(editor), "echo intact", "超长粘贴不能破坏现有脚本");
  await editor.fill("");
  await waitForText(page, "");
  assert.equal(await container.getByRole("alert").count(), 0);
}
