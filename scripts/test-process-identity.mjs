// ── 两条**纯判据**:这还是当初那一个吗 / 环境段里真有这么一个变量吗 ──────────────────
//
// 它们落在 test-process-probe.mjs 里,被所有权那一层拿去决定「认不认领、要不要发信号」——
// 也就是说判错的后果是**把别人的程序关掉**,或者**把自己的遗留当成清场**。这两件事都不该靠
// 端到端用例去碰运气复现(要造出「号码刚好被复用」「另一个域的名字刚好把我这个包住」需要
// 时序巧合),所以这里直接按函数钉:两个纯函数,输入输出全枚举。
//
// 行为面在 test-process-ownership.mjs(真进程、真 ps、真终止)。
import assert from "node:assert/strict";
import { environmentHasMarker, instanceVerdict } from "./test-process-probe.mjs";

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

console.log("process identity judgements ok");
