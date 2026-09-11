import assert from "node:assert/strict";

export async function checkFloatingPreview(page, frame, draft) {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const controls = page.locator(".preview-workspace-controls");
  const notes = page.locator(".preview-workspace-notes");
  const iframe = page.locator('iframe[title="任务页面预览"]');
  await button("放大预览").click();
  const canvas = await iframe.boundingBox();
  assert(await page.evaluate(() => {
    const notes = document.querySelector('.preview-workspace-notes');
    return !!(notes.compareDocumentPosition(document.querySelector('.preview-workspace-controls')) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), "notes precede the bottom toolbar in keyboard order");
  assert((await notes.boundingBox()).y < (await controls.boundingBox()).y);
  const waitIdle = () => page.waitForFunction(() => !document.querySelector('.preview-workspace.is-drawing'));
  const draw = async (start, end) => {
    await page.locator('.preview-workspace-connection').waitFor({ state: 'hidden' });
    const before = (await draft()).items.length;
    console.log(`drawing annotation ${before + 1}: ${JSON.stringify(start)} -> ${JSON.stringify(end)}`);
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.locator('.preview-workspace.is-drawing').waitFor();
    await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up();
    await waitIdle();
    await page.waitForFunction((count) => document.querySelectorAll('.preview-workspace-list-row').length === count, before + 1);
    const item = (await draft()).items.at(-1);
    assert.deepEqual(item.points[0], start, "each stroke retains its own start");
    assert.deepEqual(item.points.at(-1), end, "release over an overlay completes the stroke at the release point");
  };
  for (const [index, tool] of ["矩形", "画笔"].entries()) {
    const offset = index * 70;
    await button(tool).click();
    const box = await controls.boundingBox();
    await draw({ x: 700, y: 600 + offset }, { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 25) });
    await draw({ x: 500 + offset, y: 300 + offset }, { x: 640 + offset, y: 440 + offset });
    const side = await notes.boundingBox();
    await draw({ x: 800, y: 500 + offset }, { x: Math.round(side.x + 20), y: Math.round(side.y + 80) });
    const top = await page.locator('.preview-workspace-header').boundingBox();
    await draw({ x: 900, y: 400 + offset }, { x: Math.round(top.x + 20), y: Math.round(top.y + 20) });
  }
  await button("矩形").click();
  await page.locator('.preview-workspace-connection').waitFor({ state: 'hidden' });
  for (const [index, reason] of ["lostpointercapture", "pointercancel", "blur"].entries()) {
    if (reason === 'blur') await button('收起标注工具').click();
    const before = (await draft()).items.length;
    await page.mouse.move(450, 350); await page.mouse.down();
    await page.locator('.preview-workspace.is-drawing').waitFor();
    await page.mouse.move(460, 360);
    await frame.evaluate((reason) => {
      if (reason === 'lostpointercapture') window.annotationShadow.host.releasePointerCapture(window.capturedPointerId);
      else if (reason === 'pointercancel') window.dispatchEvent(new PointerEvent(reason, { pointerId: window.capturedPointerId }));
      else window.dispatchEvent(new Event('blur'));
    }, reason);
    await page.mouse.move(470, 370); await page.mouse.up(); await waitIdle();
    assert.equal((await draft()).items.length, before, `${reason} cancels the unfinished annotation`);
    console.log('interrupted gesture', reason, await page.locator('.preview-workspace-error').allTextContents());
    await page.getByRole('alert').filter({ hasText: '标注手势已中断' }).waitFor();
    if (reason === 'blur') await button('展开标注工具').click();
    await draw({ x: 300 + index * 50, y: 500 }, { x: 420 + index * 50, y: 550 });
  }
  const movePanel = async (name, dx, dy) => {
    const handle = button(name), box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
    await page.mouse.up();
  };
  const selectPageElement = async (selector) => {
    const element = frame.locator(selector), box = await element.boundingBox();
    assert(await page.evaluate(({ x, y, width, height }) => document.elementFromPoint(x + width / 2, y + height / 2)?.tagName === 'IFRAME', box), `${selector} is no longer covered by workspace controls`);
    // The runtime's annotation surface intentionally receives the page-element click.
    await element.click({ force: true });
  };
  await button('点选').click();
  const bottom = frame.locator('#fixed-bottom');
  const box = await bottom.boundingBox();
  assert(await page.evaluate(({ x, y, width, height }) => !!document.elementFromPoint(x + width / 2, y + height / 2)?.closest('.preview-workspace-controls'), box));
  await movePanel('移动标注工具（拖动或方向键）', 0, -250);
  assert.deepEqual(await iframe.boundingBox(), canvas, 'moving tools does not resize the preview');
  const before = (await draft()).items.length;
  await selectPageElement('#fixed-bottom');
  await page.waitForFunction((count) => document.querySelectorAll('.preview-workspace-list-row').length === count, before + 1);
  assert((await draft()).items.at(-1).element.selectors.includes('#fixed-bottom'), 'the previously covered fixed footer can be annotated');
  await movePanel('移动预览操作栏（拖动或方向键）', -600, 0);
  await selectPageElement('#fixed-top');
  await page.waitForFunction((count) => document.querySelectorAll('.preview-workspace-list-row').length === count, before + 2);
  assert((await draft()).items.at(-1).element.selectors.includes('#fixed-top'), 'the previously covered fixed header can be annotated');
  await selectPageElement('#bottom-edge');
  await page.waitForFunction((count) => document.querySelectorAll('.preview-workspace-list-row').length === count, before + 3);
  assert((await draft()).items.at(-1).element.selectors.includes('#bottom-edge'), 'the bottom edge has no opaque click-through strip');
  const header = page.locator('.preview-workspace-header');
  const prior = await header.boundingBox();
  await button('移动预览操作栏（拖动或方向键）').press('ArrowLeft');
  assert.equal((await header.boundingBox()).x, prior.x - 32, 'keyboard users can reposition overlays');
  await button('收起标注工具').click();
  assert.equal(await button('点选').isVisible(), false);
  await button('展开标注工具').click();
  assert.equal(await button('点选').isVisible(), true);
  console.log('floating preview: cross-overlay rectangle/pen gestures, interrupted gesture cleanup, fixed header/footer/edge annotation, keyboard order and movable/collapsible controls passed');
}

export async function previewClearRatio(page) {
  return page.evaluate(() => {
    let clear = 0, total = 0;
    for (let y = 10; y < innerHeight; y += 20) for (let x = 10; x < innerWidth; x += 20) {
      total++; if (document.elementFromPoint(x, y)?.tagName === 'IFRAME') clear++;
    }
    return clear / total;
  });
}
