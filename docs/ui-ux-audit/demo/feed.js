/* 会话流（部件 feed）：静态的一段会话 + 滚动钮 + 输入导航 + 提问坞。
   造回合、气泡、系统行、执行过程的那几个函数挂在 ASH.feedKit 上，执行中的模拟（live.js）用的是同一套。
   结构和文案照 web/src/task-detail 的 ConversationFeed / SystemNotice / ReviewerLane / QuestionCard；和现状不一样的只有清单 feed-1 到 feed-14。
   原始需求不在会话里出气泡（照现状，它住在右侧「信息」格）；输入导航的第一格是它，点了回到会话顶端。
   对外：ASH.parts.feed = { el, dock, follow(), pin(), stuck, append(...nodes), ask({ q, options, onanswer, instant }), unask(then?), destroy() }。
   unask(then)：提问卡沉下去，会话同一拍落回；then 里追加的东西（答复、新的一回合）并在这一段里一起走。
   append 进来的节点记在 ASH.feedKit.kept 里：切到别的面再回来，跑过的那几轮还在。 */
(() => {
  const { h, $, $$, icon } = ASH;
  ASH.icons.elbow = '<path d="M4 3v5a2 2 0 0 0 2 2h6.5M10 7.5l2.5 2.5-2.5 2.5"/>';
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  /* 行内只认两样：`代码` 和 **着重** */
  const fmt = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const plain = (s) => s.replace(/[`*]/g, '');
  const rt = (text) => text && h('time.rt', text);
  /* 点开 / 收起一块：高度一帧到位（会话流里不做高度动画，贴底才不会跟它抢），内容淡入；收起先淡出 120ms 再撤掉。
     点开的是一串步骤时，前六步隔 45ms 依次出现，其余的跟第六步一起到——整段不超过 400ms */
  const reveal = (box, open) => {
    clearTimeout(box._shut);
    box.classList.remove('is-shutting');
    if (open) {
      if (box.classList.contains('steps')) [...box.children].forEach((row, i) => row.style.setProperty('--i', Math.min(i, 5)));
      box.hidden = false;
    } else if (!box.hidden) { box.classList.add('is-shutting'); box._shut = setTimeout(() => { box.hidden = true; box.classList.remove('is-shutting'); }, ASH.reduced() ? 0 : 120); }
  };
  const unfold = (btn, box) => { const open = btn.getAttribute('aria-expanded') !== 'true'; btn.setAttribute('aria-expanded', String(open)); reveal(box, open); };

  const kit = (ASH.feedKit = { fmt, kept: [], changed: null });

  /* 复制：图标换成勾，1.2 秒后换回来 */
  const copyBtn = (label, read) => {
    const btn = h('button.ico.sm', { type: 'button', 'aria-label': label, 'data-tip': label, onclick: () => {
      try { navigator.clipboard?.writeText(read())?.catch(() => {}); } catch { /* file:// 下可能没有剪贴板 */ }
      btn.replaceChildren(icon('check'));
      btn.classList.add('is-done');
      clearTimeout(btn._done);
      btn._done = setTimeout(() => { btn.replaceChildren(icon('copy')); btn.classList.remove('is-done'); }, 1200);
    } }, icon('copy'));
    return btn;
  };
  /* 删除一条消息：回不去，先确认（话照 MessageDelete.tsx） */
  const drop = async (el) => {
    const yes = await ASH.confirm({ title: '删除这条消息？', ok: '删除', danger: true,
      body: '删除后无法恢复，智能体之后也读不到它：下一轮会换一条新的会话，只带着删除后留下的记录继续。' });
    if (!yes) return;
    el.classList.add('is-gone');
    setTimeout(() => { el.remove(); kit.kept = kit.kept.filter((node) => node !== el); kit.changed?.(); }, ASH.reduced() ? 0 : 120);
  };

  /* 系统行、自动输入、答复行尾上的小动作：和回合尾一个规矩，指到这一行（或键盘走到它）才出 */
  const delBtn = (row) => h('button.ico.sm', { type: 'button', 'aria-label': '删除这条消息', 'data-tip': '删除', onclick: () => drop(row()) }, icon('trash'));
  const rowActs = (...btns) => h('span.row-acts', btns);

  /* 你发的话：泡里一行「你 · 时间」，复制和删除指到才出（照现状） */
  kit.user = (text, time) => {
    const row = h('div.bubble-row', { 'data-user': '' });
    row.append(h('div.bubble',
      h('header', h('b', '你'), time && h('time', time), copyBtn('复制这条回复', () => text),
        h('button.ico.sm', { type: 'button', 'aria-label': '删除这条消息', 'data-tip': '删除', onclick: () => drop(row) }, icon('trash'))),
      h('p', text)));
    return row;
  };

  /* 回合：头上只有名字，模型、智能水平、时间、用时悬停才给；尾上的操作同样悬停才出。reply = 这一回合是在回一次自动输入 */
  kit.turn = ({ agent = ASH.data.cur.exec[ASH.data.tasks.find((t) => t.id === ASH.data.current)?.agent] ?? ASH.data.cur.exec.claude, meta, reply } = {}) => {
    const head = h('header.turn-head', h('b', agent), rt(meta));
    const body = h('div.turn-body', reply && h('p.turn-ref', icon('elbow'), reply === true ? '回复这次自动输入' : reply));
    const el = h('article.turn', h('span.turn-av', { 'aria-hidden': 'true' }, agent[0].toUpperCase()), head, body);
    const more = h('button.ico.sm', { type: 'button', 'aria-label': '更多', 'aria-haspopup': 'menu', 'data-tip': '更多',
      onclick: () => ASH.menu(more, [{ label: '删除这条回复', icon: 'trash', onpick: () => drop(el) }]) }, icon('more'));
    const acts = h('footer.turn-acts',
      copyBtn('复制这条回复', () => $$(':scope > .md', body).map((md) => md.innerText).join('\n\n')),
      h('button.ico.sm', { type: 'button', 'aria-label': '派生新任务', 'data-tip': '派生新任务', onclick: () => ASH.go('#/new') }, icon('fork')), more);
    el.append(acts);
    return { el, head, body, acts, setMeta(text) { $('.rt', head)?.remove(); head.append(rt(text)); } };
  };

  /* 一步：一句人话（动词 + 对象）。点开是「字段 值」，原始参数再折一层 */
  const VERB_ICON = { 读: 'file', 搜: 'search', 改: 'edit', 写: 'edit', 跑: 'term', 看网页: 'globe', 派: 'bot' };
  const VERB_FIELD = { 读: '文件', 搜: '查找', 改: '文件', 写: '文件', 跑: '命令', 看网页: '网址', 派: '任务' };
  const RAW_KEY = { 文件: 'file_path', 行: 'lines', 查找: 'pattern', 范围: 'path', 命令: 'command', 目录: 'cwd', 时限: 'timeout', 网址: 'url', 任务: 'prompt' };
  kit.step = ({ verb, text, fields, raw }) => {
    const pairs = Object.entries(fields ?? { [VERB_FIELD[verb] ?? '内容']: plain(text) });
    const rawBtn = h('button.sys-more', { type: 'button', 'aria-expanded': 'false', onclick: () => unfold(rawBtn, pre) }, '原始参数');
    const pre = h('pre', { hidden: true }, raw ?? JSON.stringify(Object.fromEntries(pairs.map(([k, v]) => [RAW_KEY[k] ?? k, v])), null, 2));
    const more = h('div.step-more', { hidden: true }, h('dl.kv', pairs.flatMap(([k, v]) => [h('dt', k), h('dd', h('code.cut', v))])), rawBtn, pre);
    const btn = h('button', { type: 'button', 'aria-expanded': 'false', onclick: () => unfold(btn, more) }, icon(VERB_ICON[verb] ?? 'tool'), h('span', { html: `${verb} ${fmt(text)}` }));
    return h('div.step', btn, more);
  };

  /* 执行过程：收着是一句摘要，点开是一步一行。里面还没有东西时不能点，折角也不画（位置留着，字不会左右跳） */
  kit.fold = (summary, steps = [], { time } = {}) => {
    const label = h('span.fold-label', summary);
    const list = h('div.steps', { hidden: true });
    const btn = h('button.fold', { type: 'button', 'aria-expanded': 'false', onclick: () => api.toggle() }, icon('chev'), label, rt(time));
    const sync = () => {
      const flat = !list.childElementCount;
      btn.classList.toggle('is-flat', flat);
      btn.tabIndex = flat ? -1 : 0;
      if (flat) api.toggle(false);
    };
    const api = {
      btn, list, label,
      get open() { return btn.getAttribute('aria-expanded') === 'true'; },
      toggle(open = !api.open) { open &&= list.childElementCount > 0; btn.setAttribute('aria-expanded', String(open)); reveal(list, open); },
      /* 摊开着的时候，新来的一步淡进来 */
      add(step) { const row = kit.step(step); if (api.open) row.classList.add('enter'); list.append(row); sync(); return row; },
      put(...nodes) { list.append(...nodes); sync(); },
    };
    list.append(...steps.map(kit.step));
    sync();
    return api;
  };

  /* 系统行：图标落在头像轴上。tone 是 ok / warn / bad / 空；log 是点开「N 条记录」后的明细；时间排在这一行所有东西的后面 */
  const TONE_ICON = { ok: 'check', warn: 'warn', bad: 'warn' };
  kit.sys = ({ tone = '', glyph, text, more, log, time }) => {
    const logEl = log && h('ul.sys-log', { hidden: true }, log.map(([line, at]) => h('li', h('span', { html: fmt(line) }), at && h('time', at))));
    const moreEl = logEl && h('button.sys-more', { type: 'button', 'aria-expanded': 'false', onclick: () => unfold(moreEl, logEl) }, more);
    const row = h(`div.sys${tone ? `.${tone}` : ''}`, h('span.sys-ic', icon(glyph ?? TONE_ICON[tone] ?? 'info')),
      h('div.sys-line', h('span', { html: fmt(text) }), moreEl, rt(time), rowActs(delBtn(() => row))), logEl);
    return row;
  };

  /* 「ash 自动输入」：还在你这一侧，只是一行灰字；内容点了再看。这一行靠右，所以时间排在字的前面，字才贴得住右边 */
  kit.auto = ({ text, from, lines = [], time }) => {
    const body = h('div.auto-body', { hidden: true },
      h('dl.kv', h('dt', '来自哨兵'), h('dd', from), h('dt', '写入会话'), h('dd', `${lines.length} 条消息 → 1 次输入`)),
      h('pre', lines.join('\n')));
    const more = h('button.sys-more', { type: 'button', 'aria-expanded': 'false', onclick: () => unfold(more, body) }, '查看内容');
    const row = h('div.auto', h('p.auto-line', rowActs(copyBtn('复制这次自动输入', () => lines.join('\n')), delBtn(() => row)), rt(time), icon('pulse'), h('span', `${text} · ${from}`), more), body);
    return row;
  };

  /* 审查轮：一行——第几轮、结论、谁审的、用时、看报告。颜色只从结论来（通过绿、未通过红），和右侧审查格是同一张表；
     「看报告」在右侧审查格里就地展开那一轮。还在审的时候 r.ok 是 undefined：结论那一格写「审查中」带流光，出了结论调 row.settle(r) 原地落定 */
  const VERDICT = { true: ['ok', '已通过'], false: ['bad', '未通过'] };
  kit.rev = (r) => {
    const chip = h('span.rev-chip');
    const who = h('span');
    const report = h('button.link', { type: 'button', onclick: () => ASH.emit('insp:open', { pane: 'review', round: r.n }) }, '看报告');
    const time = h('time.rt');
    const head = h('div.rev-head', h('b', `第 ${r.n} 轮审查`), chip, who, report, time);
    const row = h('div.rev', h('span.sys-ic', icon('shield')), h('div.rev-main', head));
    const paint = (now, soft) => {
      const done = now.ok != null;
      const [tone, verdict] = done ? VERDICT[now.ok] : ['', '审查中'];
      row.className = `rev${tone ? ` ${tone}` : ' is-live'}`;
      chip.classList.toggle('shim', !done);
      const tail = done ? `${now.by} · ${now.took}` : now.by;
      if (soft) { ASH.swap(chip, verdict, { row: head }); ASH.swap(who, tail, { row: head }); } else { chip.textContent = verdict; who.textContent = tail; }
      report.hidden = !done;
      if (done && soft) report.classList.add('enter');
      time.textContent = done ? now.time ?? '' : '';
    };
    row.settle = (now) => paint(now, true);
    paint(r, false);
    return row;
  };

  /* 答过的提问：一行「你的答复」加答案，问的是什么点开再看 */
  kit.answer = ({ q, options = [], text, time }) => {
    const picked = text.split('\n');
    const body = h('div.qa-body', { hidden: true }, h('p', q),
      options.length > 0 && h('ul', { 'aria-label': '当时的选项' }, options.map((o) => h(`li${picked.includes(o) ? '.on' : ''}`, o))));
    const more = h('button.sys-more', { type: 'button', 'aria-expanded': 'false', onclick: () => unfold(more, body) }, '查看问答');
    const row = h('div.qa', h('span.sys-ic', icon('check')),
      h('div.qa-main', h('div.sys-line', h('b', '你的答复'), more, rt(time), rowActs(copyBtn('复制答案', () => text), delBtn(() => row))), h('p.qa-text', text), body));
    return row;
  };

  /* 这一段会话和右侧「工作流」「审查」两格讲的是同一段经过：三段执行、三轮审查（任务的事实在 ASH.data.cur，轮次的账在 ASH.review） */
  const SESSION = () => {
    const { model, test, commits } = ASH.data.cur;
    const rev = (n) => kit.rev(ASH.review.rounds[n - 1]);
    const run = { verb: '跑', text: test.name, fields: { 命令: test.cmd, 目录: 'server', 时限: '10 分钟' } };
    const a = kit.turn({ meta: `${model} · 11/09 14:14 · 6m 12s` });
    const foldA = kit.fold('读了 3 个文件，搜了 1 次，改了 2 个文件，另有 1 步', [
      { verb: '读', text: '`server/src/later-send.ts`' },
      { verb: '搜', text: '「setTimeout」于 `server/src`', fields: { 查找: 'setTimeout', 范围: 'server/src' } },
      { verb: '读', text: '`server/src/later-send-store.ts` 第 22–96 行', fields: { 文件: 'server/src/later-send-store.ts', 行: '22–96' } },
      { verb: '读', text: '`server/src/index.ts`' },
      { verb: '写', text: '`server/src/later-send-recover.ts`' },
      { verb: '写', text: '`server/scripts/test-later-send-recover.ts`' },
      { ...run, raw: `{\n  "command": "${test.cmd}",\n  "description": "${test.name}",\n  "timeout": 600000\n}` },
    ], { time: '6m 12s' });
    a.body.append(foldA.btn, foldA.list, h('div.md', { html: `
      <p>找到原因了：到点那一下靠的是内存里的定时器，服务没开着就没有人触发；重新启动时也不会回头看有没有过了点的。</p>
      <p>改了两处：启动时把过了点的捡出来补发；补发的那条带上「补发」和它晚了多久。补了一条回归。</p>` }));

    const a2 = kit.turn({ meta: `${model} · 11/09 14:41 · 5m 15s`, reply: '回复第 1 轮审查的意见' });
    const foldA2 = kit.fold('读了 2 个文件，改了 3 个，跑了 1 条命令', [
      { verb: '读', text: '`server/src/later-send-recover.ts`' },
      { verb: '读', text: '`server/src/later-send.ts` 第 40–112 行', fields: { 文件: 'server/src/later-send.ts', 行: '40–112' } },
      { verb: '改', text: '`server/src/later-send.ts`' },
      { verb: '改', text: '`server/src/later-send-recover.ts`' },
      { verb: '改', text: '`server/scripts/test-later-send-recover.ts`' },
      run,
    ], { time: '5m 15s' });
    a2.body.append(foldA2.btn, foldA2.list, h('div.md', { html: `
      <p>三条意见都改了：补发和到点共用一把锁，一条消息只发一次；补发写进记录，带着原定的时间；过了点的几条按原定时间的先后发，补了回归。</p>` }));

    const a3 = kit.turn({ meta: `${model} · 11/09 15:09 · 7m 2s` });
    const foldA3 = kit.fold('读了 1 个文件，改了 3 个，跑了 3 条命令', [
      { verb: '读', text: '`server/src/later-send-store.ts` 第 22–96 行', fields: { 文件: 'server/src/later-send-store.ts', 行: '22–96' } },
      { verb: '改', text: '`server/src/later-send-store.ts`' },
      { verb: '改', text: '`server/src/later-send-recover.ts`' },
      { verb: '改', text: '`server/scripts/test-later-send-recover.ts`' },
      { verb: '跑', text: '`git commit`', fields: { 命令: `git commit -m "${commits[1][1]}"`, 目录: '.' } },
      { verb: '跑', text: '`git commit`', fields: { 命令: `git commit -m "${commits[0][1]}"`, 目录: '.' } },
      { verb: '跑', text: `挂一个哨兵盯${test.name}`, fields: { 命令: test.cmd, 目录: 'server', 时限: '15 分钟' } },
    ], { time: '7m 2s' });
    a3.body.append(foldA3.btn, foldA3.list, h('div.md', { html: `
      <p>两条都改了，各补了一个测试用例。回归要跑十来分钟，我挂了一个哨兵盯着，跑完会叫醒我；这一轮先停在这里。</p>` }));

    const b = kit.turn({ meta: `${model} · 11/09 15:28 · 20s`, reply: true });
    const foldB = kit.fold('读了 2 个文件，跑了 1 条命令', [
      { verb: '读', text: '`server/src/later-send-recover.ts` 第 18–74 行', fields: { 文件: 'server/src/later-send-recover.ts', 行: '18–74' } },
      { verb: '读', text: '`server/scripts/test-later-send-recover.ts`' },
      { verb: '跑', text: '`git log -2 --stat`', fields: { 命令: 'git log -2 --stat', 目录: '.' } },
    ], { time: '20s' });
    b.body.append(foldB.btn, foldB.list, h('div.md', { html: `
      <p>第 2 轮审查的两条都修好了，分别提交为 <code>${commits[1][0]}</code> 和 <code>${commits[0][0]}</code>。登记的回归跑完，退出码 0。</p>
      <ol>
        <li><strong>撤回了的定时消息，重启后还会被补发</strong>：以前补发只看「过没过点」。现在先看这条还在不在待发送里，撤回的直接跳过。</li>
        <li><strong>系统时间往回拨以后，同一条被补发两次</strong>：以前拿当前时间和原定时间比，时间一回拨就又算「过了点」。现在补发过的会记一笔，再遇到就不发。</li>
      </ol>
      <p>两个场景各加了一个测试用例。临时撤掉对应的修复，用例会失败；恢复后全部通过。</p>
      <p>这次只动了服务端和一行界面文案，没有碰数据库结构。</p>` }));

    const autoRow = kit.auto({ text: '收到 2 条哨兵消息，合并为一次输入', from: test.title, time: '11/09 15:28',
      lines: [`[输出] ${test.pass} passed, 0 failed (11m 42s)`, '[结束] 命令退出，退出码 0'] });
    const doneRow = kit.sys({ glyph: 'pulse', text: `不再等「${test.title}」了，它已经跑完`, more: '查看完整内容', time: '11/09 15:28', log: [['理由：结果已经收到，退出码 0', '']] });
    const rev3 = rev(3);
    return {
      a, foldA, b, foldB, autoRow, doneRow, rev3,
      nodes: [
        a.el, rev(1), a2.el, rev(2),
        kit.user(ASH.data.cur.asks[0][1], ASH.data.cur.asks[0][0]),
        a3.el,
        kit.sys({ glyph: 'clock', text: '审查还没开始：任务暂停着，跑完这一轮自动开审', more: '5 条记录', time: '11/09 15:28',
          log: [['第 2 轮审查没通过，意见已交给执行者', '15:07'], ['开始修复', '15:09'], [`开始盯：${test.title}`, '15:16'], ['任务暂停，等回归结果', '15:16'], ['审查已预约，这一轮跑完自动开始', '15:17']] }),
        autoRow, b.el, doneRow, rev3,
      ],
    };
  };

  ASH.part('feed', {
    mount(wrap, { dock }) {
      const feed = h('div.feed', { tabindex: '0', role: 'log', 'aria-label': '会话' });
      const s = SESSION();
      feed.append(...s.nodes, ...kit.kept);
      const top = h('button.scroll-btn.top.is-hidden.is-idle', { type: 'button', tabindex: '-1', 'aria-label': '滚动到会话顶部', 'data-m': 'feed-4' }, icon('up'));
      const bottom = h('button.scroll-btn.bottom.is-hidden', { type: 'button', tabindex: '-1', 'aria-label': '滚动到会话底部' }, icon('down'));
      const rail = h('nav.feed-rail', { 'aria-label': '你发过的话', 'data-m': 'feed-9' });
      wrap.append(feed, top, bottom, rail);

      /* 贴底：离底 80px 以内算贴着；内容变了就瞬移到底（平滑滚动会掐断滚轮的惯性） */
      let stuck = true;
      let gliding = false;   /* 提问卡正带着会话往上走：这一段不重新判「贴没贴底」 */
      const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 80;
      const toBottom = () => { if (stuck && !gliding) feed.scrollTop = feed.scrollHeight; };
      const follow = toBottom;

      /* 回顶钮只认「你自己在滚」：滚轮、触摸、翻页键 800ms 内的 scroll 才算；停 1 秒淡出 */
      let intentUntil = 0;
      let idle = 0;
      const intent = () => { intentUntil = performance.now() + 800; };
      feed.addEventListener('wheel', intent, { passive: true });
      feed.addEventListener('touchmove', intent, { passive: true });
      feed.addEventListener('keydown', (e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) intent(); });
      const rest = () => { if (top.matches(':hover, :focus-visible')) idle = setTimeout(rest, 400); else top.classList.add('is-idle'); };
      feed.addEventListener('scroll', () => {
        if (gliding) return;
        stuck = nearBottom();
        top.classList.toggle('is-hidden', feed.scrollTop <= 80);
        bottom.classList.toggle('is-hidden', stuck);
        bottom.tabIndex = stuck ? -1 : 0;   /* 看不见的时候不在 Tab 的路上；回顶钮只跟着滚动出没，键盘用 Home */
        if (performance.now() < intentUntil) { top.classList.remove('is-idle'); clearTimeout(idle); idle = setTimeout(rest, 1000); }
        paintRail();
      });
      /* 贴着底的时候你点开、收起了哪一块：到它收完（收起要先淡出 120ms）为止每一帧都贴一次底，底下那一行不会被顶出去。没贴底就什么都不动 */
      feed.addEventListener('click', (e) => {
        if (!stuck || !e.target.closest('.fold, .step > button, .sys-more')) return;
        const until = performance.now() + 180;
        const keep = () => { feed.scrollTop = feed.scrollHeight; if (performance.now() < until) requestAnimationFrame(keep); };
        requestAnimationFrame(keep);
      });
      /* 会话区自己变了大小（开关面板和清单、回复框长高、提问卡落位）：贴着底的继续贴着 */
      const sizes = new ResizeObserver(() => { toBottom(); paintRail(); });
      sizes.observe(feed);
      top.addEventListener('click', () => { intent(); feed.scrollTo({ top: 0, behavior: ASH.reduced() ? 'auto' : 'smooth' }); });
      bottom.addEventListener('click', () => { stuck = true; feed.scrollTo({ top: feed.scrollHeight, behavior: ASH.reduced() ? 'auto' : 'smooth' }); });

      /* 输入导航：一条刻度是你发过的一句话。第一格是原始需求（它不在会话里出气泡），点了回到会话顶端 */
      const users = () => $$('[data-user]', feed);
      const said = (row) => $('.bubble > p', row).textContent;
      const glideTo = (top) => feed.scrollTo({ top, behavior: ASH.reduced() ? 'auto' : 'smooth' });
      const jump = (row) => {
        ASH.closePop();
        if (!row) { intent(); glideTo(0); return; }
        row.scrollIntoView({ block: 'center', behavior: ASH.reduced() ? 'auto' : 'smooth' });
        const b = $('.bubble', row); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
      };
      const stops = () => [[null, ASH.data.cur.req, ASH.data.cur.created], ...users().map((row) => [row, said(row), $('time', row)?.textContent ?? ''])];
      const buildRail = () => { rail.replaceChildren(...stops().map(([row, text], i) => h('button', { type: 'button', 'aria-label': row ? `第 ${i} 条追问` : '原始需求', 'data-tip': text.slice(0, 44), 'data-key': 'Q', 'data-tip-side': 'right', onclick: () => jump(row) }))); paintRail(); };
      function paintRail() {
        const box = feed.getBoundingClientRect();
        const line = box.top + box.height / 3;
        const at = users().reduce((best, row, i) => { const y = row.getBoundingClientRect().top; return y <= line || (stuck && y < box.bottom) ? i + 1 : best; }, 0);
        [...rail.children].forEach((tick, i) => tick.classList.toggle('on', i === at));
      }
      const openList = () => ASH.pop(rail, h('div.rail-list', stops().map(([row, text, at]) => h('button', { type: 'button', onclick: () => jump(row) }, h('span.cut', text), h('time', at)))), { place: 'bottom-start' })?.el.querySelector('button')?.focus();
      const onKey = (e) => { if (e.key.toLowerCase() === 'q' && !e.metaKey && !e.ctrlKey && !e.altKey && !ASH.sheetOpen() && !e.target.closest('input, textarea, [contenteditable]')) { e.preventDefault(); openList(); } };
      addEventListener('keydown', onKey);
      kit.changed = buildRail;

      /* 提问坞：卡片落定后住在会话下面、滚动区外面。进场时先浮在会话区底缘，从下面升上来，
         同一段时间里会话跟着往上让出它的高度——两样都不改布局，所以滑得动 */
      let card = null;
      const RISE = 320;   /* 和 --dur-3 同值 */
      const pad = () => parseFloat(getComputedStyle(feed).paddingBottom);
      /* 卡浮在会话区底缘走一段：from → to 是它往下挪了多少；会话的 scrollTop 同一条曲线从 a 走到 b。只改 transform 和 scrollTop */
      const travel = (el, from, to, a, b, done) => {
        const t0 = performance.now();
        gliding = true;
        el._land = () => { el._land = null; el.style.transform = ''; gliding = false; done(); };
        const frame = (now) => {
          if (!el._land) return;
          const k = Math.max(0, Math.min(1, (now - t0) / RISE));
          const eased = 1 - (1 - k) ** 3;
          el.style.transform = `translateY(${from + (to - from) * eased}px)`;
          if (a != null) feed.scrollTop = a + (b - a) * eased;
          if (k < 1) requestAnimationFrame(frame); else el._land();
        };
        el.style.transform = `translateY(${from}px)`;
        requestAnimationFrame(frame);
      };
      const rise = (el, instant) => {
        if (instant || ASH.reduced()) { dock.append(el); follow(); return; }
        const pinned = stuck;
        el.classList.add('is-rising');
        wrap.append(el);
        const lift = el.offsetHeight + parseFloat(getComputedStyle(el).marginBottom);
        const from = feed.scrollTop;
        if (pinned) feed.style.paddingBottom = `${pad() + lift}px`;
        travel(el, lift, 0, pinned ? from : null, from + lift, () => {
          el.classList.remove('is-rising');
          feed.style.paddingBottom = '';
          dock.append(el);
          if (pinned) { stuck = true; feed.scrollTop = feed.scrollHeight; }
        });
      };
      /* 撤卡是升起的镜像：同一帧把卡挪回会话区上的那一层、给会话垫上等高的下内边距（画面一个像素不动），
         then 里要追加的东西这时落进去；然后卡下沉、会话落回贴底，一段走完 */
      const unask = (then) => {
        const old = card;
        card = null;
        if (!old) { then?.(); return; }
        old._land?.();
        if (ASH.reduced() || !old.isConnected || old.parentElement !== dock) { old.remove(); then?.(); follow(); return; }
        const pinned = stuck;
        const lift = old.offsetHeight + parseFloat(getComputedStyle(old).marginBottom);
        const from = feed.scrollTop;
        old.classList.add('is-rising');
        wrap.append(old);
        if (pinned) feed.style.paddingBottom = `${pad() + lift}px`;
        gliding = true;
        then?.();
        const to = feed.scrollHeight - lift - feed.clientHeight;   /* 内边距撤掉以后的贴底位置 */
        travel(old, 0, lift, pinned ? from : null, to, () => {
          old.remove();
          feed.style.paddingBottom = '';
          if (pinned) { stuck = true; feed.scrollTop = feed.scrollHeight; }
        });
      };
      /* 提问卡，照 QuestionCard.tsx：选项可多选，选了就写进下面的答复框；数字键勾选；发送键发送。
         这些不另写一行说明：选项前那颗带数字的小方块就是「按这个键」，点一下它打上勾、字落进答复框就是「可多选、可改」；发送的键名在按钮的提示里 */
      const ask = ({ q, options = [], onanswer, instant }) => {
        unask();
        const input = h('textarea', { rows: '1', placeholder: options.length ? '补充或修改…' : '写下你的答案…', 'aria-label': `答复：${q}`, 'data-m': 'feed-12' });
        const sendBtn = h('button.btn.pri', { type: 'button', 'data-tip': '发送答复', onclick: () => send() }, icon('send'), '发送答复');
        const keys = options.map((o, i) => h('span.q-key', { 'aria-hidden': 'true' }, String(i + 1)));
        const opts = options.map((o, i) => h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => toggle(i) }, keys[i], h('span', o)));
        const paint = () => {
          const lines = input.value.split('\n');
          opts.forEach((btn, i) => { const on = lines.includes(options[i]); btn.setAttribute('aria-pressed', String(on)); keys[i].replaceChildren(on ? icon('check') : String(i + 1)); });
          sendBtn.disabled = !input.value.trim();
          sendBtn.dataset.key = ASH.sendKey.caps().send;
          input.style.height = 'auto';
          input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
          follow();
        };
        const toggle = (i) => { const lines = input.value.split('\n').filter(Boolean); input.value = (lines.includes(options[i]) ? lines.filter((line) => line !== options[i]) : [...lines, options[i]]).join('\n'); paint(); };
        const send = () => { const text = input.value.trim(); if (!text || card !== el) return; onanswer?.(text); };
        input.addEventListener('input', paint);
        input.addEventListener('keydown', (e) => { if (ASH.sendKey.hit(e)) { e.preventDefault(); send(); } });
        const fold = h('button.ico.sm', { type: 'button', 'aria-expanded': 'true', 'aria-label': '收起答复卡，先看上文', onclick: () => {
          const shut = el.classList.toggle('is-shut');
          fold.setAttribute('aria-expanded', String(!shut));
          fold.setAttribute('aria-label', shut ? '展开答复卡' : '收起答复卡，先看上文');
          follow();
        } }, icon('caret'));
        const el = h('section.qcard', { 'aria-label': '等待答复的问题', 'data-m': 'run-7' },
          h('header', { 'data-m': 'feed-14' }, icon('help'), h('b.grow', '需要你的答复'), fold),
          h('div.q-body', h('p.q-title', q),
            options.length > 0 && h('div.opts', { role: 'group', 'aria-label': `${q}的建议答案，可多选` }, opts), input),
          h('footer', sendBtn));
        el.addEventListener('keydown', (e) => {
          const n = Number(e.key) - 1;
          if (e.target === input || e.metaKey || e.ctrlKey || e.altKey || !Number.isInteger(n) || n < 0 || n >= options.length) return;
          e.preventDefault();
          toggle(n);
        });
        card = el;
        sendBtn.disabled = true;
        sendBtn.dataset.key = ASH.sendKey.caps().send;
        rise(el, instant);
        return el;
      };

      /* 认领清单条目 */
      const { autoRow, doneRow, rev3 } = s;
      feed.dataset.m = 'feed-13';
      s.b.head.dataset.m = 'feed-1';
      s.b.acts.dataset.m = 'feed-2';
      s.foldB.btn.dataset.m = 'feed-8 a11y-2';
      $('.rt', doneRow).dataset.m = 'feed-3';
      doneRow.dataset.m = 'feed-5';
      s.foldA.list.dataset.m = 'feed-6';
      autoRow.firstElementChild.dataset.m = 'feed-7';
      rev3.dataset.m = 'feed-10';
      $('.rev-chip', rev3).dataset.m = 'a11y-4';
      /* 悬停才有的东西，点清单时亮 2.6 秒 */
      const peek = (...els) => { for (const el of els) { el.classList.add('is-shown'); setTimeout(() => el.classList.remove('is-shown'), 2600); } };
      ASH.prep['feed-1'] = () => peek($('.rt', s.b.head));
      ASH.prep['feed-2'] = () => peek(s.b.acts);
      ASH.prep['feed-3'] = () => peek(...$$('.sys .rt, .rev .rt, .auto .rt, .sys .row-acts, .auto .row-acts', feed));
      ASH.prep['feed-4'] = () => { feed.scrollTop = Math.max(120, feed.scrollTop - 60); top.classList.remove('is-hidden', 'is-idle'); clearTimeout(idle); idle = setTimeout(rest, 2600); };
      ASH.prep['feed-6'] = () => { s.foldA.toggle(true); const last = s.foldA.list.lastElementChild; if ($('.step-more', last).hidden) unfold($('button', last), $('.step-more', last)); };
      ASH.prep['feed-12'] = ASH.prep['feed-14'] = () => { if (!card) ask({ q: '回归里有一条用例依赖真实时钟，改成假时钟还是放宽断言？', options: ['改成假时钟', '把断言放宽到 ±1 秒'] }); };

      buildRail();
      requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; paintRail(); });
      return {
        el: feed, dock, follow, ask, unask,
        pin() { stuck = true; },
        get stuck() { return stuck; },
        append(...nodes) { feed.append(...nodes); kit.kept.push(...nodes); buildRail(); follow(); },
        destroy() {
          removeEventListener('keydown', onKey);
          sizes.disconnect();
          clearTimeout(idle);
          kit.changed = null;
          for (const id of ['feed-1', 'feed-2', 'feed-3', 'feed-4', 'feed-6', 'feed-12', 'feed-14']) delete ASH.prep[id];
        },
      };
    },
  });
})();
