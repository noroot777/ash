// J/K 必须按**屏幕上看得见的那份列表**走：顺序一致、一行不跳、看不见的行一个都不落上去。
// 钉住的是 src/workspace/sidebarNavigation.ts —— 从前这里走模型那份（spreadVisibleTasks），
// 跟屏幕隔着项目分组、年龄闸、分页展开、团队展开、分组折叠五层组件状态。
// 跑：npm -w web run test:sidebar-navigation
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/sidebar-navigation.html`);

  const selected = page.getByTestId("selected");
  await page.locator('.workspace-task-tree [data-task-id="a1"]').waitFor();

  // 屏幕上那份列表：DOM 文档顺序里每一行的任务 id，按人眼从上往下。
  const screenOrder = () => page.$$eval(
    ".workspace-task-tree [data-task-id]",
    (rows) => rows.filter((row) => row.offsetParent !== null).map((row) => row.dataset.taskId),
  );
  const modelOrder = async () => (await page.getByTestId("model-order").textContent()).split(" ").filter(Boolean);
  // 从头按一路 J，记下每一下的落点。
  const walk = async (steps, key = "j") => {
    const visited = [];
    for (let at = 0; at < steps; at += 1) {
      await page.keyboard.press(key);
      await page.waitForFunction(
        (previous) => document.querySelector('[data-testid="selected"]')?.textContent !== previous,
        visited.at(-1) ?? "",
        { timeout: 2_000 },
      ).catch(() => {});
      visited.push(await selected.textContent());
    }
    return visited;
  };
  // 回到「一行都没选」：没有选中时 J 落在列表第一行，于是 walk(n) 读出来的就是前 n 行。
  const reset = async () => {
    const clear = page.getByTestId("clear-selection");
    await clear.click();
    // 焦点留在按钮上不影响 window 捕获阶段的按键，但清掉更贴近真实（用户是在列表上按键）。
    await clear.evaluate((element) => element.blur());
    await page.waitForFunction(
      () => document.querySelector('[data-testid="selected"]')?.textContent === "",
      undefined,
      { timeout: 2_000 },
    );
  };

  // —— 一、单项目态：年龄闸折起来的旧行不进序列，团队执行者收着的时候也不进。
  // 「其他机器」那一节夹在置顶和「任务」之间（见 TaskTree 的渲染顺序），所以 gone 排第二 ——
  // 模型那份顺序里它根本不在这个位置，这正是两家必须分开算的地方。
  let screen = await screenOrder();
  assert.deepEqual(
    screen,
    ["pin", "gone", "a1", "a2", "team"],
    "屏幕上该有的行：置顶、「其他机器」那条、两条新任务、团队（执行者收着）",
  );
  assert.equal(screen.includes("old1"), false, "被年龄闸折起来的旧行不在屏幕上");

  assert.deepEqual(await walk(5), screen, "J 的落点序列必须逐行等于屏幕上那份顺序");
  assert.deepEqual(await walk(1), ["team"], "走到最后一行就停住，不绕回列表头");

  // 「其他机器」那一节的远端行也是人眼看得见的行：它在序列里（上面已经走到过），
  // 而且选中落在远端身份上之后 J/K 还认得「我在哪」—— 不能从头重新开始。
  await reset();
  assert.deepEqual(await walk(2), ["pin", "gone"], "第二下 J 落在「其他机器」那条上");
  assert.deepEqual(await walk(1, "k"), ["pin"], "从远端行按 K 应退回上一行，而不是跳回列表头");
  assert.deepEqual(await walk(1, "k"), ["pin"], "到顶就停住");

  // —— 二、团队行展开：底下那两个执行者当场进序列。
  await reset();
  await page.getByRole("button", { name: /展开 2 个执行者/ }).click();
  await page.locator('.workspace-task-tree [data-task-id="w1"]').waitFor();
  screen = await screenOrder();
  assert.deepEqual(screen, ["pin", "gone", "a1", "a2", "team", "w1", "w2"], "执行者行排在团队行底下");
  assert.deepEqual(await walk(7), screen, "展开后的执行者行必须跟着进 J 的序列");

  // 收起来就该再次跳过它们 —— 屏幕上没有的行一个都不能落上去。
  await reset();
  await page.getByRole("button", { name: "折叠执行者" }).click();
  await page.waitForSelector('.workspace-task-tree [data-task-id="w1"]', { state: "detached" });
  assert.deepEqual(await walk(5), ["pin", "gone", "a1", "a2", "team"], "执行者收起后 J 必须跳过它们");

  // —— 三、年龄闸：点开「展开(2/2)」放出来的旧行同样当场进序列。
  await reset();
  await page.locator(".workspace-task-more-row").getByRole("button", { name: /^展开\(/ }).click();
  await page.locator('.workspace-task-tree [data-task-id="old1"]').waitFor();
  screen = await screenOrder();
  assert.deepEqual(screen, ["pin", "gone", "a1", "a2", "team", "old1", "old2"], "展开出来的旧行接在后面");
  assert.deepEqual(await walk(7), screen, "年龄闸放出来的行必须跟着进序列");

  // —— 四、「其他项目」那一叠：展开后它的行也在屏幕上，也必须进序列。
  await reset();
  await page.getByRole("button", { name: "隔壁项目" }).click();
  await page.locator('.workspace-task-tree [data-task-id="b1"]').waitFor();
  screen = await screenOrder();
  assert.deepEqual(
    await walk(screen.length),
    screen,
    "「其他项目」展开后的行必须跟着进序列",
  );

  // —— 五、任务模式：「任务」那一节按项目再分一层，屏幕顺序与模型顺序**本来就不同**。
  // 这是「按 J 跳过几行」的来源，所以先断言两份顺序确实对不上，再断言 J 跟的是屏幕那份。
  await page.getByTestId("toggle-mode").click();
  await page.locator(".workspace-task-project-head").first().waitFor();
  screen = await screenOrder();
  const model = await modelOrder();
  // 比的是**同一批行的先后**，不是「两个数组不一样」：长度不同也能让 notDeepEqual 通过，
  // 那就测不出「分组把顺序换了」这件事。
  const modelSameRows = model.filter((id) => screen.includes(id));
  assert.deepEqual(modelSameRows.length, screen.length, "两份顺序装的是同一批行");
  assert.notDeepEqual(
    screen,
    modelSameRows,
    `同一批行的先后必须不同，否则这条用例测不出东西（屏幕 ${screen.join(",")} / 模型 ${modelSameRows.join(",")}）`,
  );
  await reset();
  assert.deepEqual(await walk(screen.length), screen, "任务模式下 J 必须跟屏幕那份顺序，不是模型那份");

  // 折叠一个项目分组：组里那些行当场从屏幕上消失，J 必须跳过整组。
  await reset();
  const groupHead = page.locator(".workspace-task-project-head").first();
  const groupName = (await groupHead.locator("b").textContent()).trim();
  await groupHead.click();
  await page.waitForTimeout(50);
  const folded = await screenOrder();
  assert.ok(folded.length < screen.length, `折叠「${groupName}」后屏幕上的行应变少`);
  assert.deepEqual(await walk(folded.length), folded, "折叠起来的项目分组必须整组跳过");

  // —— 六、侧栏收起：屏幕上没有这份列表了，J/K 退回模型顺序而不是哑掉。
  await page.getByTestId("toggle-mode").click();
  await page.getByTestId("toggle-sidebar").click();
  await page.waitForSelector(".workspace-task-tree", { state: "detached" });
  assert.deepEqual(await screenOrder(), [], "侧栏收起后屏幕上一行都没有");
  const fallback = await modelOrder();
  await page.keyboard.press("j");
  await page.waitForFunction(
    (want) => document.querySelector('[data-testid="selected"]')?.textContent === want,
    fallback[0],
    { timeout: 2_000 },
  ).catch(() => {});
  assert.equal(await selected.textContent(), fallback[0], "侧栏收起时 J 退回模型顺序的第一行");

  console.log("sidebar navigation tests passed");
} finally {
  await browser?.close();
  await server.close();
}
