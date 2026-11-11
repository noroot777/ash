/* 会话流（部件 feed）：静态的一段会话 + 滚动钮 + 输入导航 + 提问坞。
   造回合、气泡、系统行、执行过程的那几个函数挂在 ASH.feedKit 上，执行中的模拟（live.js）用的是同一套。
   结构和文案照 web/src/task-detail 的 ConversationFeed / SystemNotice / ReviewerLane / QuestionCard；和现状不一样的只有清单 feed-1 到 feed-12。
   对外：ASH.parts.feed = { el, dock, follow(), pin(), stuck, append(...nodes), ask({ q, options, onanswer, instant }), unask(), destroy() }。
   append 进来的节点记在 ASH.feedKit.kept 里：切到别的面再回来，跑过的那几轮还在。 */
(() => {
  const { h, $, $$, icon } = ASH;
  ASH.icons.elbow = '<path d="M4 3v5a2 2 0 0 0 2 2h6.5M10 7.5l2.5 2.5-2.5 2.5"/>';
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  /* 行内只认两样：`代码` 和 **着重** */
  const fmt = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const plain = (s) => s.replace(/[`*]/g, '');
  const rt = (text) => text && h('time.rt', text);
  /* 点开 / 收起一块：高度一帧到位（会话流里不做高度动画，贴底才不会跟它抢），内容淡入；收起先淡出 120ms 再撤掉 */
  const reveal = (box, open) => {
    clearTimeout(box._shut);
    box.classList.remove('is-shutting');
    if (open) box.hidden = false;
    else if (!box.hidden) { box.classList.add('is-shutting'); box._shut = setTimeout(() => { box.hidden = true; box.classList.remove('is-shutting'); }, ASH.reduced() ? 0 : 120); }
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
  kit.turn = ({ agent = 'claude@nodemach', meta, reply } = {}) => {
    const head = h('header.turn-head', h('b', agent), rt(meta));
    const body = h('div.turn-body', reply && h('p.turn-ref', icon('elbow'), '回复这次自动输入'));
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
    return h(`div.sys${tone ? `.${tone}` : ''}`, h('span.sys-ic', icon(glyph ?? TONE_ICON[tone] ?? 'info')),
      h('div.sys-line', h('span', { html: fmt(text) }), moreEl, rt(time)), logEl);
  };

  /* 「ash 自动输入」：还在你这一侧，只是一行灰字；内容点了再看。这一行靠右，所以时间排在字的前面，字才贴得住右边 */
  kit.auto = ({ text, from, lines = [], time }) => {
    const body = h('div.auto-body', { hidden: true },
      h('dl.kv', h('dt', '来自哨兵'), h('dd', from), h('dt', '写入会话'), h('dd', `${lines.length} 条消息 → 1 次输入`)),
      h('pre', lines.join('\n')));
    const more = h('button.sys-more', { type: 'button', 'aria-expanded': 'false', onclick: () => unfold(more, body) }, '查看内容');
    return h('div.auto', h('p.auto-line', rt(time), icon('pulse'), h('span', `${text} · ${from}`), more), body);
  };

  /* 审查轮：出了结论的就是一行。左边那条线和结论同色 */
  kit.rev = ({ tone, round, verdict, by, dur, time, notes }) => {
    const body = notes && h('ul.rev-body', { hidden: true }, notes.map((note) => h('li', note)));
    const more = body && h('button.sys-more', { type: 'button', 'aria-expanded': 'false', onclick: () => unfold(more, body) }, `${notes.length} 条意见`);
    const report = h('button.link', { type: 'button', onclick: () => ASH.emit('insp:open', { pane: 'review', round }) }, '看报告');
    return h(`div.rev.${tone}`, h('span.sys-ic', icon('shield')),
      h('div.rev-main', h('div.rev-head', h('b', `第 ${round} 轮审查`), h('span.rev-chip', verdict), h('span', `${by} · ${dur}`), more, report, rt(time)), body));
  };

  /* 答过的提问：一行「你的答复」加答案，问的是什么点开再看 */
  kit.answer = ({ q, options = [], text, time }) => {
    const picked = text.split('\n');
    const body = h('div.qa-body', { hidden: true }, h('p', q),
      options.length > 0 && h('ul', { 'aria-label': '当时的选项' }, options.map((o) => h(`li${picked.includes(o) ? '.on' : ''}`, o))));
    const more = h('button.sys-more', { type: 'button', 'aria-expanded': 'false', onclick: () => unfold(more, body) }, '查看问答');
    return h('div.qa', h('span.sys-ic', icon('check')),
      h('div.qa-main', h('div.sys-line', h('b', '你的答复'), more, rt(time)), h('p.qa-text', text), body));
  };

  const SESSION = () => {
    const a = kit.turn({ meta: 'claude-opus-5-5 · high · 11/10 21:36 · 6m 12s' });
    const foldA = kit.fold('读了 3 个文件，搜了 1 次，改了 2 个文件，另有 1 步', [
      { verb: '读', text: '`server/src/free-review-reservations.ts`' },
      { verb: '搜', text: '「reservation」于 `server/src`', fields: { 查找: 'reservation', 范围: 'server/src' } },
      { verb: '读', text: '`server/src/free-review-ruling.ts` 第 40–118 行', fields: { 文件: 'server/src/free-review-ruling.ts', 行: '40–118' } },
      { verb: '读', text: '`scripts/test-free-review-ruling.ts`' },
      { verb: '改', text: '`server/src/free-review-reservations.ts`' },
      { verb: '改', text: '`scripts/test-free-review-ruling.ts`' },
      { verb: '跑', text: '裁定闸的回归测试', fields: { 命令: 'npm -w server run test:free-review', 目录: 'server', 时限: '10 分钟' },
        raw: '{\n  "command": "npm -w server run test:free-review",\n  "description": "裁定闸的回归测试",\n  "timeout": 600000\n}' },
    ], { time: '6m 12s' });
    a.body.append(foldA.btn, foldA.list, h('div.md', { html: `
      <p>找到原因了：裁定「不用改了」之后，那条预约被当成已经兑现，后面的审查就再也起不来。</p>
      <p>改了两处：裁定后保留预约，并把它的说明换成「审查新改动」；补了一条回归，覆盖「裁定后再派审」。</p>` }));

    const b = kit.turn({ meta: 'claude-opus-5-5 · high · 11/10 22:50 · 20s', reply: true });
    const foldB = kit.fold('读了 2 个文件，跑了 1 条命令', [
      { verb: '读', text: '`server/src/free-review-reservations.ts` 第 60–131 行', fields: { 文件: 'server/src/free-review-reservations.ts', 行: '60–131' } },
      { verb: '读', text: '`server/scripts/test-free-review-ruling.ts`' },
      { verb: '跑', text: '`git log -1 --stat`', fields: { 命令: 'git log -1 --stat', 目录: '.' } },
    ], { time: '20s' });
    b.body.append(foldB.btn, foldB.list, h('div.md', { html: `
      <p>第 2 轮审查的两条必改项都修好了，已提交为 <code>b255e9ac</code>。登记的回归测试跑完，退出码 0。</p>
      <ol>
        <li><strong>你取消旧预约又挂一条新的，新的被提前开审</strong>：以前只在开始兑现时检查一次资格。现在每次真正开审前都会重新检查，新预约不满足条件就原样留着，等它自己的执行回合结束后再审。</li>
        <li><strong>只压缩过上下文、中间遇到重启，预约就不再自动开审</strong>：以前重启恢复时，所有被打断的回合都会作废这份资格。现在只有真正改代码的回合才作废；<code>/compact</code> 这类不改代码的回合被打断时，资格会保留。</li>
      </ol>
      <p>我按审查给的两个场景各加了一个测试用例。临时撤掉对应的修复，这两个用例都会失败；修复恢复后全部通过。</p>
      <p>合并后请在主仓重新 build 服务端，再由你重启 <code>:4317</code>。</p>` }));

    return {
      a, foldA, b, foldB,
      nodes: [
        kit.user('刚才这个裁定我做了「不用改了」的决定，但是预约的审查没有起；而且下面的预约审查应该是「审查新改动」之类的。现在好了，直接不能审查了。', '11/10 21:34'),
        a.el,
        kit.rev({ tone: 'warn', round: 2, verdict: '未通过', by: 'codex', dur: '8m 40s', time: '11/10 22:20 → 22:29', notes: ['取消旧预约又挂一条新的，新的会被提前开审。', '只压缩过上下文、中间遇到重启，预约不再自动开审。'] }),
        kit.user('两条都改。改完跑一遍那个闸的回归。', '11/10 22:31'),
        kit.sys({ glyph: 'clock', text: '审查还没开始：任务暂停着，跑完这一轮自动开审', more: '5 条记录', time: '11/10 22:50',
          log: [['第 2 轮审查没通过，意见已交给执行者', '22:29'], ['开始修复', '22:31'], ['开始盯：裁定闸回归测试', '22:38'], ['任务暂停，等回归结果', '22:38'], ['审查已预约，这一轮跑完自动开始', '22:50']] }),
        kit.auto({ text: '收到 2 条哨兵消息，合并为一次输入', from: '裁定闸回归测试', time: '11/10 22:50',
          lines: ['[输出] 14 passed, 0 failed (38.2s)', '[结束] 命令退出，退出码 0'] }),
        b.el,
        kit.sys({ glyph: 'pulse', text: '不再等「裁定闸回归测试」了，它已经跑完', more: '查看完整内容', time: '11/10 22:50', log: [['理由：结果已经收到，退出码 0', '']] }),
        kit.rev({ tone: 'ok', round: 3, verdict: '已通过', by: 'codex', dur: '12m 5s', time: '11/10 22:50 → 23:02' }),
      ],
    };
  };

  ASH.part('feed', {
    mount(wrap, { dock }) {
      const feed = h('div.feed', { tabindex: '0', role: 'log', 'aria-label': '会话' });
      const s = SESSION();
      feed.append(...s.nodes, ...kit.kept);
      const top = h('button.scroll-btn.top.is-hidden.is-idle', { type: 'button', 'aria-label': '滚动到会话顶部', 'data-m': 'feed-4' }, icon('up'));
      const bottom = h('button.scroll-btn.bottom.is-hidden', { type: 'button', 'aria-label': '滚动到会话底部' }, icon('down'));
      const rail = h('nav.rail', { 'aria-label': '你发过的话', 'data-m': 'feed-9' });
      wrap.append(feed, top, bottom, rail);

      /* 贴底：离底 80px 以内算贴着；内容变了就瞬移到底（平滑滚动会掐断滚轮的惯性） */
      let stuck = true;
      let gliding = false;   /* 提问卡正带着会话往上走：这一段不重新判「贴没贴底」 */
      const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 80;
      const toBottom = () => { if (stuck) feed.scrollTop = feed.scrollHeight; };
      /* 下一帧再贴一次：「减少动效」下样式的变化会晚一帧落定 */
      const follow = () => { toBottom(); requestAnimationFrame(toBottom); };

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
      const sizes = new ResizeObserver(() => { if (!gliding) toBottom(); paintRail(); });
      sizes.observe(feed);
      const glide = (to) => feed.scrollTo({ top: to, behavior: ASH.reduced() ? 'auto' : 'smooth' });
      top.addEventListener('click', () => { intent(); glide(0); });
      bottom.addEventListener('click', () => { stuck = true; glide(feed.scrollHeight); });

      /* 输入导航：一条刻度是你发过的一句话 */
      const users = () => $$('[data-user]', feed);
      const said = (row) => $('.bubble > p', row).textContent;
      const jump = (row) => { ASH.closePop(); row.scrollIntoView({ block: 'center', behavior: ASH.reduced() ? 'auto' : 'smooth' }); const b = $('.bubble', row); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); };
      const buildRail = () => { rail.replaceChildren(...users().map((row, i) => h('button', { type: 'button', 'aria-label': `第 ${i + 1} 条输入`, 'data-tip': said(row).slice(0, 44), 'data-key': 'Q', 'data-tip-side': 'right', onclick: () => jump(row) }))); paintRail(); };
      function paintRail() {
        const box = feed.getBoundingClientRect();
        const line = box.top + box.height / 3;
        const rows = users();
        const at = rows.reduce((best, row, i) => { const y = row.getBoundingClientRect().top; return y <= line || (stuck && y < box.bottom) ? i : best; }, 0);
        [...rail.children].forEach((tick, i) => tick.classList.toggle('on', i === at));
      }
      const openList = () => ASH.pop(rail, h('div.rail-list', users().map((row) => h('button', { type: 'button', onclick: () => jump(row) }, h('span.cut', said(row)), h('time', $('time', row)?.textContent ?? '')))), { place: 'bottom-start' })?.el.querySelector('button')?.focus();
      const onKey = (e) => { if (e.key.toLowerCase() === 'q' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest('input, textarea, [contenteditable]')) { e.preventDefault(); openList(); } };
      addEventListener('keydown', onKey);
      kit.changed = buildRail;

      /* 提问坞：卡片落定后住在会话下面、滚动区外面。进场时先浮在会话区底缘，从下面升上来，
         同一段时间里会话跟着往上让出它的高度——两样都不改布局，所以滑得动 */
      let card = null;
      const rise = (el, instant) => {
        if (instant || ASH.reduced()) { dock.append(el); follow(); return; }
        const pinned = stuck;
        el.classList.add('is-rising');
        wrap.append(el);
        const lift = el.offsetHeight + parseFloat(getComputedStyle(el).marginBottom);
        const from = feed.scrollTop;
        const t0 = performance.now();
        if (pinned) feed.style.paddingBottom = `${parseFloat(getComputedStyle(feed).paddingBottom) + lift}px`;
        gliding = true;
        el._land = () => {
          el._land = null;
          el.style.transform = '';
          el.classList.remove('is-rising');
          feed.style.paddingBottom = '';
          dock.append(el);
          gliding = false;
          if (pinned) { stuck = true; feed.scrollTop = feed.scrollHeight; }
        };
        const frame = (now) => {
          if (!el._land) return;
          const k = Math.max(0, Math.min(1, (now - t0) / 320));
          const eased = 1 - (1 - k) ** 3;
          el.style.transform = `translateY(${(1 - eased) * lift}px)`;
          if (pinned) feed.scrollTop = from + eased * lift;
          if (k < 1) requestAnimationFrame(frame); else el._land();
        };
        el.style.transform = `translateY(${lift}px)`;
        requestAnimationFrame(frame);
      };
      const unask = () => {
        const old = card;
        card = null;
        if (!old) return;
        old._land?.();
        old.classList.add('is-out');
        setTimeout(() => { old.remove(); follow(); }, ASH.reduced() ? 0 : 140);
      };
      /* 提问卡，件和话照 QuestionCard.tsx：选项可多选，选了就写进下面的答复框；数字键勾选；回车发送 */
      const ask = ({ q, options = [], onanswer, instant }) => {
        unask();
        const input = h('textarea', { rows: '1', placeholder: options.length ? '补充或修改…' : '写下你的答案…', 'aria-label': `答复：${q}`, 'data-m': 'feed-12' });
        const sendBtn = h('button.btn.pri', { type: 'button', onclick: () => send() }, icon('send'), '发送答复');
        const keys = options.map((o, i) => h('span.q-key', { 'aria-hidden': 'true' }, String(i + 1)));
        const opts = options.map((o, i) => h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => toggle(i) }, keys[i], h('span', o)));
        const paint = () => {
          const lines = input.value.split('\n');
          opts.forEach((btn, i) => { const on = lines.includes(options[i]); btn.setAttribute('aria-pressed', String(on)); keys[i].replaceChildren(on ? icon('check') : String(i + 1)); });
          sendBtn.disabled = !input.value.trim();
          input.style.height = 'auto';
          input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
          follow();
        };
        const toggle = (i) => { const lines = input.value.split('\n').filter(Boolean); input.value = (lines.includes(options[i]) ? lines.filter((line) => line !== options[i]) : [...lines, options[i]]).join('\n'); paint(); };
        const send = () => { const text = input.value.trim(); if (!text || card !== el) return; unask(); onanswer?.(text); };
        input.addEventListener('input', paint);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
        const fold = h('button.ico.sm', { type: 'button', 'aria-expanded': 'true', 'aria-label': '收起答复卡，先看上文', onclick: () => {
          const shut = el.classList.toggle('is-shut');
          fold.setAttribute('aria-expanded', String(!shut));
          fold.setAttribute('aria-label', shut ? '展开答复卡' : '收起答复卡，先看上文');
          follow();
        } }, icon('caret'));
        const el = h('section.qcard', { 'aria-label': '等待答复的问题', 'data-m': 'run-7' },
          h('header', icon('help'), h('b', '需要你的答复'), h('span.q-status', '待答复'), fold),
          h('div.q-body', h('p.q-title', q),
            options.length > 0 && h('div.opts', { role: 'group', 'aria-label': `${q}的建议答案` }, opts),
            options.length > 0 && h('small.q-hint', `可多选，也可编辑下方答案 · 数字键 1–${Math.min(options.length, 9)} 快速勾选`), input),
          h('footer', h('span', '↵ 发送'), sendBtn));
        el.addEventListener('keydown', (e) => {
          const n = Number(e.key) - 1;
          if (e.target === input || e.metaKey || e.ctrlKey || e.altKey || !Number.isInteger(n) || n < 0 || n >= options.length) return;
          e.preventDefault();
          toggle(n);
        });
        card = el;
        sendBtn.disabled = true;
        rise(el, instant);
        return el;
      };

      /* 认领清单条目 */
      const [, , rev2, , , autoRow, , doneRow, rev3] = s.nodes;
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
      ASH.prep['feed-3'] = () => peek(...$$('.sys .rt, .rev .rt, .auto .rt', feed));
      ASH.prep['feed-4'] = () => { feed.scrollTop = Math.max(120, feed.scrollTop - 60); top.classList.remove('is-hidden', 'is-idle'); clearTimeout(idle); idle = setTimeout(rest, 2600); };
      ASH.prep['feed-6'] = () => { s.foldA.toggle(true); const last = s.foldA.list.lastElementChild; if ($('.step-more', last).hidden) unfold($('button', last), $('.step-more', last)); };
      ASH.prep['feed-12'] = () => { if (!card) ask({ q: '回归里有一条用例依赖真实时钟，改成假时钟还是放宽断言？', options: ['改成假时钟', '把断言放宽到 ±1 秒'] }); };

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
          for (const id of ['feed-1', 'feed-2', 'feed-3', 'feed-4', 'feed-6', 'feed-12']) delete ASH.prep[id];
        },
      };
    },
  });
})();
