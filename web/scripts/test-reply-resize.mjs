// 对话框顶边的拖动条:往上拖变高、往下拖变矮、双击复位、上下限收住、刷新后还在;
// 拖出来的只是下限,拖过之后输入更多照样长高、删掉又缩回拖出来的高度。
// 普通任务回复框和团队调度台回复框是同一套交互、各记各的高度,所以两种变体都验一遍。
// 跑法:npm -w web run test:reply-resize
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { settlePage } from "./wait-until.mjs";

const web = await startWebServer();

// 与 src/task-detail/ReplyResizeHandle.tsx 里两套 pin 的 minHeight 对齐。
const VARIANTS = [
  { name: "单任务", query: "", minHeight: 58 },
  { name: "团队调度台", query: "?variant=team", minHeight: 44 },
];

let browser;
try {
  const base = `${web.origin}/scripts/fixtures/reply-resize.html`;

  browser = await launchChrome();

  for (const variant of VARIANTS) {
    // 每个变体一个干净上下文:两边各记各的高度,不许互相看见对方拖出来的值。
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}${variant.query}`);

    const label = variant.name;
    const handle = page.locator(".task-reply-resize");
    const field = page.getByTestId("field");
    await handle.waitFor();

    const fieldHeight = () => field.evaluate((el) => el.getBoundingClientRect().height);

    // 拖之前是 rows 撑出来的自然高度,不该被写死的默认值顶掉。
    assert.equal(await page.getByTestId("state").textContent(), "auto", `${label}：初始应是自动撑高`);
    const natural = await fieldHeight();

    // 原生右下角把手必须关着:两套机制都往 style.height 上写会打架。
    assert.equal(
      await field.evaluate((el) => window.getComputedStyle(el).resize),
      "none",
      `${label}：原生 resize 把手应当关闭`,
    );

    // 没拖过时高度跟着输入的行数走,撑到上限为止(再多就在框内滚)。
    // 高度由 useAutoGrowTextarea 在 layout effect 里写：fill 返回时 input 事件已经派发完，
    // 冲刷一轮让这次提交（连同它的 layout effect）落地，量到的就是这一版的高度。
    const fill = async (lines) => {
      await field.fill(Array.from({ length: lines }, (_, index) => `第 ${index + 1} 行`).join("\n"));
      await settlePage(page);
      return fieldHeight();
    };
    const fiveLines = await fill(5);
    assert.ok(fiveLines > natural, `${label}：5 行应比初始更高：${natural} → ${fiveLines}`);
    const autoCap = await fill(12);
    assert.ok(autoCap > fiveLines, `${label}：12 行应继续长高：${fiveLines} → ${autoCap}`);
    const overflowed = await fill(40);
    assert.ok(Math.abs(overflowed - autoCap) < 2, `${label}：超过上限不该再长高：${autoCap} → ${overflowed}`);
    assert.ok(
      await field.evaluate((el) => el.scrollHeight > el.clientHeight + 1),
      `${label}：撑到上限之后内容应当在框内滚动`,
    );
    assert.ok(Math.abs((await fill(1)) - natural) < 2, `${label}：内容变少要能缩回自然高度`);
    await field.fill("");
    await settlePage(page);

    // 往上拖 80px:回复框跟着高 80px。
    const drag = async (dy) => {
      const box = await handle.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - dy, { steps: 6 });
      await page.mouse.up();
    };

    await drag(80);
    const taller = await fieldHeight();
    assert.ok(
      Math.abs(taller - (natural + 80)) < 2,
      `${label}：往上拖 80 应长高 80：${natural} → ${taller}`,
    );

    // 往下拖回去。
    await drag(-50);
    const shorter = await fieldHeight();
    assert.ok(Math.abs(shorter - (taller - 50)) < 2, `${label}：往下拖 50 应变矮 50：${taller} → ${shorter}`);

    // 下限收住:一直往下拖不会拖没,也不会变负。
    await drag(-4000);
    const floored = await fieldHeight();
    assert.ok(
      floored >= variant.minHeight - 1 && floored < variant.minHeight + 22,
      `${label}：下限应收在 ${variant.minHeight} 附近，实际 ${floored}`,
    );

    // 上限收住:给上面的会话留地方,不许拖满整屏。
    await drag(4000);
    const ceiling = await fieldHeight();
    assert.ok(ceiling <= 900 - 260 + 2, `${label}：上限应给会话留出空间，实际 ${ceiling}`);

    // 自动撑高那个上限只管自动撑高:拖能拖到比它高得多,内容再多也停在拖出来的高度、在框内滚。
    assert.ok(ceiling > autoCap, `${label}：手动拖动应能超过自动撑高的上限：自动 ${autoCap} / 拖到 ${ceiling}`);
    assert.ok(Math.abs((await fill(40)) - ceiling) < 2, `${label}：拖得比自动上限高时，输入不该再改动高度`);
    // 「清空也不该缩回去」：清空那次提交落地之后（layout effect 已经跑过）再量。
    await field.fill("");
    await settlePage(page);
    assert.ok(Math.abs((await fieldHeight()) - ceiling) < 2, `${label}：拖过之后清空也不该缩回去`);

    // 拖出来的只是下限:拖到自然高度之上一点,输入多了照样长到自动上限,删少了缩回拖出来的高度。
    // 这条护的是「拖过一次(哪怕无意的几像素)就让所有框从此不再长高」——拖动高度是跨任务记着的。
    await handle.dblclick();
    await drag(20);
    const dragged = await fieldHeight();
    assert.ok(dragged > natural + 10, `${label}：往上拖 20 应长高：${natural} → ${dragged}`);
    assert.ok(Math.abs((await fill(12)) - autoCap) < 2, `${label}：拖过之后 12 行仍应长到自动上限 ${autoCap}`);
    assert.ok(Math.abs((await fill(40)) - autoCap) < 2, `${label}：拖过之后超过自动上限也不该再长`);
    assert.ok(Math.abs((await fill(1)) - dragged) < 2, `${label}：内容变少应缩回拖出来的高度 ${dragged}`);
    await field.fill("");
    await settlePage(page);

    // 刷新后高度还在。
    const kept = await page.getByTestId("state").textContent();
    await page.reload();
    await handle.waitFor();
    assert.equal(await page.getByTestId("state").textContent(), kept, `${label}：刷新后应记住拖过的高度`);

    // 双击复位,并且复位状态也要落盘 —— 否则刷新又跳回拖过的高度。
    await handle.dblclick();
    assert.equal(await page.getByTestId("state").textContent(), "auto", `${label}：双击应复位`);
    await page.reload();
    await handle.waitFor();
    assert.equal(await page.getByTestId("state").textContent(), "auto", `${label}：复位后刷新不该退回旧高度`);
    assert.ok(Math.abs((await fieldHeight()) - natural) < 2, `${label}：复位后应回到自然高度`);

    await context.close();
    console.log(`reply resize test passed (${label})`);
  }

  console.log("reply resize test passed");
} finally {
  await browser?.close();
  await web.close();
}
