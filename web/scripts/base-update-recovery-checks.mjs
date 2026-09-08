export async function checkBaseUpdateRecovery(page, fixtureUrl, checkpoint = async () => {}) {
  const ensure = (value, message) => { if (!value) throw new Error(message); };
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = page.getByRole("dialog");
  const files = page.locator('output[aria-label="diff 文件"]');
  for (const task of ["case16-child", "case17-child", "case19-child"]) {
    const complete = task !== "case19-child";
    const url = new URL(fixtureUrl);
    url.search = new URLSearchParams({ task, clock: "manual" }).toString();
    await page.goto(url.href);
    await page.getByRole("heading", { name: task, exact: true }).waitFor({ state: "visible" });
    await button("处理未完成的基线更新").waitFor({ state: "visible" });
    await button("基线更新待处理").waitFor({ state: "visible" });
    ensure(!await button("基线更新待处理").isEnabled(), "pending update must have a short blocked acceptance label");
    if (complete) {
      await files.filter({ hasText: "unrelated-main.txt" }).waitFor({ state: "visible" });
      await button("更新子分支基线").click();
      await dialog.getByRole("button", { name: "更新基线", exact: true }).click();
      await page.getByRole("status").filter({ hasText: /工作区已变化|子分支已被其它操作修改/ }).waitFor({ state: "visible" });
    }
    await button("处理未完成的基线更新").click();
    const title = complete ? "完成已生效的基线更新？" : "放弃本次基线更新？";
    await dialog.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
    ensure((await dialog.innerText()).includes("处理后开工提交"), "confirmation must show the resulting diff base");
    if (complete) ensure((await dialog.innerText()).includes("保留当前提交"), "completion must explain preservation of current work");
    await checkpoint(`${task}-recovery-confirm`);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    ensure(await button("处理未完成的基线更新").isEnabled(), "cancel must preserve the pending operation");
    await button("处理未完成的基线更新").click();
    await dialog.getByRole("button", { name: complete ? "确认完成基线更新" : "确认放弃基线更新", exact: true }).click();
    await page.getByRole("status").filter({ hasText: complete ? "已按更新后的起点完成结算" : "已放弃本次基线更新" }).first().waitFor({ state: "visible" });
    await button("处理未完成的基线更新").waitFor({ state: "detached" });
    await button("重设合入目标").and(page.locator("button:enabled")).waitFor({ state: "visible" });
    ensure(await button("重设合入目标").count() === 1, "recovery must not duplicate the target editor");
    const expected = task === "case17-child" ? "child.txt,newer.txt" : "child.txt";
    await files.filter({ hasText: new RegExp(`^${expected.replaceAll(".", "\\.")}$`) }).waitFor({ state: "visible" });
    ensure(!(await page.getByRole("region", { name: "恢复后的分支改动", exact: true }).innerText()).includes("unrelated-main.txt"), "main's unrelated file leaked into the review diff");
    await checkpoint(`${task}-recovery-diff`);
  }
}
