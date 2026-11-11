/* 样机的骨架：注册、路由、浮层三件（菜单、Select、提示）、主题与减少动效、对照清单。 */
(() => {
  const { h, $, $$, icon } = ASH;

  ASH.surface = (name, def) => { ASH.surfaces[name] = def; };
  ASH.part = (name, def) => { ASH.partDefs[name] = def; };
  ASH.mount = (name, el, ctx) => (ASH.parts[name] = ASH.partDefs[name]?.mount(el, ctx) ?? {});
  ASH.go = (route) => { location.hash = route.replace(/^#?\/?/, '#/'); };

  /* 样机里用的任务：status 有 running / waiting / failed / queued / done / stopped；read、accepted 只对 done 有意义。
     accepted: false = 做完了还没验收（真实产品里是一颗一直在的靛蓝环，算进「需要你处理」） */
  ASH.data = {
    project: 'harness',
    current: 't-cur',
    tasks: [
      { id: 't-run', title: '斜杠补全：已有正文后面敲 / 也弹', status: 'running', agent: 'claude', when: '刚刚' },
      { id: 't-ask', title: '合并移动端轮询', status: 'waiting', why: '等你答复', agent: 'codex', when: '6 分钟前' },
      { id: 't-rev', title: '验收闸：失败后重跑的例外', status: 'waiting', why: '审查打回 2 条，等你裁定', agent: 'claude', when: '18 分钟前' },
      { id: 't-cur', title: '裁定「不用改了」后审查卡死', status: 'done', read: true, accepted: false, agent: 'claude', origin: 'Claude 派生', when: '31 分钟前' },
      { id: 't-fail', title: '回复框：原生命令的回车被吞掉', status: 'failed', agent: 'claude', origin: 'Claude 派生', when: '1 小时前' },
      { id: 't-q', title: '导出周报', status: 'queued', agent: 'codex', when: '1 小时前' },
      { id: 't-new', title: '侧栏宽度记不住', status: 'done', read: false, accepted: true, agent: 'claude', when: '2 小时前' },
      { id: 't-d1', title: '起手式站点线的站名放大', status: 'done', read: true, accepted: true, agent: 'claude', when: '昨天' },
      { id: 't-d2', title: 'worktree 被删后任务卡在运行中', status: 'done', read: true, accepted: true, agent: 'codex', when: '昨天' },
      { id: 't-d3', title: '同仓库 git 写操作排队', status: 'done', read: true, accepted: true, agent: 'claude', when: '11/09', pinned: true },
      { id: 't-d4', title: '团队执行者的审查默认开启', status: 'done', read: true, accepted: true, agent: 'claude', kind: 'team', when: '11/09' },
      { id: 't-d5', title: '压缩失败时换上游重发', status: 'done', read: true, accepted: true, agent: 'claude', when: '11/08' },
    ],
  };

  /* ---------- 浮层：一次只开一个；点外面、按 Esc、再点触发器都会关 ---------- */
  let open = null;
  ASH.closePop = () => open?.();
  ASH.pop = (anchor, content, { place = 'bottom-start', gap = 6, cls = '' } = {}) => {
    if (open?.anchor === anchor) { open(); return null; }
    open?.();
    const el = h('div.pop', {}, content);
    if (cls) el.classList.add(...cls.split(' '));
    document.body.append(el);
    const a = anchor.getBoundingClientRect();
    const r = { width: el.offsetWidth, height: el.offsetHeight }; /* 进场前浮层还缩着 0.98，量布局尺寸才准 */
    let x = place.endsWith('end') ? a.right - r.width : a.left;
    let y = place.startsWith('top') ? a.top - r.height - gap : a.bottom + gap;
    let up = place.startsWith('top');
    if (!up && y + r.height > innerHeight - 8 && a.top - r.height - gap > 8) { y = a.top - r.height - gap; up = true; }
    x = Math.max(8, Math.min(x, innerWidth - r.width - 8));
    y = Math.max(8, y);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.setProperty('--origin', `${up ? 'bottom' : 'top'} ${place.endsWith('end') ? 'right' : 'left'}`);
    requestAnimationFrame(() => el.classList.add('is-in'));
    anchor.setAttribute('aria-expanded', 'true');
    const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
    const key = (e) => { if (e.key === 'Escape') { close(); anchor.focus(); } };
    function close() {
      if (open !== close) return;
      open = null;
      anchor.setAttribute('aria-expanded', 'false');
      removeEventListener('pointerdown', outside, true);
      removeEventListener('keydown', key, true);
      el.classList.remove('is-in');
      setTimeout(() => el.remove(), 130);
    }
    close.anchor = anchor;
    close.el = el;
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', key, true);
    open = close;
    return close;
  };

  /* 菜单：items 里是 { label, icon, kbd, onpick, disabled, selected } / '-'（分隔线）/ 字符串（小标题）。上下键走，回车选 */
  ASH.menu = (anchor, items, opts = {}) => {
    const list = h('div.menu', { role: opts.role ?? 'menu' }, items.map((it) => {
      if (it === '-') return h('hr');
      if (typeof it === 'string') return h('small', it);
      return h('button', { role: opts.role === 'listbox' ? 'option' : 'menuitem', disabled: it.disabled, 'aria-selected': it.selected ? 'true' : null,
        onclick: () => { ASH.closePop(); anchor.focus({ preventScroll: true }); it.onpick?.(); } }, it.icon && icon(it.icon), h('span', it.label), it.kbd && h('kbd', it.kbd));
    }));
    const close = ASH.pop(anchor, list, { ...opts, cls: `${opts.cls ?? ''} ${opts.role === 'listbox' ? 'sel-menu' : ''}`.trim() });
    if (!close) return null;
    const btns = () => $$('button:not([disabled])', list);
    list.addEventListener('keydown', (e) => {
      const all = btns();
      const i = all.indexOf(document.activeElement);
      const to = { ArrowDown: all[(i + 1) % all.length], ArrowUp: all[(i - 1 + all.length) % all.length], Home: all[0], End: all.at(-1) }[e.key];
      if (to) { e.preventDefault(); to.focus(); return; }
      if (e.key === 'Tab') close();
      if (e.key.length === 1) all.find((b) => b.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()))?.focus();
    });
    (list.querySelector('[aria-selected="true"]') ?? btns()[0])?.focus({ preventScroll: true });
    return close;
  };

  /* Select：全应用只有这一个。options 是 [{ value, label }] */
  ASH.select = ({ value, options, onchange, label, width }) => {
    const text = h('span', options.find((o) => o.value === value)?.label ?? '');
    const btn = h('button.sel', { type: 'button', 'aria-haspopup': 'listbox', 'aria-label': label, style: width ? { minWidth: `${width}px` } : null }, text, icon('caret'));
    btn.addEventListener('click', () => ASH.menu(btn, options.map((o) => ({ label: o.label, selected: o.value === value, onpick: () => { value = o.value; text.textContent = o.label; btn.focus(); onchange?.(value); } })), { role: 'listbox' }));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); btn.click(); } });
    return btn;
  };

  /* 确认框：回不去的动作（删除这一类）都走这一个。居中、有遮罩；Esc 或点遮罩 = 取消，关掉后焦点回到触发处。
     const yes = await ASH.confirm({ title, body, ok: '删除', danger: true }) */
  ASH.confirm = ({ title, body, ok = '确定', danger = false }) => new Promise((done) => {
    ASH.closePop();
    const back = document.activeElement;
    const yes = h(`button.btn${danger ? '.danger' : '.pri'}`, { type: 'button' }, ok);
    const no = h('button.btn', { type: 'button' }, '取消');
    const veil = h('div.veil', {}, h('div.dlg', { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', title), body && h('p', body), h('div.dlg-acts', no, yes)));
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === yes ? no : yes).focus(); }
    };
    function close(answer) {
      removeEventListener('keydown', key, true);
      veil.classList.remove('is-in');
      setTimeout(() => veil.remove(), 130);
      back?.focus?.({ preventScroll: true });
      done(answer);
    }
    yes.onclick = () => close(true);
    no.onclick = () => close(false);
    veil.addEventListener('pointerdown', (e) => { if (e.target === veil) close(false); });
    addEventListener('keydown', key, true);
    document.body.append(veil);
    requestAnimationFrame(() => veil.classList.add('is-in'));
    no.focus();
  });

  /* 提示：data-tip（可带 data-key）。第一次等 0.4 秒，0.3 秒内接着看下一个不等；键盘聚焦不等 */
  const tip = h('div', { id: 'tip', role: 'tooltip' });
  let tipTimer = 0;
  let warmUntil = 0;
  const showTip = (el) => {
    const r = el.getBoundingClientRect();
    tip.replaceChildren(el.dataset.tip, el.dataset.key ? h('kbd', el.dataset.key) : '');
    tip.classList.add('is-in');
    const t = tip.getBoundingClientRect();
    const side = el.dataset.tipSide;
    const x = side === 'left' ? r.left - t.width - 8 : side === 'right' ? r.right + 8 : r.left + r.width / 2 - t.width / 2;
    const y = side ? r.top + r.height / 2 - t.height / 2 : r.top - t.height - 6 < 4 ? r.bottom + 6 : r.top - t.height - 6;
    tip.style.left = `${Math.max(6, Math.min(x, innerWidth - t.width - 6))}px`;
    tip.style.top = `${y}px`;
  };
  const hideTip = () => { clearTimeout(tipTimer); if (tip.classList.contains('is-in')) warmUntil = performance.now() + 300; tip.classList.remove('is-in'); };
  addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    hideTip();
    if (el) tipTimer = setTimeout(() => showTip(el), performance.now() < warmUntil ? 0 : 400);
  });
  addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-tip]'); if (el?.matches(':focus-visible')) showTip(el); });
  addEventListener('focusout', hideTip);
  addEventListener('pointerdown', hideTip, true);
  addEventListener('scroll', hideTip, true);

  /* ---------- 路由：#/task、#/home、#/new、#/settings/<页>、#/git、#/chat、#/assistant；?m=<清单条目> 定位 ---------- */
  let current = null;
  let cleanup = null;
  const parse = () => {
    const [path, query = ''] = (location.hash.replace(/^#\/?/, '') || 'task').split('?');
    const [name, sub] = path.split('/');
    return { name: ASH.surfaces[name] ? name : 'task', sub, params: new URLSearchParams(query) };
  };
  function render() {
    const route = parse();
    const main = $('#main');
    if (!current || current.name !== route.name || current.sub !== route.sub) {
      ASH.closePop();
      cleanup?.();
      main.replaceChildren();
      document.body.dataset.surface = route.name;
      document.body.dataset.chrome = ASH.surfaces[route.name].chrome ?? 'app';
      cleanup = ASH.surfaces[route.name].mount(main, route) ?? null;
      current = route;
      for (const a of $$('.dbar nav a')) a.toggleAttribute('aria-current', false);
      $(`.dbar nav a[href^="#/${route.name}"]`)?.setAttribute('aria-current', 'page');
      ASH.emit('route', route);
    }
    const mark = route.params.get('m');
    if (mark) {
      /* 从报告点进来：清单那一列直接到位，不走宽度过渡——否则 prep 打开的浮层是按「清单还没出来」的布局量的 */
      if (!document.body.classList.contains('notes-on')) {
        const notes = $('#notes');
        notes.style.transition = 'none';
        document.body.classList.add('notes-on');
        void notes.offsetWidth;
        notes.style.transition = '';
      }
      requestAnimationFrame(() => ASH.focusMark(mark));
    }
    ASH.notes?.render(route);
  }

  /* ---------- 开关：深色、减少动效、对照清单 ---------- */
  const root = document.documentElement;
  const toggle = (btn, on) => btn.setAttribute('aria-pressed', String(on));
  function boot() {
    const params = new URLSearchParams(location.search);
    if (params.get('theme') === 'dark') root.dataset.theme = 'dark';
    if (params.get('motion')) root.dataset.motion = params.get('motion');
    if (params.has('embed')) document.body.classList.add('embed');
    document.body.append(tip);
    ASH.mount('side', $('#side'));
    $('#themeBtn').addEventListener('click', (e) => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; toggle(e.currentTarget, root.dataset.theme === 'dark'); });
    $('#motionBtn').addEventListener('click', (e) => { root.dataset.motion = ASH.reduced() ? 'full' : 'reduce'; toggle(e.currentTarget, ASH.reduced()); });
    $('#notesBtn').addEventListener('click', (e) => { toggle(e.currentTarget, document.body.classList.toggle('notes-on')); ASH.notes?.render(current); });
    toggle($('#themeBtn'), root.dataset.theme === 'dark');
    toggle($('#motionBtn'), ASH.reduced());
    addEventListener('hashchange', render);
    render();
    toggle($('#notesBtn'), document.body.classList.contains('notes-on'));
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
