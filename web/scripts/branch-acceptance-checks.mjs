export async function checkBranchAcceptance(page, fixtureUrl) {
  const ensure = (value, message) => { if (!value) throw new Error(message); };
  const go = async task => {
    const url = new URL(fixtureUrl);
    url.search = new URLSearchParams({ task, clock: "manual" }).toString();
    await page.goto(url.href);
    await page.getByRole("heading", { name: task, exact: true }).waitFor({ state: "visible" });
  };
  const button = name => page.getByRole("button", { name, exact: true });
  const review = () => page.getByRole("region", { name: "审查页入口", exact: true });
  const inspector = () => page.getByRole("region", { name: "工作流侧栏入口", exact: true });
  const output = name => page.locator(`output[aria-label="${name}"]`);
  const settled = async count => {
    await output("依赖响应次数").filter({ hasText: new RegExp(`^${count}$`) }).waitFor({ state: "visible" });
    ensure(await output("依赖请求次数").innerText() === String(count), "subscribers issued duplicate requests");
  };

  for (const [task, reason] of [["case1-unstarted", "任务分支不存在或已清理"], ["case1-badstart", "无法读取任务的开工提交"]]) {
    await go(task);
    await page.getByText(`当前无法生成分支 diff：${reason}。`, { exact: true }).waitFor({ state: "visible" });
    await page.getByText(`无法生成分支 diff：${reason}`, { exact: true }).waitFor({ state: "visible" });
    ensure(!/accepted_snapshot_unreadable|source_branch_missing|start_commit_unreadable/.test(await page.locator("main").innerText()), "internal diff reason leaked to UI");
  }
  await go("case6-parent");
  await page.getByRole("checkbox", { name: "case6-child", exact: true }).check();
  await page.getByRole("alert").filter({ hasText: "父子统一验收不适用于这条旧关系" }).waitFor({ state: "visible" });
  ensure(!await page.getByRole("button", { name: /验收父任务及所选子任务/ }).isEnabled(), "legacy child must not be merged after its parent");
  ensure(await page.getByRole("link", { name: "查看改动", exact: true }).count() === 1, "legacy child has no navigation entry");
  await go("case6-child");
  await page.getByRole("status").filter({ hasText: "旧任务仍合入父分支" }).waitFor({ state: "visible" });
  ensure(await page.getByRole("link", { name: "查看父任务", exact: true }).count() === 1, "legacy child has no parent link");

  await go("case5-parent");
  await page.getByRole("region", { name: "派生与验收依赖" }).waitFor({ state: "visible" });
  ensure(await review().getByRole("button", { name: "放行，继续下一站" }).isEnabled(), "review mid-gate must allow release");
  ensure(await inspector().getByRole("button", { name: "放行，继续下一站" }).isEnabled(), "inspector mid-gate must allow release");
  ensure(!await page.getByRole("button", { name: /验收父任务及所选子任务/ }).isEnabled(), "family acceptance must still reject mid-gate");
  for (const [value, label] of [["archived", "已归档（只读）"], ["running", "执行中"], ["queued", "执行中"], ["block", "审查进行中"]]) {
    await page.getByRole("combobox", { name: "保护状态" }).selectOption(value);
    ensure(!await review().getByRole("button", { name: label, exact: true }).isEnabled(), `lost ${value} protection`);
  }
  await page.getByRole("combobox", { name: "保护状态" }).selectOption("none");
  await review().getByRole("button", { name: "放行，继续下一站" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "放行这一关？" }).waitFor({ state: "visible" });
  ensure(!/已执行的合并和删除不可逆/.test(await dialog.innerText()), "release must not advertise final merge");
  await dialog.getByRole("button", { name: "放行", exact: true }).click();
  await page.getByRole("status", { name: "操作结果" }).filter({ hasText: "已放行" }).waitFor({ state: "visible" });
  ensure(await output("工作流游标").innerText() === "verify2", "review release must advance to verify");

  await go("case5-child");
  await inspector().getByRole("button", { name: "放行，继续下一站" }).click();
  await dialog.getByRole("heading", { name: "放行这一关？" }).waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "放行", exact: true }).click();
  await page.getByRole("status", { name: "操作结果" }).filter({ hasText: "已放行" }).waitFor({ state: "visible" });
  ensure(await output("工作流游标").innerText() === "verify2", "child inspector release must advance despite waiting parent");

  await go("case1-child");
  const waiting = review().getByRole("button", { name: "等待父成果或更新基线" });
  await waiting.waitFor({ state: "visible" });
  ensure(!await waiting.isEnabled(), "final acceptance must keep dependency guard");
  await go("case4-parent");
  const missing = review().getByRole("button", { name: /目标本地分支 main 不存在/ });
  await missing.waitFor({ state: "visible" });
  ensure(!await missing.isEnabled(), "final acceptance must keep target guard");

  await go("case3-parent");
  await review().getByRole("button", { name: "验收通过", exact: true }).waitFor({ state: "visible" });
  await settled(1);
  await button("轮询一次").click();
  await settled(2);
  await button("模拟任务更新").click();
  await settled(3);
  await button("下次依赖请求失败").click();
  await button("刷新依赖").click();
  await review().getByRole("button", { name: "验收依赖读取失败" }).waitFor({ state: "visible" });
  ensure(!await review().getByRole("button", { name: "验收依赖读取失败" }).isEnabled(), "shared errors must block acceptance");
  await settled(4);
  await button("重试").click();
  await settled(5);
  await button("延迟下次依赖响应").click();
  await button("刷新依赖").click();
  await output("延迟状态").filter({ hasText: "已挂起" }).waitFor({ state: "visible" });
  await button("刷新依赖").click();
  await output("依赖响应次数").filter({ hasText: /^6$/ }).waitFor({ state: "visible" });
  await button("释放旧响应").click();
  await settled(7);
  ensure(await review().getByRole("button", { name: "验收通过", exact: true }).isEnabled(), "old response overwrote newer refresh");
  ensure(await page.getByText("过期响应不应覆盖新结果", { exact: true }).count() === 0, "panel received stale response");
  await button("卸载验收界面").click();
  await button("轮询一次").click();
  await settled(7);
  await button("恢复验收界面").click();
  await settled(8);
  await button("轮询一次").click();
  await settled(9);
  await button("延迟正常依赖响应").click();
  await button("模拟任务更新").click();
  await output("延迟状态").filter({ hasText: "已挂起" }).waitFor({ state: "visible" });
  ensure(!await review().getByRole("button", { name: "检查验收依赖" }).isEnabled(), "updated task must await a fresh plan");
  await button("释放旧响应").click();
  await settled(10);
  ensure(await review().getByRole("button", { name: "验收通过", exact: true }).isEnabled(), "fresh task plan must restore acceptance");

  await go("case2-child");
  await button("更新子分支基线").click();
  await dialog.getByRole("heading", { name: "更新子分支基线？" }).waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "更新基线", exact: true }).click();
  await page.getByText("基线已更新，请核对改动并按影响范围重新验证。", { exact: true }).waitFor({ state: "visible" });
  await review().getByRole("button", { name: "验收通过", exact: true }).and(page.locator("button:enabled")).waitFor({ state: "visible" });
  ensure(await review().getByRole("button", { name: "验收通过", exact: true }).isEnabled(), "baseline update should unblock acceptance");

  await go("case1-parent");
  await page.getByRole("checkbox", { name: "case1-grand", exact: true }).check();
  await page.getByRole("alert").filter({ hasText: "未勾选的父任务" }).waitFor({ state: "visible" });
  ensure(!await page.getByRole("button", { name: /验收父任务及所选子任务/ }).isEnabled(), "cannot skip intermediate ancestor");
  await page.getByRole("checkbox", { name: "case1-child", exact: true }).check();
  await page.getByRole("button", { name: /验收父任务及所选子任务/ }).click();
  await dialog.getByRole("heading", { name: "统一验收所选任务？" }).waitFor({ state: "visible" });
  for (const name of ["case1-parent", "case1-child", "case1-grand"]) ensure((await dialog.innerText()).includes(name), `missing ${name} from confirmation`);
  await dialog.getByRole("button", { name: "确认统一验收", exact: true }).click();
  await page.getByText("统一验收已完成，共 3 个任务。", { exact: true }).waitFor({ state: "visible" });
}
