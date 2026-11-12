export async function checkTaskCreationOrigin(page, fixtureUrl) {
  const ensure = (value, message) => { if (!value) throw new Error(message); };
  await page.goto(fixtureUrl);
  const row = title => page.locator(".workspace-task-row").filter({ hasText: title });
  const open = async title => {
    await row(title).waitFor({ state: "visible" });
    await row(title).click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
  };
  // 详情页头上不再挂徽标、也不再另起一条「来自…」：谁开的、从哪来收在标题前那一颗来源图标的
  // 读屏名和提示里（docs/ui-ux-audit head-2）。来源任务还在就能点过去。
  const source = () => page.locator(".task-detail-header .task-head-source");
  const sourceSaid = async () => (await source().count()) ? await source().first().getAttribute("aria-label") : null;
  const ensureNoStrayLines = async title => {
    ensure(await page.locator(".task-detail-header .task-creation-badge").count() === 0, `the head must not carry a text badge: ${title}`);
    ensure(await page.locator(".task-origin-bar").count() === 0, `the origin must not go back to its own line: ${title}`);
  };
  // 用户自己建的任务不标：那是绝大多数，标了等于没标。
  for (const title of ["用户新建"]) {
    await row(title).waitFor({ state: "visible" });
    ensure(await row(title).locator(".task-creation-badge").count() === 0, `user-created task must stay unlabeled: ${title}`);
    await open(title);
    ensure(await sourceSaid() === null, `user-created detail must stay unlabeled: ${title}`);
    await ensureNoStrayLines(title);
  }
  await open("用户从父任务派生");
  ensure(!(await sourceSaid() || "").includes("创建"), "a user-derived task shows only where it came from, never a creator");
  const cases = [["Codex 派生的任务", "Codex 派生", "Codex Dev"], ["外部智能体创建", "智能体创建（自报）", null],
    ["群聊委派的任务", "Codex 群聊委派", "聊天 Codex"]];
  for (const [title, label, executor] of cases) {
    await row(title).waitFor({ state: "visible" });
    ensure(await row(title).locator(".task-creation-badge").innerText() === label, `wrong list origin: ${title}`);
    await open(title);
    const said = await sourceSaid() || "";
    ensure(said.includes(label), `wrong detail origin: ${title} → ${said}`);
    if (executor) ensure(said.includes(executor), `creator executor snapshot is missing: ${title} → ${said}`);
    await ensureNoStrayLines(title);
  }
  await page.locator('.workspace-task-row[data-task-id="source-agent"]').click();
  await page.getByRole("heading", { name: "父任务已改名", exact: true }).waitFor({ state: "visible" });
  ensure(await sourceSaid() === null, "unknown origin without a parent must not add an empty mark");
  await open("旧任务保留父链接");
  ensure(!(await sourceSaid() || "").includes("创建"), "parent relationship must not imply a creator");
  await page.locator(".task-detail-header").getByRole("button", { name: "来自团队：父任务已改名", exact: true }).click();
  await page.getByRole("heading", { name: "父任务已改名", exact: true }).waitFor({ state: "visible" });
  ensure(await sourceSaid() === null, "legacy parent must still have no empty origin mark");
}
