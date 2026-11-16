/* 右侧面板第三簇里的五格：备忘、工作流、审查、预览指正、哨兵（子智能体、侧聊在 insp-talk.js）。外壳在 insp.js（排在它后面加载）。
   每一格是一个造法 I.build.<格>(c) → 节点；c 是外壳给的控制器（c.st 任务状态、c.on / c.emit 栏内事件、c.acts 面板头动作、c.mark 竖轨上的点）。
   审查的账不在这里：「审查」「工作流」两格读 ASH.review、听 review:change / review:start，所以它们和会话流里的审查行、回复框那颗键说的是同一轮。
   每格在这一次打开样机期间只造一次，切到别的面再回来还是原样；所以这里的定时器不用收，让它自己走完。
   面板里「在跑」的东西只用主色的字（.insp-live），不扫光：扫光全应用只留给会话流里正在动的那一行。
   通到别处的入口只发事件：changes:open（改动工作区）、preview:open（预览指正的工作区）。 */
(ASH.insp ??= { build: {}, packs: [] }).packs.push((I) => {
  const { h, icon } = ASH;
  const { sec, none, reenter, fold, leave, tool, grow, clock } = I.kit;
  const D = I.data;
  const cur = ASH.data.cur;
  const R = ASH.review;
  const ENDED = ['done', 'failed', 'stopped', 'backlog'];
  const live = (text) => h('span.insp-live', text);

  /* ---------- 备忘：一条一张卡；没有的时候只有一句话加一颗「写一条」。有了，竖轨上那格才有灰点 ---------- */
  I.build.memo = (c) => {
    const memos = [{ text: '验收时手动试一次：定一条一分钟后的回复，把 ash 关掉，过了点再打开，看它带不带「补发」。', at: '11/09 15:20' }];
    const list = h('div.insp-cards');
    const area = h('textarea.field', { rows: 3, placeholder: '这一轮为什么这么定、哪段输出要留着回头看、验收时记得查什么…', 'aria-label': '备忘内容' });
    const reset = grow(area);
    const editor = h('div.insp-edit', { hidden: true }, area, h('div', {},
      h('button.btn.quiet.sm', { type: 'button', onclick: () => close() }, '取消'), h('button.btn.pri.sm', { type: 'button', onclick: () => save() }, '保存')));
    const empty = none('这个任务还没有备忘。', '写一条', () => write());
    const addBtn = tool('plus', '写一条备忘', () => write());
    let editing = null;
    const card = (memo) => {
      const el = h(`article.card${memo.fresh ? '.enter' : ''}`, {}, h('p.insp-memo-text', memo.text), h('div.insp-card-foot', {},
        h('span.grow', memo.edited ? `${memo.at} · 已编辑` : memo.at),
        tool('edit', '编辑这条备忘', () => write(memo)),
        tool('trash', '删掉这条备忘', () => drop(memo, el))));
      memo.fresh = false;
      return el;
    };
    const paint = () => {
      list.replaceChildren(...memos.filter((memo) => memo !== editing).map(card));
      empty.hidden = memos.length > 0 || !editor.hidden;
      c.mark('memo', memos.length ? 'has' : null, memos.length);
    };
    function write(memo = null) {
      editing = memo;
      editor.hidden = false;
      reenter(editor);
      paint();
      area.value = memo?.text ?? '';
      area.dispatchEvent(new Event('input'));
      area.focus();
    }
    function close() {
      editing = null;
      editor.hidden = true;
      reset();
      paint();
      addBtn.focus({ preventScroll: true });
    }
    function save() {
      const text = area.value.trim();
      if (!text) { area.focus(); return; }
      if (editing) { if (editing.text !== text) { editing.text = text; editing.edited = true; } } else memos.unshift({ text, at: '刚刚', fresh: true });
      close();
    }
    async function drop(memo, el) {
      const yes = await ASH.confirm({ title: '删掉这条备忘', body: '删掉就找不回来了。', ok: '删除', danger: true });
      if (!yes) return;
      leave(el, () => { memos.splice(memos.indexOf(memo), 1); paint(); addBtn.focus({ preventScroll: true }); });
    }
    area.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    c.acts.memo = [addBtn];
    paint();
    return [editor, list, empty];
  };

  /* ---------- 工作流：发生过什么，按先后一行一条。相邻的「任务执行」合成一条，右边是合计用时，点开才是一段段的。
     审查那几行只记「第几轮」，结论现从 ASH.review 取 ---------- */
  I.build.flow = (c) => {
    const items = [
      { runs: [['14:14', 372000]] }, { round: 1 },
      { runs: [['14:41', 315000]] }, { round: 2 },
      { runs: [['15:09', 422000], ['15:28', 20000]] }, { round: 3 },
    ];
    const tl = h('ol.insp-tl');
    let t0 = 0;
    const runRow = (it, mark) => {
      const going = it.runs.at(-1)[1] == null;
      const total = h('span.meta', {}, going ? live('在跑') : ASH.dur(it.runs.reduce((sum, [, ms]) => sum + ms, 0)));
      if (it.runs.length === 1) return h('li', {}, h('div.insp-row', {}, h('span', '任务执行'), h('span.faint', it.runs[0][0]), total));
      const sub = h('ol.insp-sub', { hidden: !it.open }, it.runs.map(([at, ms]) => h('li', {}, h('span', at), h('span', ms == null ? '在跑' : ASH.dur(ms)))));
      const btn = h('button.insp-row', { type: 'button', 'aria-expanded': String(Boolean(it.open)), 'data-m': mark ? 'insp-8' : null, onclick: () => { it.open = fold(btn, sub); } },
        h('span', {}, '任务执行 ', h('span.faint', `×${it.runs.length}`)), icon('chev', 'sm insp-rot'), total);
      return h('li', {}, btn, sub);
    };
    const revRow = (it) => {
      const r = R.rounds.find((x) => x.n === it.round);
      const tone = !r ? '' : r.ok ? '.ok' : '.bad';
      return h(`li${tone}`, {}, h('button.insp-row', { type: 'button', onclick: () => c.open('review', { round: it.round }) },
        h('span', `审查 · 第 ${it.round} 轮`), h(`span.meta${r && !r.ok ? '.bad' : ''}`, {}, !r ? live('审查中') : r.ok ? '已通过' : `未通过 · ${r.notes.length} 条`)));
    };
    const render = () => {
      const marked = items.find((it) => it.runs?.length > 1);
      tl.replaceChildren(...items.map((it) => (it.runs ? runRow(it, it === marked) : it.round ? revRow(it) : h('li.ok', {}, h('div.insp-row', {}, h('span', `合并到 ${cur.target}`), h('span.meta', it.at))))));
    };
    c.on('status', (now, prev) => {
      const last = items.at(-1);
      if (now.status === 'running' && prev.status !== 'running') {            // 又跑起来了：接在上一段执行后面，或者另起一条
        t0 = performance.now();
        if (last.runs) last.runs.push([clock(), null]); else items.push({ runs: [[clock(), null]] });
      } else if (prev.status === 'running') {
        const open = items.findLast((it) => it.runs)?.runs.at(-1);
        if (open && open[1] == null) open[1] = performance.now() - t0;
      }
      if (now.accepted && !last.merged) items.push({ merged: true, at: clock() });  // 验收之后才多出「合并到 main」
      if (!now.accepted && last.merged) items.pop();
      render();
    });
    ASH.on('review:start', ({ round } = {}) => { if (!items.some((it) => it.round === round)) items.push({ round }); render(); });
    ASH.on('review:change', render);
    render();
    return tl;
  };

  /* ---------- 审查：一句结论、一个主动作，其余进「更多」；各轮一行，点开就地看报告。
     账是 ASH.review 的；这里只管这一刻该说哪句话、把哪一个动作摆出来 ---------- */
  I.build.review = (c) => {
    const { st } = c;
    const CHECK = { logic: '逻辑检查', syntax: '语法检查' };
    const now = h('p.insp-now');
    const acts = h('div.insp-do');
    const count = h('b');
    const list = h('div');
    const postSec = sec('合并结果审查', '');
    const postList = h('div');
    const opened = new Set();   // 点开着的那几份报告

    const record = (r) => {
      const body = h('div.insp-report', { hidden: !opened.has(r) }, h('p', `${CHECK[r.check] ?? CHECK.logic} · ${r.at}`), r.note && h('p', `附言：${r.note}`), r.ok ? h('p', r.notes[0]) : h('ol', {}, r.notes.map((line) => h('li', line))));
      const btn = h('button.go', { type: 'button', 'aria-expanded': String(opened.has(r)), 'data-round': r.n ?? null, onclick: () => { if (fold(btn, body)) opened.add(r); else opened.delete(r); } },
        h('span.cut', {}, r.n ? `第 ${r.n} 轮` : `${cur.target}@${r.commit}`, h('span.faint', ` ${r.by} · ${r.took}`)), h(`span.meta${r.ok ? '' : '.bad'}`, r.ok ? '已通过' : `未通过 · ${r.notes.length} 条`), icon('chev', 'insp-rot'));
      return h(`div${r.fresh ? '.enter' : ''}`, {}, btn, body);
    };
    const openRecord = (r, box) => {
      opened.add(r);
      render();
      (r.n ? box.querySelector(`[data-round="${r.n}"]`) : box.lastElementChild)?.scrollIntoView({ block: 'nearest' });
    };
    const workspace = { label: '打开改动工作区', icon: 'pull', onpick: () => ASH.emit('changes:open') };
    const fix = (last) => ASH.parts.live?.play?.('fix', '', { cause: { text: `按第 ${last.n} 轮审查的意见改`, onclick: () => ASH.emit('insp:open', { pane: 'review', round: last.n }) } });
    /* 这一刻该说哪句话、给哪一颗主动作、哪些进「更多」。主动作只有「有事要你办」的时候才是实心的。
       派审、预约、调整预约走的是回复框那颗键同一张对话框（R.dialog），字也取自同一处（R.key） */
    function view() {
      const last = R.rounds.at(-1);
      const post = R.posts.at(-1);
      const key = R.key();
      const again = { label: key.text === '再审' ? '再审一轮' : key.text, icon: 'search', onpick: () => R.dialog() };
      if (R.busy === 'post') return { tone: 'busy', text: '合并结果审查中', more: [workspace] };
      if (R.busy) return { tone: 'busy', text: `第 ${R.busy} 轮审查中`, main: ['调整审查轮数', (e) => R.tune(e.currentTarget), false, null, 'dialog'], more: [workspace] };
      if (st.accepted) {
        const see = { label: '查看审查结果', icon: 'file', onpick: () => openRecord(post, postList) };
        if (!post) return { tone: 'ok', text: '已合并，合并结果还没审过', main: ['开始审查', () => R.startPost()], more: [workspace] };
        if (post.ok) return { tone: 'ok', text: '合并结果已通过', main: ['再审一次', () => R.startPost()], more: [see, workspace] };
        return { tone: 'bad', text: `合并结果未通过 · ${post.notes.length} 条`, main: ['创建修复任务', () => ASH.go('#/new'), true], more: [see, { label: '再审一次', icon: 'search', onpick: () => R.startPost() }, workspace] };
      }
      const going = st.status === 'running' || st.status === 'waiting' || st.status === 'queued' || st.status === 'paused';
      if (going || R.armed) {
        const text = last.ok ? `第 ${last.n} 轮已通过` : `第 ${last.n} 轮未通过 · ${going ? '任务修改中' : '交给执行者修复'}`;
        return { tone: last.ok ? 'ok' : 'bad', text, main: [key.text, () => R.dialog(), false, R.armed, 'dialog'], more: [workspace] };
      }
      if (!last.ok) return { tone: 'bad', text: `第 ${last.n} 轮未通过 · ${last.notes.length} 条`, main: ['按意见修复', () => fix(last), true], more: [again, workspace] };
      if (R.stale) return { tone: 'stale', text: `第 ${last.n} 轮已通过，之后代码有变化`, main: [again.label, again.onpick, true, null, 'dialog'], more: [workspace] };
      return { tone: 'ok', text: `第 ${last.n} 轮已通过`, main: [again.label, again.onpick, false, null, 'dialog'], more: [workspace] };
    }
    function render() {
      const v = view();
      const had = acts.contains(document.activeElement);
      now.className = `insp-now is-${v.tone}`;
      now.replaceChildren(...(v.tone === 'busy' ? [live(v.text)] : [icon(v.tone === 'ok' ? 'check' : v.tone === 'bad' ? 'x' : 'search'), h('span', v.text)]));
      const main = v.main && h(`button.btn${v.main[2] ? '.pri' : ''}`, { type: 'button', 'aria-pressed': v.main[3] == null ? null : String(v.main[3]), 'aria-haspopup': v.main[4] ?? null, onclick: v.main[1] }, v.main[0]);
      /* 「更多」里只剩一项时不绕一层菜单，直接摆出来 */
      const more = v.more.length === 1
        ? h('button.btn.quiet', { type: 'button', onclick: v.more[0].onpick }, v.more[0].label)
        : h('button.btn.quiet', { type: 'button', 'aria-haspopup': 'menu', onclick: (e) => ASH.menu(e.currentTarget, v.more) }, '更多');
      acts.replaceChildren(...[main, more].filter(Boolean));
      if (had) acts.firstChild.focus({ preventScroll: true });
      count.textContent = String(R.rounds.length);
      list.replaceChildren(...R.rounds.map(record));
      postSec.hidden = !R.posts.length;
      postSec.lastChild.textContent = String(R.posts.length);
      postList.replaceChildren(...R.posts.map(record));
      for (const r of [...R.rounds, ...R.posts]) r.fresh = false;
      c.mark('review', R.busy ? 'run' : null);
    }
    c.on('show:review', ({ round } = {}) => {
      const r = R.rounds.find((x) => x.n === round);
      if (r) openRecord(r, list);
    });
    c.on('status', render);
    ASH.on('review:change', render);
    render();
    return [h('div', { 'data-m': 'insp-5' }, now, acts), h('h4.sec', {}, '审查记录', count), list, postSec, postList];
  };

  I.build.preview = () => {
    const el = none('在页面上圈出要改的地方，逐条写意见。', '打开预览指正', () => ASH.emit('preview:open'));
    el.dataset.m = 'insp-11';
    return el;
  };

  /* ---------- 哨兵：先给结论（盯什么、什么状态、跑了多久、几点起的），命令、目录和输出折起来 ---------- */
  I.build.watch = (c) => {
    const { st } = c;
    const STATE = { run: '在跑', done: '跑完了', stop: '停掉了' };
    const PASSED = [`# pass ${cur.test.pass}`, '# fail 0', 'EXIT=0'];
    const TEST = { title: cur.test.title, cmd: `${cur.test.cmd} 2>&1 | grep --line-buffered -E '^# (pass|fail)|EXIT='`, dir: D.dir };
    const cards = [];
    const list = h('div.insp-cards');
    const head = sec('ash 哨兵', '');
    const empty = none('这个任务上还没有哨兵。');
    const blocked = h('p.note', {}, icon('info'), h('span', '任务已经结束，哨兵的输出不会再唤醒它——要盯新的活，先让这个任务重新跑起来。'));
    let ticker = 0, auto = null, pid = 48211;

    function card(k) {
      const state = h('span');
      const took = h('span.num');
      const facts = h('p.insp-card-meta');
      const stop = h('button.btn.sm', { type: 'button', hidden: true, 'data-tip': '杀掉它的进程，不再唤醒任务', onclick: () => { const waited = k === auto; end(k, 'stop'); if (waited) ASH.emit('watch:stop'); } }, '停掉');
      const cmd = h('div', { hidden: true }, h('pre.insp-code', k.cmd), facts);
      const out = h('pre.insp-code', { hidden: true });
      const cmdBtn = h('button.insp-fold', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(cmdBtn, cmd) }, icon('chev', 'insp-rot'), '命令');
      const outBtn = h('button.insp-fold', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(outBtn, out) }, icon('chev', 'insp-rot'), '输出');
      k.el = h('article.card', {},
        h('div.insp-card-top', {}, icon('pulse', 'sm'), h('b.cut.grow', { 'data-tip': k.title }, k.title), stop),
        h('p.insp-card-meta', {}, state, ' · ', took, ' · ', h('span.num', `${k.since} 起`)),
        h('div.insp-folds', {}, cmdBtn, outBtn), cmd, out);
      k.tick = () => { took.textContent = ASH.dur(k.ms); };
      k.paint = () => {
        state.className = k.state === 'run' ? 'insp-live' : '';
        state.textContent = STATE[k.state];
        stop.hidden = k.state !== 'run';
        facts.textContent = [`在 ${k.dir} 里跑`, k.code != null && `退出码 ${k.code}`, `${k.events} 条事件`, `进程号 ${k.pid}`].filter(Boolean).join(' · ');
        out.textContent = k.out.length ? k.out.join('\n') : '还没有输出';
        k.tick();
      };
      k.paint();
      return k;
    }
    function paint() {
      const going = cards.filter((k) => k.state === 'run');
      head.hidden = !cards.length;
      head.lastChild.textContent = String(cards.length);
      empty.hidden = cards.length > 0;
      c.mark('watch', going.length ? 'run' : cards.length ? 'has' : null, cards.length);
      clearInterval(ticker);
      ticker = going.length ? setInterval(() => { for (const k of going) { k.ms = performance.now() - k.t0; k.tick(); } }, 1000) : 0;
    }
    function start(spec) {
      const k = card({ since: clock(), ms: 0, t0: performance.now(), state: 'run', code: null, events: 0, pid: (pid += 137), out: [], ...spec });
      k.el.classList.add('enter');
      cards.unshift(k);
      list.prepend(k.el);
      paint();
      return k;
    }
    function end(k, how, code = null) {
      if (k.state !== 'run') return;
      Object.assign(k, { state: how, ms: performance.now() - k.t0, code });
      if (k === auto) auto = null;
      k.paint();
      paint();
    }
    const first = card({ ...TEST, since: '11/09 15:16', ms: 702000, state: 'done', code: 0, events: 2, pid, out: PASSED });
    first.el.dataset.m = 'insp-9';
    cards.push(first);
    list.append(first.el);

    /* 手动起一个：任务还活着（在跑、等答复、排队）才给 */
    const cmdIn = h('textarea.field.mono', { rows: 2, placeholder: 'tail -F build.log | grep --line-buffered -E "ERROR|BUILD OK"', 'aria-label': '命令', spellcheck: 'false' });
    const resetCmd = grow(cmdIn);
    const sayIn = h('input.field', { placeholder: '盯翻译进度', 'aria-label': '说明' });
    const wordIn = h('input.field.mono', { placeholder: 'BUILD OK|FAILED', 'aria-label': '出现就收工的字样', spellcheck: 'false' });
    const form = h('form.insp-form', { hidden: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
      h('label', {}, h('span', '命令'), cmdIn),
      h('label', {}, h('span', '说明'), sayIn),
      h('div', {}, h('span', '它什么时候算完'), ASH.select({ value: 'word', label: '它什么时候算完', options: [{ value: 'word', label: '等到某个字样出现就收工' }, { value: 'expiry', label: '就是要盯到到期（每出现一次叫我一次）' }], onchange: (value) => { wordIn.hidden = value !== 'word'; } }), wordIn),
      h('div', {}, h('span', '盯多久'), ASH.select({ value: '5', label: '盯多久', options: ['5', '15', '30', '60'].map((value) => ({ value, label: `${value} 分钟` })) })),
      h('div.insp-form-acts', {}, h('button.btn.quiet.sm', { type: 'button', onclick: () => toggle(false) }, '取消'), h('button.btn.pri.sm', { type: 'submit' }, '起一个哨兵')));
    const addBtn = tool('plus', '手动起一个哨兵', () => toggle(form.hidden), { 'aria-expanded': 'false' });
    function toggle(on) {
      form.hidden = !on;
      addBtn.setAttribute('aria-expanded', String(on));
      if (on) { reenter(form); cmdIn.focus(); } else { resetCmd(); sayIn.value = ''; wordIn.value = ''; }
    }
    function submit() {
      const cmd = cmdIn.value.trim();
      if (!cmd) { cmdIn.focus(); return; }
      start({ title: sayIn.value.trim() || cmd, cmd, dir: D.dir });
      toggle(false);
      addBtn.focus({ preventScroll: true });
    }
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); toggle(false); addBtn.focus({ preventScroll: true }); } });
    const gate = () => {
      const can = !ENDED.includes(st.status);
      blocked.hidden = can;
      if (!can && !form.hidden) toggle(false);
      c.setActs('watch', can ? [addBtn] : []);
    };
    /* 会话里那一轮挂上的哨兵在这里是一张卡：它每叫醒一次，卡上多几行输出；带着退出码来的那一次，它就跑完了 */
    ASH.on('watch:hang', ({ title, cmd } = {}) => { auto = start({ title, cmd, dir: D.dir }); });
    ASH.on('watch:stop', () => { if (auto) end(auto, 'stop'); });   /* 会话里那一行点了「不等了」 */
    ASH.on('watch:wake', ({ lines = [], exit } = {}) => {
      if (!auto) return;
      const k = auto;
      k.out.push(...lines);
      k.events += 1;
      if (exit == null) k.paint(); else { end(k, 'done', exit); k.paint(); }
    });
    c.on('status', (now) => {
      if (ENDED.includes(now.status)) for (const k of cards.filter((x) => x.state === 'run')) end(k, 'stop');
      gate();
    });
    gate();
    paint();
    return [blocked, form, head, list, empty];
  };
});
