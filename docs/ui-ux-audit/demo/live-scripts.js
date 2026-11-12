/* 执行中的剧本（live.js 照着演）：一段是一轮，从发出到落定。数据按 ash 真实的粒度来写——工具只有一条「开始」，正文是一整段。
   一步的写法：{ think: 毫秒 } 想；{ tool: { verb, text, fields? }, ms } 做一件事（带 spawn 的是派出一个子智能体，带 hang 的是挂上一个哨兵）；
   { text } 说一段话；{ ask: { q, options } } 停下来问你；{ watch: { name, ms, lines, exit? } } 等哨兵叫醒（带 exit 的那一次哨兵自己也跑完了）；
   { fail: 退出码 } 异常结束；{ end: { turn, files, add, del, ctx, commit? } } 正常收口，数字是这一轮多出来的量。
   PREP：对照清单点到「执行中」的哪一条，就演哪一段。 */
(() => {
  const cur = ASH.data.cur;
  const [HEAD, PREV] = cur.commits;
  const SQUASH = 'b7e2a94';
  const TEST = { verb: '跑', text: cur.test.name, fields: { 命令: cur.test.cmd, 目录: 'server', 时限: '10 分钟' } };
  const WATCH = `${cur.test.title} ×3`;
  const SCRIPTS = {
    run: { say: '把这两条修复合成一个提交，再跑一遍回归。', events: [
      { think: 2400 },
      { tool: { verb: '读', text: '`server/src/later-send-recover.ts`' }, ms: 900 },
      { tool: { verb: '读', text: '`server/scripts/test-later-send-recover.ts`' }, ms: 1100 },
      { tool: { verb: '跑', text: '`git log --oneline -3`', fields: { 命令: 'git log --oneline -3', 目录: '.' } }, ms: 1200 },
      { text: `两条修复现在是两个提交：\`${PREV[0]}\` 和 \`${HEAD[0]}\`。我把它们压成一个，说明里写清各自对应哪条审查意见，然后重跑回归。` },
      { tool: { verb: '跑', text: '`git reset --soft HEAD~2`' }, ms: 1100 },
      { tool: { verb: '跑', text: '`git commit`', fields: { 命令: 'git commit -m "补发前重新核对：撤回的不发，时间回拨不重发"', 目录: '.' } }, ms: 1200 },
      { tool: { verb: '写', text: '`docs/later-send.md`' }, ms: 1000 },
      { tool: TEST, ms: 3400 },
      { think: 1400 },
      { text: `合成了一个提交 \`${SQUASH}\`：**补发前重新核对，撤回的不发、时间回拨不重发**。\n\n回归测试 ${cur.test.pass} 条全部通过，补发的规则顺手记进了 \`docs/later-send.md\`。改动没有超出这两条意见的范围，可以直接验收。` },
      { end: { turn: 41800, files: 1, add: 12, del: 3, ctx: 3, commit: { hash: SQUASH, text: '补发前重新核对：撤回的不发，时间回拨不重发', squash: 2 } } },
    ] },
    ask: { say: '回归偶尔会挂，看一下是不是用例本身的问题。', events: [
      { think: 1800 },
      { tool: { verb: '读', text: '`server/scripts/test-later-send-recover.ts`' }, ms: 1200 },
      { tool: { verb: '搜', text: '「Date.now」于 `server/scripts`', fields: { 查找: 'Date.now', 范围: 'server/scripts' } }, ms: 1000 },
      { text: '有一条用例依赖真实时钟：它等 50 毫秒后断言「已经过点」，机器一忙就会差几毫秒。' },
      { ask: { q: '这条用例改成假时钟，还是把断言放宽？', options: ['改成假时钟', '把断言放宽到 ±1 秒'] } },
      { think: 1200 },
      { tool: { verb: '改', text: '`server/scripts/test-later-send-recover.ts`' }, ms: 1300 },
      { tool: TEST, ms: 2400 },
      { text: '按你说的改好了，连跑 20 遍没有再挂。' },
      { end: { turn: 18600, files: 0, add: 8, del: 3, ctx: 2 } },
    ] },
    fail: { say: '再跑一遍回归。', events: [
      { think: 1500 },
      { tool: TEST, ms: 3200 },
      { fail: 1 },
    ] },
    slow: { say: '补发还有没有别的漏网的情况？仔细想想。', events: [
      { think: 17000 },
      { text: '想了一圈，还剩一条：任务被接力到另一台机器时，待发送里的定时消息没有跟过去。这条我单独开一个任务记下来。' },
      { end: { turn: 9200, files: 0, add: 0, del: 0, ctx: 1 } },
    ] },
    /* 中途挂一个哨兵、被它叫醒三次：回合不收口。等的时候进行条写着「在等哨兵…」；叫醒了这一行接着往下走，
       上一段正文之前的东西并成一行——被叫醒多少次，回合里摊着的都只有最近那一段 */
    watch: { say: '把回归连跑三遍，看还会不会偶尔挂。', events: [
      { think: 1600 },
      { tool: { verb: '读', text: '`server/scripts/test-later-send-recover.ts`' }, ms: 1000 },
      { tool: { verb: '挂', text: `哨兵「${WATCH}」`, fields: { 盯什么: WATCH, 命令: `for i in 1 2 3; do ${cur.test.cmd} || break; done`, 目录: 'server', 时限: '30 分钟' },
        hang: { title: WATCH, cmd: `for i in 1 2 3; do ${cur.test.cmd} || break; done`, limit: 30, then: '每遍跑完看一眼结果，三遍都过了再回话' } }, ms: 1100 },
      { text: '连跑三遍要半个小时左右。我挂了一个哨兵盯着，每跑完一遍它叫我一次。' },
      { watch: { name: WATCH, ms: 5200, lines: [`第 1 遍：${cur.test.pass} passed, 0 failed`] } },
      { think: 1100 },
      { text: '第 1 遍过了，接着等后两遍。' },
      { watch: { name: WATCH, ms: 4200, lines: [`第 2 遍：${cur.test.pass} passed, 0 failed`] } },
      { think: 1000 },
      { text: '第 2 遍也过了。' },
      { watch: { name: WATCH, ms: 4200, exit: 0, lines: [`第 3 遍：${cur.test.pass} passed, 0 failed`, '命令退出，退出码 0'] } },
      { think: 1200 },
      { tool: { verb: '读', text: '`server/logs/later-send-test.log`' }, ms: 1000 },
      { text: `三遍都过了，每遍 ${cur.test.pass} 条。之前偶尔挂的那一条是端口被占，和补发的逻辑没有关系。` },
      { end: { turn: 14800, files: 0, add: 0, del: 0, ctx: 1 } },
    ] },
    /* 派三个子智能体分头查：会话里是三步「派」，各自在做什么、带回了什么在右边「子智能体」那一格（agents:spawn） */
    agents: { say: '补发还会不会漏别的入口？分头查一下。', events: [
      { think: 1500 },
      { tool: { verb: '派', text: '子智能体：查接力到别的机器时待发送跟不跟', spawn: { title: '查接力到别的机器时待发送跟不跟', kind: 'Explore', model: 'haiku-4-5', ms: 6400,
        acts: ['在搜「later_messages」', '在读 server/src/handoff.ts', '在读 server/src/later-send-store.ts'],
        input: '任务接力到另一台机器时，待发送里的定时消息有没有跟过去？看接力打包了哪些东西。只读代码，不要改。',
        result: '没有跟过去。接力只打包了会话和工作区，待发送里的定时消息留在原来那台机器上；到点时那台机器要是关着，这几条就不会发。' } }, ms: 500 },
      { tool: { verb: '派', text: '子智能体：查任务归档时待发送怎么处理', spawn: { title: '查任务归档时待发送怎么处理', kind: 'Explore', model: 'haiku-4-5', ms: 4200,
        acts: ['在搜「archive」', '在读 server/src/archive.ts'],
        input: '任务被归档时，它名下还没发的定时消息怎么处理？会不会归档以后还发出去，或者再也发不出去。只读代码，不要改。',
        result: '不会漏。归档时会把这个任务名下没发的定时消息一并撤回，之后的补发也会跳过撤回的。' } }, ms: 500 },
      { tool: { verb: '派', text: '子智能体：查改了系统时区以后会不会重发', spawn: { title: '查改了系统时区以后会不会重发', kind: 'Explore', model: 'haiku-4-5', ms: 5200,
        acts: ['在读 server/src/later-send.ts', '在读 server/src/later-send-recover.ts', '在跑 时区换算的小脚本'],
        input: '改了系统时区以后，定时消息会不会提前、推迟或者重发一遍？只读代码，可以跑只读的小脚本验证。',
        result: '不会。原定时间存的是不带时区的时刻，换时区不影响先后；补发那一笔记录按消息去重，不会发第二遍。' } }, ms: 7200 },
      { think: 1300 },
      { text: '三路都查完了，漏的只有一处：**任务接力到另一台机器时，待发送里的定时消息没有跟过去。**归档和换时区都没有问题。\n\n这一处不在这次的范围里，我没有动。要修的话单开一个任务。' },
      { end: { turn: 22600, files: 0, add: 0, del: 0, ctx: 2 } },
    ] },
    /* 「重试」跑的那一轮：没有新的气泡，接着上一轮做；回合头名字后面写着「重试」 */
    again: { events: [
      { think: 1200 },
      { tool: TEST, ms: 2800 },
      { text: `这次过了，${cur.test.pass} 条全部通过。上一次是测试端口被别的进程占着，和这次的改动没有关系。` },
      { end: { turn: 6400, files: 0, add: 0, del: 0, ctx: 1 } },
    ] },
    /* 你点了「引导会话」：上一回合就地收住，这一回合接着你刚说的话做 */
    steer: { events: [
      { think: 1600 },
      { tool: { verb: '读', text: '`server/src/later-send-recover.ts`' }, ms: 1000 },
      { text: '收到，按你刚说的来。刚才那一步我先放下了，做到一半的改动没有提交。' },
      { tool: TEST, ms: 2200 },
      { text: `调整完了，回归 ${cur.test.pass} 条全部通过。` },
      { end: { turn: 12400, files: 0, add: 4, del: 1, ctx: 1 } },
    ] },
    /* 审查没通过、这一趟还没到头：意见直接交给执行者，没有你的气泡；回合头名字后面写着它是照哪一轮的意见改 */
    fix: { events: [
      { think: 1400 },
      { tool: { verb: '读', text: '`server/scripts/test-later-send-recover.ts`' }, ms: 1000 },
      { tool: { verb: '改', text: '`server/scripts/test-later-send-recover.ts`' }, ms: 1200 },
      { tool: TEST, ms: 2600 },
      { text: `补上了「连着重启两次」这一种，回归 ${cur.test.pass + 1} 条全部通过。` },
      { end: { turn: 15200, files: 0, add: 21, del: 0, ctx: 2 } },
    ] },
  };
  const PREP = { 'run-1': 'run', 'run-2': 'run', 'run-3': 'run', 'run-4': 'run', 'run-5': 'run', 'run-6': 'run', 'run-7': 'ask', 'run-8': 'fail' };
  ASH.liveScripts = { SCRIPTS, PREP };
})();
