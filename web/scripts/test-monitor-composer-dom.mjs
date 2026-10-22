// 「它什么时候算完」这一格在真壳子里的样子:入口一直在、该逼选时才逼选、不该逼选时按钮能点。
//
// 从 test-monitor-inspector-dom.mjs 拆出来的（全局约定:单文件不超过 700 行）。台子同一份
// （`monitor-dom-harness.mjs`）。这一格的用例非得真浏览器不可,原因不是布局:**判据在每次渲染
// 里同步跑**,它一抛整棵树就卸载(第 2 轮审查 F1 实测页面变成空白),而「按钮是不是真的点不
// 了」只有算过样式的壳子答得出来 —— 服务端那一侧的同一份判据另有回归
// （server/scripts/test-monitor-block-eligibility.ts）。
//
// 每一轮审查实测到的**误判**都在这里留一条:那一刻用户看到的就是这张表单把按钮禁掉了。
import assert from "node:assert/strict";
import { openHarness } from "./monitor-dom-harness.mjs";

const { open, waitIds, failures, close } = await openHarness();
try {
  // ── 「它什么时候算完」这一格:入口一直在、该逼选时才逼选、圆圈不占整行 ──────────
  // 第 1 轮审查 F3/N1 三件事一起量（都只有真浏览器答得出来）：
  //  · 判据认不出来的命令照样配得上结束条件（上一版那个输入框只在判据命中时才存在，于是
  //    `tail -n 0 -F /dev/null` 这种真跟随器连框都没有）；
  //  · 判据命中时才多出二选一，而且不选不许提交；
  //  · 那两个单选圆圈**不许各占一整行**——`.monitor-composer label/input` 是同级后代选择器，
  //    只给新类名压不住它（实测 radio 宽 231.5px = label 整行宽），所以这里只认几何。
  {
    const page = await open();
    await waitIds(page, "m-task-a");
    await page.getByRole("button", { name: "手动起一个哨兵" }).click();
    const form = page.locator(".monitor-composer");
    const cmd = form.locator("textarea");
    const pattern = form.locator(".monitor-composer__ending-pattern");
    const submit = page.getByRole("button", { name: "起一个哨兵", exact: true });

    // ① 会自己结束的命令:框在，而且不拦着提交。
    await cmd.fill(String.raw`printf 'hi\n'`);
    assert.equal(await pattern.count(), 1, "普通命令也要给得出结束条件的入口");
    assert.doesNotMatch(await form.innerText(), /永远不会结束/, "它会自己结束，不许说成不会");
    assert.equal(await submit.isDisabled(), false, "普通命令不该被这一格拦住");

    // ② 审查实测的那条**误判**:命中的是 printf 的参数，不是一个真的跟随器。
    await cmd.fill(String.raw`printf '%s\n' 'tail -F build.log'`);
    assert.doesNotMatch(await form.innerText(), /永远不会结束/, "引号里的字不是执行节点");
    assert.equal(await submit.isDisabled(), false, "这条命令打一行就退，不许拦");

    // ③ 审查实测的那条**漏判**:开关没紧跟在命令词后面，它仍是跟随器 —— 要逼选。
    await cmd.fill("tail -n 0 -F /dev/null");
    assert.match(await form.innerText(), /永远不会结束/, "这是个真跟随器，得说出来");
    assert.equal(await pattern.count(), 1, "逼选的时候那个框当然也在");
    assert.equal(await submit.isDisabled(), true, "二选一没选就不许提交");
    const [radio, label] = await Promise.all([
      form.locator(".monitor-composer__ending-options input").first().boundingBox(),
      form.locator(".monitor-composer__ending-options label").first().boundingBox(),
    ]);
    assert.ok(radio.width < 40, `单选圆圈不许被拉成整行，实际 ${radio.width}px`);
    assert.ok(radio.width < label.width / 2, `圆圈和说明该在同一行，实际圆圈 ${radio.width} / 行 ${label.width}`);

    // ④ 填了字样就算选过了（服务端那一边同一份判据）。
    await pattern.fill("BUILD OK|FAILED");
    assert.equal(await submit.isDisabled(), false, "填了字样就等于选了「出现就收工」");

    // ⑤ 条件本身用不了的，当场说 —— 不让人拿一句 400 当反馈。
    await pattern.fill("^(OK");
    assert.match(await form.innerText(), /不是正则/, "按习惯写正则的人要当场看到这句");
    assert.equal(await submit.isDisabled(), true, "用不了的条件不许提交");

    // ⑥ **整段都是空白的条件也用不了**（第 3 轮审查 N1）:哨兵读到空行直接快进,它永远不会
    //    命中 —— 当场说,别让人以为自己已经设过了。
    await pattern.fill("^ $");
    assert.match(await form.innerText(), /空白/, "永远不会命中的条件要当场说出来");
    assert.equal(await submit.isDisabled(), true, "永远不会命中的条件不许提交");
    await pattern.fill("");

    // ⑦ 第 3 轮审查 F1 实测的那四条**误判**:真 shell 里全部退出 0,而这张表单把按钮禁掉了
    //    （判据层的四道口子,见 shared/src/command-never-exits.ts 文件头 ⑤）。页面这一侧量的
    //    是同一件事落到人手上的样子:不许说「永远不会结束」,按钮不许禁。
    for (const command of [
      String.raw`command -v tail -F /dev/null; printf 'DONE\n'`,
      String.raw`printf "literal \"; tail -F /dev/null; #\n"`,
      "while true; do :; done > /definitely-missing-ash-review-file/out; printf 'DONE'",
      "tail -F /dev/null < /definitely-missing-ash-review-file; printf 'DONE'",
    ]) {
      await cmd.fill(command);
      assert.doesNotMatch(await form.innerText(), /永远不会结束/, `这条命令会自己结束：${command}`);
      assert.equal(await submit.isDisabled(), false, `不许把这条命令的按钮禁掉：${command}`);
    }
    // ⑧ 第 2 轮审查 F1:**判据一抛,这张表单整棵树就卸载** —— 审查实测填到 `./constructor -v`
    //    那一下整页变成空白。命令词正好撞上 `Object.prototype` 上的名字是一类输入,所以这里
    //    逐个填一遍:页面必须还在、按钮必须能点。
    for (const command of ["./constructor", "./constructor -v", "./toString -v", "/x/valueOf -u FOO tail -F x"]) {
      await cmd.fill(command);
      assert.equal(await form.count(), 1, `判据抛异常会把这张表单整棵树卸载：${command}`);
      assert.equal(await submit.isDisabled(), false, `不许把这条命令的按钮禁掉：${command}`);
    }
    // ⑨ 第 2 轮审查 F2:整个形状连不起来的那几条,页面这一侧也不许说「永远不会结束」。
    for (const command of [
      "tail -F /dev/null 1>&- 2>&1; printf 'DONE'",
      "nice -n not-a-number tail -F /dev/null; printf 'DONE'",
      "tail -F -n not-a-number /dev/null; printf 'DONE'",
    ]) {
      await cmd.fill(command);
      assert.doesNotMatch(await form.innerText(), /永远不会结束/, `这条命令会自己结束：${command}`);
      assert.equal(await submit.isDisabled(), false, `不许把这条命令的按钮禁掉：${command}`);
    }
    // ⑩ 第 1 轮审查 F1:**会立即打印 DONE 并结束的命令,按钮不能点**（审查实测这一幕就在这张
    //    表单上）。三条各对应一项读不出来的东西:它盯的是标准输入、少了要盯的那个操作数、
    //    `set -e` 让前一条的退出码管得着它（见 shared/src/command-never-exits.ts 文件头 ⑦）。
    for (const command of [
      String.raw`printf 'DONE\n' | tail -f`,
      String.raw`printf 'DONE\n' | tail -F`,
      "tail -F",
      "set -e; false; tail -F /dev/null",
      "tail --pid=123 -F /dev/null",
    ]) {
      await cmd.fill(command);
      assert.doesNotMatch(await form.innerText(), /永远不会结束/, `这条命令会自己结束：${command}`);
      assert.equal(await submit.isDisabled(), false, `不许把这条命令的按钮禁掉：${command}`);
    }
    // ⑩b 同一批的真阳对照:把读不出来的那一项补齐,它照旧要逼选。
    for (const command of ["printf 'x' | tail -f /var/log/app.log", "set -e; tail -F /dev/null"]) {
      await cmd.fill(command);
      assert.match(await form.innerText(), /永远不会结束/, `这条命令真的不会自退：${command}`);
      assert.equal(await submit.isDisabled(), true, `这条命令照旧要逼选：${command}`);
    }
    // ⑩c 新一轮审查 F1:会立即打印 DONE 并结束的命令**在这张表单上也不能被禁掉**。两条各对应
    //     一项读不出来的东西:下游先退会把管子关了、`set -e` 下循环体自己就是出路（见
    //     shared/src/command-never-exits.ts 文件头 ⑧）。
    for (const command of [
      String.raw`while true; do printf 'DONE\n'; done | head -n 1`,
      "while true; do printf x; done | grep ERROR",
      "set -e; while true; do false; done",
    ]) {
      await cmd.fill(command);
      assert.doesNotMatch(await form.innerText(), /永远不会结束/, `这条命令会自己结束：${command}`);
      assert.equal(await submit.isDisabled(), false, `不许把这条命令的按钮禁掉：${command}`);
    }
    // ⑩d 同一轮 F1 的第 3 条落到**人**手上的样子:`tail -f build.log` 只在那个文件在的时候才不
    //     会结束,而浏览器里读不到文件系统 —— 所以这里照实把**前提**说出来（仍然逼选,服务端
    //     会按真实工作目录再判一次;文件真不在时那边直接放行）。
    await cmd.fill("tail -f build.log");
    const premise = await form.innerText();
    assert.match(premise, /只要 build\.log 还在/, `读不出来的前提要照实说出来，实际：${premise}`);
    assert.match(premise, /永远不会结束/, "说了前提也还是要说清后果");
    assert.equal(await submit.isDisabled(), true, "前提成立时它是个真跟随器，照旧要逼选");
    // 不带前提的那种不许多一句:`-F` 没了也一直重试。
    await cmd.fill("tail -F build.log");
    assert.doesNotMatch(await form.innerText(), /只要/, "`-F` 不要这个前提，不许凭空说一句");
    // ⑦b 真阳对照:事故的起因命令带着 `2>/dev/null`,它照旧要逼选（不然上面那四条等于把闸拆了）。
    await cmd.fill("tail -F build.log 2>/dev/null | grep --line-buffered ERROR");
    assert.match(await form.innerText(), /永远不会结束/, "起因命令照旧要说出来");
    assert.equal(await submit.isDisabled(), true, "起因命令照旧要逼选");
    await page.close();
  }

  assert.deepEqual(failures, []);
  console.log("monitor composer dom: the end-condition field is always offered (forced choice only for provable followers, radios on one line); every command a review measured as self-terminating stays submittable");
} finally {
  await close();
}
