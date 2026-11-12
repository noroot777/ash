/* 样机的数据，全是编的：任务清单，和当前这个任务的事实。排在 kit.js 后面、其余脚本前面加载。
   会话流、右侧面板、改动工作区、执行模拟说的是同一个任务，所以它的标题、分支、提交、改动、用量只写在这里，别处一律来取。 */
(() => {
  /* 当前任务的一段经过：三段执行、三轮审查。时间都落在同一天 */
  const cur = {
    req: '定了时的回复，到点的时候 ash 没开着，再打开以后它就一直挂在「待发送」里不发。重新打开时应该把过了点的补发出去，并在那条消息上标一句「补发」，看得出它晚了多久。',
    created: '11/09 14:12',
    branch: 'ash/Lm4tQx8w',
    dir: '.worktrees/Lm4tQx8wRk2Z',
    target: 'main',
    session: '5e7a91c4',
    /* 执行器的名字和设置页那几个是同一批；model 是回复框胶囊后两段此刻的值 */
    exec: { claude: 'claude@local', codex: 'codex@local' },
    model: 'opus-5-5 · high',
    /* 它挂哨兵盯的那条回归 */
    test: { title: '定时发送回归测试', name: '定时发送的回归测试', cmd: 'npm -w server run test:later-send', pass: 17 },
    /* 改动：[文件, 目录, 增, 删]；later 是再跑几轮时新碰到的文件 */
    changed: [['test-later-send-recover.ts', 'server/scripts', 96, 0], ['later-send-recover.ts', 'server/src', 58, 0], ['later-send.ts', 'server/src', 31, 12],
      ['later-send-store.ts', 'server/src', 14, 6], ['LaterRow.tsx', 'web/src/reply', 9, 2], ['later-send.ts', 'shared/src', 6, 1], ['index.ts', 'server/src', 5, 0]],
    later: [['later-send.md', 'docs'], ['later-send-copy.ts', 'web/src/reply'], ['README.md', 'server']],
    /* 提交：新的在前，[短号, 说明, 时刻] */
    commits: [['9d2f6a1', '时间回拨后不重复补发', '15:15'], ['4c81e0d', '撤回的定时消息不再补发', '15:12'],
      ['e58b0c2', '补发只发一次，写进记录，按原定时间排序', '14:46'], ['a3e17c5', '启动时补发过了点的定时消息', '14:20']],
    /* 用量：一个执行器一行；turn 是最近跑完的那一轮；remain 是上下文还剩百分之几 */
    use: { claude: { tokens: 21.4e6, wakes: 4 }, codex: { tokens: 9.8e6, wakes: 3 } },
    turn: 356000,
    elapsed: 5280000,
    remain: 58,
    asks: [['11/09 15:09', '两条都改。改完跑一遍定时发送的回归。']],
  };

  /* 改动的账：右侧信息格那一行、改动格的清单、改动工作区看的是同一份（ASH.changes），变了就挨个叫 subs。
     一轮跑完报来的是总数（usage）：多出来的文件添成新行，多出来的增删记到新行（没有新文件就记到头一行）上；
     带 commit { hash, text, squash? } 时记一笔提交，squash 是它合掉了前面几个。同一轮报两遍只记一次 */
  const changes = ASH.changes = {
    rows: cur.changed.map(([name, dir, add, del]) => ({ name, dir, add, del })),
    commits: cur.commits.map(([hash, text, at]) => ({ hash, text, at })),
    subs: [],
    sum: (key) => changes.rows.reduce((n, r) => n + r[key], 0),
  };
  const told = new Set();
  ASH.on('usage', (u = {}) => {
    const key = [u.turn, u.elapsedMs, u.files, u.add, u.del].join('|');
    if (told.has(key)) return;
    told.add(key);
    const dAdd = u.add == null ? 0 : u.add - changes.sum('add');
    const dDel = u.del == null ? 0 : u.del - changes.sum('del');
    const fresh = [];
    for (let n = changes.rows.length; u.files != null && n < u.files && cur.later[n - cur.changed.length]; n += 1) {
      const [name, dir] = cur.later[n - cur.changed.length];
      fresh.push({ name, dir, add: 0, del: 0, fresh: true });
    }
    changes.rows.push(...fresh);
    const into = fresh[0] ?? changes.rows[0];
    into.add = Math.max(0, into.add + dAdd);
    into.del = Math.max(0, into.del + dDel);
    const commit = u.commit && !changes.commits.some((k) => k.hash === u.commit.hash) ? u.commit : null;
    if (commit) { changes.commits.splice(0, commit.squash ?? 0); changes.commits.unshift({ hash: commit.hash, text: commit.text, at: '刚刚' }); }
    if (fresh.length || dAdd || dDel || commit) for (const fn of [...changes.subs]) fn();
  });

  /* 任务：status 有 running / waiting / paused（它自己停下来，多半是在等哨兵；只有跑起来才到得了）/ failed / queued / done / stopped / backlog（待排期，只有手动设得到）；read、accepted 只对结束了的任务有意义。
     accepted: false = 做完了还没验收（真实产品里是一颗一直在的靛蓝环，算进「需要你处理」）。
     why 是行尾那句短话（定长的词）；detail 是悬停时多给的那半句 */
  ASH.data = {
    project: 'harness',
    sendKey: 'enter',          /* 设置里的「发送键」：enter / mod-enter。改它走 ASH.setSendKey，读它的地方听 sendkey:change */
    current: 't-cur',
    cur,
    /* 审查者：设置页那一页存的、派审时选的是同一批 */
    judges: [{ name: '逻辑从严', who: { agent: 'codex', model: 'gpt-5.5', level: 'xhigh' } }, { name: '前端走查', who: { agent: 'claude', model: 'opus-5-5', level: 'high' } }],
    tasks: [
      { id: 't-run', title: '斜杠补全：已有正文后面敲 / 也弹', status: 'running', agent: 'claude', when: '刚刚' },
      { id: 't-ask', title: '合并移动端轮询', status: 'waiting', why: '等你答复', agent: 'codex', when: '6 分钟前' },
      { id: 't-rev', title: '验收闸：失败后重跑的例外', status: 'waiting', why: '等你裁定', detail: '审查打回 2 条', agent: 'claude', when: '18 分钟前' },
      { id: 't-cur', title: '定时消息过了点没有补发', status: 'done', read: true, accepted: false, agent: 'claude', origin: 'Claude 派生', when: '31 分钟前' },
      { id: 't-fail', title: '回复框：原生命令的回车被吞掉', status: 'failed', agent: 'claude', origin: 'Claude 派生', when: '1 小时前' },
      { id: 't-q', title: '导出周报', status: 'queued', agent: 'codex', when: '1 小时前' },
      { id: 't-new', title: '侧栏宽度记不住', status: 'done', read: false, accepted: true, agent: 'claude', when: '2 小时前' },
      { id: 't-d1', title: '起手式站点线的站名放大', status: 'done', read: true, accepted: true, agent: 'claude', when: '昨天' },
      { id: 't-d2', title: 'worktree 被删后任务卡在运行中', status: 'done', read: true, accepted: true, agent: 'codex', when: '昨天' },
      { id: 't-d3', title: '同仓库 git 写操作排队', status: 'done', read: true, accepted: true, agent: 'claude', when: '11/09', pinned: true },
      { id: 't-d4', title: '团队执行者的审查默认开启', status: 'done', read: true, accepted: true, agent: 'claude', kind: 'team', when: '11/09' },
      { id: 't-x', title: '命令面板里搜任务正文', status: 'stopped', agent: 'codex', when: '11/09' },
      { id: 't-d5', title: '压缩失败时换上游重发', status: 'done', read: true, accepted: true, agent: 'claude', when: '11/08' },
    ],
  };
  ASH.setSendKey = (mode) => { if (ASH.data.sendKey === mode) return; ASH.data.sendKey = mode; ASH.emit('sendkey:change', mode); };
  ASH.clock = () => new Date().toTimeString().slice(0, 5);
})();
