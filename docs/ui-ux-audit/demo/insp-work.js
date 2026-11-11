/* 右侧面板第三簇的七格：子智能体、备忘、侧聊、工作流、审查、预览指正、哨兵。外壳在 insp.js（排在它后面加载）。
   每一格是一个造法 I.build.<格>(c) → 节点；c 是外壳给的控制器（c.st 任务状态、c.on / c.emit 栏内事件、c.acts 面板头动作、c.mark 竖轨上的点）。
   这几格之间只通过栏内事件说话：审查起了一轮、出了结论，工作流那一格跟着添一行（round）。
   每格在这一次打开样机期间只造一次，切到别的面再回来还是原样；所以这里的定时器不用收，让它自己走完。
   样机里没有做下去的去处只发事件：changes:open（改动工作区）、preview:open（预览指正的工作区）、insp:review { state }（从这里派了审、约了审）。 */
(ASH.insp ??= { build: {}, packs: [] }).packs.push((I) => {
  const { h, icon } = ASH;
  const { sec, none, reenter, fold, leave, tool, grow, clock } = I.kit;
  const D = I.data;
  const ENDED = ['done', 'failed', 'stopped'];

  I.build.agents = () => none('这个任务没有用过子智能体。');

  /* ---------- 备忘：一条一张卡；没有的时候只有一句话加一颗「写一条」。有了，竖轨上那格才有灰点 ---------- */
  I.build.memo = (c) => {
    const memos = [{ text: '合并后回主仓重新 build', at: '11/10 22:41' }];
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

  /* ---------- 侧聊：一个输入框，占位那句话就是全部说明；多的话收在面板头的 ⓘ 里 ---------- */
  I.build.chat = (c) => {
    const rooms = [];
    let room = null, timer = 0;
    const log = h('div.insp-log', { role: 'log', 'aria-label': '侧聊消息' });
    const area = h('textarea', { rows: 1, placeholder: '围绕主会话问个问题…', 'aria-label': '侧聊消息输入' });
    const reset = grow(area);
    const who = ASH.target({ value: { agent: 'claude', model: null, level: null }, label: '侧聊执行器', place: 'top-start' });
    const sendBtn = h('button.btn.pri.insp-send', { type: 'button', 'aria-label': '发送侧聊消息', disabled: true, onclick: () => send() }, icon('up'));
    const say = (name, ...kids) => h('article.insp-msg.enter', {}, h('header', {}, h('b', name), h('time', clock())), h('p', {}, kids));
    const help = tool('info', '侧聊说明', () => ASH.pop(help, h('div.insp-help', {},
      h('p', {}, '围绕主会话独立提问，不打断主任务。需要回传时，直接说：', h('code', '把结论告诉主任务'), '。'),
      h('p', '首次发送时带入主会话快照；主会话特别长时会先整理一份摘要，要多等一会儿。关闭面板保留对话与草稿。'),
      h('p', {}, '输入框里 ', h('kbd', 'Enter'), ' 发送，', h('kbd', 'Shift Enter'), ' 换行；截图和文件可直接粘贴或用回形针选取。')), { place: 'bottom-end' }), { 'aria-haspopup': 'dialog' });
    /* 聊过以后头上才多出「切换」和「新建」 */
    const paintActs = () => c.setActs('chat', rooms.length ? [
      ASH.select({ value: room ? String(rooms.indexOf(room)) : '', label: '切换侧聊', options: [{ value: '', label: '新侧聊' }, ...rooms.map((r, i) => ({ value: String(i), label: r.name }))], onchange: (value) => pick(value === '' ? null : rooms[Number(value)]) }),
      tool('plus', '新建侧聊', () => pick(null), { disabled: !room }),
      help,
    ] : [help]);
    function pick(next) {
      if (room) room.nodes = [...log.children];
      room = next;
      log.replaceChildren(...(next?.nodes ?? []));
      paintActs();
      area.focus();
    }
    function send() {
      const text = area.value.trim();
      if (!text || timer) return;
      reset();
      sendBtn.disabled = true;
      if (!room) { room = { name: `侧聊 ${rooms.length + 1} · ${clock()}`, nodes: [] }; rooms.push(room); paintActs(); }
      const wait = h('span.shim', '在想');
      const reply = say('侧聊助手', wait);
      log.append(say('你', text), reply);
      reply.scrollIntoView({ block: 'nearest' });
      timer = setTimeout(() => {
        timer = 0;
        reply.lastChild.replaceChildren('放行在裁定落库之后：等着的那一轮从预约表里取出来接着跑，记录里多一行「你放行的」。主会话没有被打断。');
        reenter(reply);
        reply.scrollIntoView({ block: 'nearest' });
        sendBtn.disabled = !area.value.trim();
      }, 1400);
    }
    area.addEventListener('input', () => { sendBtn.disabled = Boolean(timer) || !area.value.trim(); });
    area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    c.acts.chat = [help];
    return [log, h('div.insp-ask', {}, area, h('div', {}, tool('clip', '添加文件或图片', () => area.focus()), who.el, h('span.grow'), sendBtn))];
  };

  /* ---------- 工作流：发生过什么，按先后一行一条。相邻的「任务执行」合成一条，右边是合计用时，点开才是一段段的 ---------- */
  I.build.flow = (c) => {
    const { st } = c;
    const items = [
      { runs: [['21:36', 372000], ['21:42', 16000]] }, { round: 1, ok: false, say: '未通过 · 3 条' },
      { runs: [['22:03', 300000], ['22:08', 15000]] }, { round: 2, ok: false, say: '未通过 · 2 条' },
      { runs: [['22:31', 422000], ['22:50', 20000]] }, { round: 3, ok: true, say: '已通过' },
    ];
    const tl = h('ol.insp-tl');
    let t0 = 0;
    const runRow = (it, mark) => {
      const live = it.runs.at(-1)[1] == null;
      const total = h('span.meta', {}, live ? h('span.shim', '在跑') : ASH.dur(it.runs.reduce((sum, [, ms]) => sum + ms, 0)));
      if (it.runs.length === 1) return h('li', {}, h('div.insp-row', {}, h('span', '任务执行'), h('span.faint', it.runs[0][0]), total));
      const sub = h('ol.insp-sub', { hidden: !it.open }, it.runs.map(([at, ms]) => h('li', {}, h('span', at), h('span', ms == null ? '在跑' : ASH.dur(ms)))));
      const btn = h('button.insp-row', { type: 'button', 'aria-expanded': String(Boolean(it.open)), 'data-m': mark ? 'insp-8' : null, onclick: () => { it.open = fold(btn, sub); } },
        h('span', {}, '任务执行 ', h('span.faint', `×${it.runs.length}`)), icon('chev', 'sm insp-rot'), total);
      return h('li', {}, btn, sub);
    };
    const revRow = (it) => h(`li${it.live ? '' : it.ok ? '.ok' : '.bad'}`, {}, h('button.insp-row', { type: 'button', onclick: () => c.open('review', { round: it.round }) },
      h('span', `审查 · 第 ${it.round} 轮`), h(`span.meta${it.live || it.ok ? '' : '.bad'}`, {}, it.live ? h('span.shim', '审查中') : it.say)));
    const render = () => tl.replaceChildren(...items.map((it, i) => (it.runs ? runRow(it, i === 0) : it.round ? revRow(it) : h('li.ok', {}, h('div.insp-row', {}, h('span', '合并到 main'), h('span.meta', it.at))))));
    c.on('status', (now, prev) => {
      const last = items.at(-1);
      if (now.status === 'running' && prev.status !== 'running') {            // 又跑起来了：接在上一段执行后面，或者另起一条
        t0 = performance.now();
        if (last.runs) last.runs.push(['刚刚', null]); else items.push({ runs: [['刚刚', null]] });
      } else if (prev.status === 'running') {
        const open = items.findLast((it) => it.runs)?.runs.at(-1);
        if (open && open[1] == null) open[1] = performance.now() - t0;
      }
      if (now.accepted && !last.merged) items.push({ merged: true, at: '刚刚' });  // 验收之后才多出「合并到 main」
      if (!now.accepted && last.merged) items.pop();
      render();
    });
    c.on('round', ({ n, state, say }) => {
      let it = items.find((x) => x.round === n);
      if (!it) { it = { round: n }; items.push(it); }
      Object.assign(it, { live: state === 'start', ok: state === 'ok', say });
      render();
    });
    render();
    return tl;
  };

  /* ---------- 审查：一句结论、一个主动作，其余进「更多」；各轮一行，点开就地看报告 ---------- */
  I.build.review = (c) => {
    const { st } = c;
    const rounds = [
      { n: 1, by: 'claude', took: '13m 2s', at: '11/10 21:44 → 21:57', ok: false, notes: ['「不用改了」和「维持原意见」走了同一条分支。', '放行没有写进记录，事后看不出是谁放的。', '缺一条「裁定后再派审」的回归。'] },
      { n: 2, by: 'codex', took: '8m 40s', at: '11/10 22:20 → 22:29', ok: false, notes: ['取消旧预约又挂一条新的，新的会被提前开审。', '只压缩过上下文、中间遇到重启，预约不再自动开审。'] },
      { n: 3, by: 'codex', took: '12m 5s', at: '11/10 22:50 → 23:02', ok: true, notes: ['没有新的问题。前两轮的 5 条意见都已收口。'] },
    ];
    const posts = [];          // 验收之后对合并结果的审查
    let busy = null;           // 正在审的：'post' 或者第几轮
    let stale = false;         // 上一轮审完之后它又跑过
    let armed = false;         // 它还在跑：约好跑完就审
    let limit = 0;             // 这一趟最多审到第几轮
    let noted = false;         // 改过代码之后的头一次审查已经给过意见了
    let tuning = null;         // 开着的「调整审查轮数」
    let t0 = 0;
    const now = h('p.insp-now');
    const acts = h('div.insp-do');
    const count = h('b');
    const list = h('div');
    const postSec = sec('合并结果审查', '');
    const postList = h('div');

    const record = (r) => {
      const body = h('div.insp-report', { hidden: !r.open }, h('p', `逻辑检查 · ${r.at}`), r.ok ? h('p', r.notes[0]) : h('ol', {}, r.notes.map((line) => h('li', line))));
      const btn = h('button.go', { type: 'button', 'aria-expanded': String(Boolean(r.open)), 'data-round': r.n ?? null, onclick: () => { r.open = fold(btn, body); } },
        h('span.cut', {}, r.n ? `第 ${r.n} 轮` : `main@${r.commit}`, h('span.faint', ` ${r.by} · ${r.took}`)), h(`span.meta${r.ok ? '' : '.bad'}`, r.ok ? '已通过' : `未通过 · ${r.notes.length} 条`), icon('chev', 'insp-rot'));
      return h(`div${r.fresh ? '.enter' : ''}`, {}, btn, body);
    };
    const openRecord = (r, box) => {
      r.open = true;
      render();
      box.lastElementChild?.scrollIntoView({ block: 'nearest' });
    };
    const workspace = { label: '打开改动工作区', icon: 'pull', onpick: () => ASH.emit('changes:open') };
    /* 这一刻该说哪句话、给哪一颗主动作、哪些进「更多」。主动作只有「有事要你办」的时候才是实心的 */
    function view() {
      const last = rounds.at(-1);
      const post = posts.at(-1);
      const again = { label: stale ? '审查新改动' : '再审一轮', icon: 'search', onpick: () => start(rounds.length + 1) };
      if (busy === 'post') return { tone: 'busy', text: '合并结果审查中', more: [workspace] };
      if (busy) return { tone: 'busy', text: `第 ${busy} 轮审查中`, main: ['调整审查轮数', (e) => tune(e.currentTarget), false, null, 'dialog'], more: [workspace] };
      if (st.accepted) {
        const see = { label: '查看审查结果', icon: 'file', onpick: () => openRecord(post, postList) };
        if (!post) return { tone: 'ok', text: '已合并，合并结果还没审过', main: ['开始审查', () => start('post')], more: [workspace] };
        if (post.ok) return { tone: 'ok', text: '合并结果已通过', main: ['再审一次', () => start('post')], more: [see, workspace] };
        return { tone: 'bad', text: `合并结果未通过 · ${post.notes.length} 条`, main: ['创建修复任务', () => ASH.go('#/new'), true], more: [see, { label: '再审一次', icon: 'search', onpick: () => start('post') }, workspace] };
      }
      if (st.status === 'running' || st.status === 'waiting') {
        return { tone: last.ok ? 'ok' : 'bad', text: last.ok ? `第 ${last.n} 轮已通过` : `第 ${last.n} 轮未通过 · 任务修改中`, main: [armed ? '已预约复审' : '预约复审', () => arm(!armed), false, armed], more: [workspace] };
      }
      if (!last.ok) return { tone: 'bad', text: `第 ${last.n} 轮未通过 · ${last.notes.length} 条`, main: ['按意见修复', () => ASH.parts.live?.play?.('run', `按第 ${last.n} 轮的审查意见修复。`), true], more: [again, workspace] };
      if (stale) return { tone: 'stale', text: `第 ${last.n} 轮已通过，之后代码有变化`, main: [again.label, again.onpick, true], more: [workspace] };
      return { tone: 'ok', text: `第 ${last.n} 轮已通过`, main: [again.label, again.onpick], more: [workspace] };
    }
    function render() {
      const v = view();
      const had = acts.contains(document.activeElement);
      const text = h('span', v.text);
      if (v.tone === 'busy') text.classList.add('shim');
      now.className = `insp-now is-${v.tone}`;
      now.replaceChildren(...(v.tone === 'busy' ? [] : [icon(v.tone === 'ok' ? 'check' : v.tone === 'bad' ? 'x' : 'search')]), text);
      const main = v.main && h(`button.btn${v.main[2] ? '.pri' : ''}`, { type: 'button', 'aria-pressed': v.main[3] == null ? null : String(v.main[3]), 'aria-haspopup': v.main[4] ?? null, onclick: v.main[1] }, v.main[0]);
      /* 「更多」里只剩一项时不绕一层菜单，直接摆出来 */
      const more = v.more.length === 1
        ? h('button.btn.quiet', { type: 'button', onclick: v.more[0].onpick }, v.more[0].label)
        : h('button.btn.quiet', { type: 'button', 'aria-haspopup': 'menu', onclick: (e) => ASH.menu(e.currentTarget, v.more) }, '更多');
      acts.replaceChildren(...[main, more].filter(Boolean));
      if (had) acts.firstChild.focus({ preventScroll: true });
      count.textContent = String(rounds.length);
      list.replaceChildren(...rounds.map(record));
      postSec.hidden = !posts.length;
      postSec.lastChild.textContent = String(posts.length);
      postList.replaceChildren(...posts.map(record));
      for (const r of [...rounds, ...posts]) r.fresh = false;
    }
    /* 审查在跑的时候改这一趟最多审几轮：正在审的那一轮自己占一轮，所以不能比它小 */
    function tune(anchor) {
      const round = busy;
      let total = Math.max(limit, round);
      const out = h('output.num', { 'aria-live': 'polite' });
      const note = h('p');
      const less = tool('minus', '少一轮', () => step(-1));
      const more = tool('plus', '多一轮', () => step(1));
      const step = (d) => {
        total = Math.min(round + 20, Math.max(round, total + d));
        out.textContent = String(total);
        less.disabled = total <= round;
        more.disabled = total >= round + 20;
        note.textContent = total > round ? `第 ${round} 轮未通过时，意见交给执行者修复，修完自动审第 ${round + 1} 轮。` : `第 ${round} 轮是最后一轮，未通过就停下来等你处理。`;
      };
      step(0);
      tuning = ASH.pop(anchor, h('div.insp-set', {},
        h('div.insp-step', {}, h('span.grow', `第 ${round} 轮正在审查`), h('span', '最多'), less, out, more, h('span', '轮')),
        note,
        h('div.insp-set-foot', {}, h('span.grow'), h('button.btn.pri.sm', { type: 'button', onclick: () => { limit = total; ASH.closePop(); anchor.focus(); } }, '保存'))), { place: 'bottom-start' });
    }
    function arm(on) {
      armed = on;
      ASH.emit('insp:review', { state: on ? 'armed' : 'idle' });
      render();
    }
    function start(what) {
      if (busy) return;
      busy = what;
      armed = false;
      limit = what === 'post' ? 0 : what + 1;
      t0 = performance.now();
      if (what !== 'post') c.emit('round', { n: what, state: 'start' });
      ASH.emit('insp:review', { state: 'start' });
      render();
      setTimeout(() => {
        const took = ASH.dur(performance.now() - t0);
        const at = `${clock()} → ${clock()}`;
        const round = busy;
        let ok = true;
        if (tuning?.el.contains(document.activeElement)) tuning.anchor.focus();
        tuning?.();                                     // 审完了，调轮数那一扇跟着关
        tuning = null;
        if (busy === 'post') {
          /* 头一次审合并结果给一条意见，好看得到「创建修复任务」；再审就过了 */
          ok = posts.length > 0;
          posts.push({ commit: 'e41f7a2', by: 'codex', took, at, ok, fresh: true, notes: [ok ? '没有新的问题。' : '合并后 main 上那条「裁定后再派审」的回归没有进验收前置命令。'] });
        } else {
          /* 代码没动过就再审：没有新问题。动过以后头一次审给一条意见，改完再审就过了 */
          ok = !stale || noted;
          if (stale) noted = true;
          rounds.push({ n: busy, by: 'codex', took, at, ok, fresh: true, notes: [ok ? '没有新的问题。' : '新加的回归没有覆盖「重启之后预约还在」这一种。'] });
          c.emit('round', { n: busy, state: ok ? 'ok' : 'bad', say: ok ? '已通过' : '未通过 · 1 条' });
          stale = false;
        }
        busy = null;
        ASH.emit('insp:review', { state: 'idle', round, ok });
        render();
      }, 2600);
    }
    c.on('show:review', ({ round } = {}) => {
      const r = rounds.find((x) => x.n === round);
      if (!r) return;
      r.open = true;
      render();
      list.querySelector(`[data-round="${round}"]`)?.scrollIntoView({ block: 'nearest' });
    });
    c.on('review', (state) => {                         // 回复框那颗「再审 / 预约复审」
      if (state === 'start') start(rounds.length + 1);
      else if (!busy) { armed = state === 'armed'; render(); }
    });
    c.on('status', (cur, prev) => {
      if (prev.status === 'running' && cur.status === 'done') { stale = true; if (armed) { start(rounds.length + 1); return; } }
      if (ENDED.includes(cur.status)) armed = false;
      render();
    });
    render();
    return [h('div', { 'data-m': 'insp-5' }, now, acts), h('h4.sec', {}, '审查记录', count), list, postSec, postList];
  };

  I.build.preview = (c) => {
    const el = none('在页面上圈出要改的地方，逐条写意见。', '打开预览指正', () => ASH.emit('preview:open'));
    el.dataset.m = 'insp-11';
    return el;
  };

  /* ---------- 哨兵：先给结论（盯什么、什么状态、跑了多久、几点起的），命令、目录和输出折起来 ---------- */
  I.build.watch = (c) => {
    const { st } = c;
    const STATE = { run: '在跑', done: '跑完了', stop: '停掉了' };
    const TEST = { title: '裁定闸回归测试', cmd: "npm -w server run test:free-review 2>&1 | grep --line-buffered -E '^# (pass|fail)|EXIT='", dir: `${D.dir}/server` };
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
      const stop = h('button.btn.sm', { type: 'button', hidden: true, 'data-tip': '杀掉它的进程，不再唤醒任务', onclick: () => end(k, 'stop') }, '停掉');
      const cmd = h('div', { hidden: true }, h('pre.insp-code', k.cmd), facts);
      const out = h('pre.insp-code', { hidden: true });
      const cmdBtn = h('button.insp-fold', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(cmdBtn, cmd) }, icon('chev', 'insp-rot'), '命令');
      const outBtn = h('button.insp-fold', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(outBtn, out) }, icon('chev', 'insp-rot'), '输出');
      k.el = h('article.card', {},
        h('div.insp-card-top', {}, icon('pulse', 'sm'), h('b.cut.grow', k.title), stop),
        h('p.insp-card-meta', {}, state, ' · ', took, ' · ', h('span.num', `${k.since} 起`)),
        h('div.insp-folds', {}, cmdBtn, outBtn), cmd, out);
      k.tick = () => { took.textContent = `${k.state === 'run' ? '已跑' : '跑了'} ${ASH.dur(k.ms)}`; };
      k.paint = () => {
        state.className = k.state === 'run' ? 'shim' : '';
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
      const live = cards.filter((k) => k.state === 'run');
      head.hidden = !cards.length;
      head.lastChild.textContent = String(cards.length);
      empty.hidden = cards.length > 0;
      c.mark('watch', live.length ? 'run' : cards.length ? 'has' : null, cards.length);
      clearInterval(ticker);
      ticker = live.length ? setInterval(() => { for (const k of live) { k.ms = performance.now() - k.t0; k.tick(); } }, 1000) : 0;
    }
    function start(spec) {
      const k = card({ since: clock(), ms: 0, t0: performance.now(), state: 'run', code: null, events: 0, pid: (pid += 137), out: [], ...spec });
      k.el.classList.add('enter');
      cards.unshift(k);
      list.prepend(k.el);
      paint();
      return k;
    }
    function end(k, how) {
      if (k.state !== 'run') return;
      Object.assign(k, { state: how, ms: performance.now() - k.t0 }, how === 'done' ? { code: 0, events: k.events + 1, out: [...k.out, '# pass 14', '# fail 0', 'EXIT=0'] } : {});
      if (k === auto) auto = null;
      k.paint();
      paint();
    }
    const first = card({ ...TEST, since: '11/10 22:38', ms: 702000, state: 'done', code: 0, events: 2, pid, out: ['# pass 14', '# fail 0', 'EXIT=0'] });
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
    c.on('run', (on) => { if (on && !auto) auto = start(TEST); });   // 它跑起来就挂一条盯回归
    c.on('status', (cur) => {
      if (ENDED.includes(cur.status)) for (const k of cards.filter((x) => x.state === 'run')) end(k, cur.status === 'done' && k === auto ? 'done' : 'stop');
      gate();
    });
    gate();
    paint();
    return [blocked, form, head, list, empty];
  };
});
