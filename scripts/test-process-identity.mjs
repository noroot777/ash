// ── 两条**纯判据**:这还是当初那一个吗 / 环境段里真有这么一个变量吗 ──────────────────
//
// 它们落在 test-process-probe.mjs 里,被所有权那一层拿去决定「认不认领、要不要发信号」——
// 也就是说判错的后果是**把别人的程序关掉**,或者**把自己的遗留当成清场**。这两件事都不该靠
// 端到端用例去碰运气复现(要造出「号码刚好被复用」「另一个域的名字刚好把我这个包住」需要
// 时序巧合),所以这里直接按函数钉:两个纯函数,输入输出全枚举。
//
// 行为面在 test-process-ownership.mjs(真进程、真 ps、真终止)。
import assert from "node:assert/strict";
import { CLOCK_SLACK_MS, birthOf, environmentHasMarker, instanceVerdict, processRows } from "./test-process-probe.mjs";

// ── ① 实例身份:三档,而且**没有时间容差** ────────────────────────────────────────
// 第 1 轮审查 F5:上一版是 `Math.abs(born - (row.born ?? born)) <= 1000`,两处都塌了 ——
// 一秒容差把「下一秒出生的复用实例」算成同一个,而 `?? born` 在原值读不出来时拿**这一次**
// 读到的时刻冒充待验证身份,于是必然相等,等于不核。
{
  const born = Date.parse("Thu Oct 22 09:25:56 2026");
  assert.equal(instanceVerdict(born, born), "same", "同一个时刻就是同一个实例");
  for (const [observed, why] of [
    [born + 1_000, "晚一秒出生的是另一个实例 —— 同一个进程的两次 lstart 读数不存在测量误差"],
    [born - 1_000, "早一秒同理"],
    [born + 1, "差一毫秒也算另一个:相等就该严格相等"],
    [born + 600_000, "差得远的更不必说"],
  ]) assert.equal(instanceVerdict(born, observed), "other", why);
  // 任一侧读不出来 ⇒ **第三档**,不许往「same」上凑,也不许往「已经没了」上归。
  for (const [recorded, observed, why] of [
    [null, born, "当初没解析出 lstart:拿这一次读到的冒充待验证身份就等于不核"],
    [born, null, "这一次读到的不是个时刻"],
    [null, null, "两边都读不出来"],
    [Number.NaN, born, "NaN 不是时刻"],
    [born, Number.NaN, "同上,反过来"],
  ]) assert.equal(instanceVerdict(recorded, observed), "unverifiable", why);
  console.log("✓ 实例身份:相等才算同一个(无容差),任一侧读不出来是单独一档");
}

// ── ② 环境段:`KEY=VALUE` 整段两侧都要收口 ────────────────────────────────────────
// 第 1 轮审查 F4:上一版是裸 `includes`,于是另一个执行域 `/tmp/check-ABC-other` 的**真实**
// 环境把 `/tmp/check-ABC` 那一域的标记整段包住 —— 它被当成域内进程认领,随后被那一域的
// `stop()` 终止。临时目录名带后缀是常态,这不是巧合输入。
{
  const marker = "ASH_TEST_PROCESS_SCOPE=/tmp/check-ABC";
  for (const [segment, why] of [
    [` ${marker}`, "段尾收口"],
    [` ${marker} OTHER=1`, "后面还有别的变量"],
    [` PATH=/usr/bin ${marker} HOME=/root`, "夹在中间"],
    [marker, "整段就是它(段首也算收口)"],
  ]) assert.equal(environmentHasMarker(segment, marker), true, `这是真有这个变量:${why}`);
  for (const [segment, why] of [
    [` ${marker}-other`, "**这就是 F4 那一条**:另一个域的目录名把我这个整段包住"],
    [` ${marker}/sub`, "子目录同理"],
    [` OTHER=prefix-${marker}`, "别的变量的值里嵌着这段文字,左边没有收口"],
    [` XASH_TEST_PROCESS_SCOPE=/tmp/check-ABC`, "变量名被加了前缀"],
    ["", "空段"],
    [null, "读不出来的环境段(切不出来时是 null)"],
  ]) assert.equal(environmentHasMarker(segment, marker), false, `这不算有这个变量:${why}`);
  assert.equal(environmentHasMarker(` ${marker}`, ""), false, "没有标记就不认领任何东西");
  // **残留,如实记下来**:`ps -E` 把环境块按空格拼成一行,而变量值本身可以带空格 —— 所以
  // 「另一个变量的值里原样嵌着『空格 + 我这一整段 + 空格』」这一种切不开,这个判据认得出它。
  // 那需要有人把本域的随机临时目录名专门拼进去(理由与上界见 `environmentHasMarker`)。
  assert.equal(environmentHasMarker(` OTHER=x ${marker} y`, marker), true,
    "已知残留:值里嵌着空格收口的那一段,文本判据分不出来");
  console.log("✓ 环境段:前缀/后缀碰撞都不算有这个变量(F4 那一条当场被拦),残留只剩值里嵌空格那一种");
}

// ── ③ 出生时刻:枚举和下刀前读的必须是**同一把尺子**,而且零点对得上挂钟 ─────────────
// 这一节是平台相关的:`processRows` 枚举一遍,`verifyInstance` 在发信号之前用 `birthOf` 再读
// 一遍,两处如果不是同一把尺子,严格相等的判据会把**每一行**都判成 "other" —— 什么都不认领、
// 什么都不终止,而且一声不响。第 5 轮审查 F3 把 Linux 换成自己读 `/proc`(GNU ps 不认 `-E`),
// 两个平台从此各一套实现,这一节就是钉住它们别漂。
{
  const rows = await processRows(null);
  const mine = rows.find((row) => row.pid === process.pid);
  assert.ok(mine, "全表快照里必须有本进程 —— 查不动不算空集");
  // **零点要对得上挂钟**:Linux 的刻度(USER_HZ)是解出来的,解错时两次读数照旧相等、却会把
  // born 偏到几十分钟开外 —— 于是 `#impostor` 把域内进程全判成冒充者,一个都不认领。
  const wall = Date.now() - process.uptime() * 1_000;
  assert.ok(Math.abs(mine.born - wall) <= 2 * CLOCK_SLACK_MS,
    `本进程的出生时刻(${mine.born})离挂钟读数(${wall})太远:刻度或零点不对`);
  if (process.platform === "win32") {
    // Windows 不走出生时刻这条路:代次核对在句柄那头(OpenProcess + GetProcessTimes),快照里
    // 带的是 FILETIME。没有它,`signalInstance` 只能落 unverifiable、一刀都不发。
    assert.ok(mine.created, "Windows 的快照必须带 created(FILETIME),句柄那头靠它核代次");
    console.log("- 跳过出生时刻一节(Windows 的代次核对在句柄那头)");
  } else {
    assert.equal(instanceVerdict(mine.born, birthOf(process.pid)), "same",
      "枚举读到的出生时刻和下刀前读到的必须严格相等,否则就是两把尺子");
    // 没有主人的号码要答「它不在了」—— 这一档决定「这一刀不发」,不许混进「核不出来」。
    const vacant = (() => {
      for (let pid = 99_999; pid > 99_900; pid -= 1) if (birthOf(pid) === "gone") return pid;
      throw new Error("找不到一个空号码,这一节没法测");
    })();
    assert.equal(birthOf(vacant), "gone", `空号码 ${vacant} 应当答「它不在了」`);
    console.log(`✓ 出生时刻:枚举与下刀前同一把尺子、零点对得上挂钟,空号码答「不在了」(${process.platform})`);
  }
}

console.log("process identity judgements ok");
