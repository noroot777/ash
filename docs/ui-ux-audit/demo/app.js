/* 样机的骨架：注册、路由、浮层（菜单、Select、提示）、盖住整页的层（ASH.sheet，确认框走它）、短去处表、深浅色偏好、减少动效、对照清单。数据在 data.js。 */
(() => {
  const { h, $, $$, icon } = ASH;

  ASH.surface = (name, def) => { ASH.surfaces[name] = def; };
  ASH.part = (name, def) => { ASH.partDefs[name] = def; };
  ASH.mount = (name, el, ctx) => (ASH.parts[name] = ASH.partDefs[name]?.mount(el, ctx) ?? {});
  ASH.go = (route) => { location.hash = route.replace(/^#?\/?/, '#/'); };

  /* ---------- 浮层：一次只开一个；点外面、按 Esc、再点触发器都会关（onclose 在它关掉的那一刻叫一声） ---------- */
  let open = null;
  ASH.closePop = () => open?.();
  ASH.pop = (anchor, content, { place = 'bottom-start', gap = 6, cls = '', onclose } = {}) => {
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
    const key = (e) => { if (e.key === 'Escape') { close(); if (!anchor.contains(document.activeElement)) anchor.focus(); } };
    function close() {
      if (open !== close) return;
      open = null;
      anchor.setAttribute('aria-expanded', 'false');
      removeEventListener('pointerdown', outside, true);
      removeEventListener('keydown', key, true);
      el.classList.remove('is-in');
      setTimeout(() => el.remove(), 130);
      onclose?.();
    }
    close.anchor = anchor;
    close.el = el;
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', key, true);
    open = close;
    return close;
  };

  /* 菜单：items 里是 { label, icon, kbd, hint, onpick, disabled, selected, danger } / '-'（分隔线）/ 字符串（小标题）。上下键走，回车选。
     hint 是排在右边的一句说明字；danger 是回不去的那一项（红） */
  ASH.menu = (anchor, items, opts = {}) => {
    const list = h('div.menu', { role: opts.role ?? 'menu' }, items.map((it) => {
      if (it === '-') return h('hr');
      if (typeof it === 'string') return h('small', it);
      return h(`button${it.danger ? '.danger' : ''}`, { type: 'button', role: opts.role === 'listbox' ? 'option' : 'menuitem', disabled: it.disabled, 'aria-selected': it.selected ? 'true' : null,
        onclick: () => { ASH.closePop(); anchor.focus({ preventScroll: true }); it.onpick?.(); } }, it.icon && icon(it.icon), h('span', it.label), it.hint && h('em', it.hint), it.kbd && h('kbd', it.kbd));
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

  /* Select：全应用只有这一个，两档——表单里的带框（缺省），表格和键值行里的紧凑档（compact: true，无框、24 高）。
     options 是 [{ value, label, hint?, disabled?, onpick? }] 或 '-'：hint 是右边的说明字；带 onpick 的是一个动作（「新建分组…」），选了不改值。
     返回的按钮上有 set(value)：从外面改它显示的值，不触发 onchange */
  ASH.select = ({ value, options, onchange, label, width, compact }) => {
    const find = (v) => options.find((o) => o !== '-' && !o.onpick && o.value === v);
    const text = h('span', find(value)?.label ?? '');
    const btn = h(`button.sel${compact ? '.sm' : ''}`, { type: 'button', 'aria-haspopup': 'listbox', 'aria-label': label, style: width ? { minWidth: `${width}px` } : null }, text, icon('caret'));
    btn.set = (next) => { value = next; text.textContent = find(next)?.label ?? ''; };
    btn.addEventListener('click', () => ASH.menu(btn, options.map((o) => (o === '-' ? '-' : { label: o.label, hint: o.hint, disabled: o.disabled, selected: !o.onpick && o.value === value,
      onpick: () => { btn.focus(); if (o.onpick) { o.onpick(); return; } btn.set(o.value); onchange?.(value); } })), { role: 'listbox' }));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); btn.click(); } });
    return btn;
  };

  /* 盖住整页的层（确认框、对话框、命令面板）：全应用一个入口，开一层登记一层。
     Esc 和 Tab 只交给最上面那层（它里面还开着菜单时，Esc 先关菜单）；点遮罩 = 关；关掉后焦点回到开它之前的地方；换面时全部收掉。
     const close = ASH.sheet(node, { cls, onclose(value), keep })；close(value) 关掉并把 value 交给 onclose。keep：点里面的东西不抢走焦点（命令面板） */
  const sheets = [];
  const tip = h('div', { id: 'tip', role: 'tooltip' });
  ASH.sheet = (node, { cls = '', onclose, keep = false } = {}) => {
    ASH.closePop();
    const back = document.activeElement;
    const veil = h('div.veil', {}, node);
    if (cls) veil.classList.add(...cls.split(' '));
    const entry = { veil, keep };
    const close = (value) => {
      const at = sheets.indexOf(entry);
      if (at < 0) return;
      sheets.splice(at, 1);
      veil.classList.remove('is-in');
      setTimeout(() => veil.remove(), 130);
      if (back?.isConnected) back.focus?.({ preventScroll: true });
      onclose?.(value);
    };
    entry.close = close;
    veil.addEventListener('pointerdown', (e) => { if (e.target === veil) close(); else if (keep && !e.target.matches('input, textarea')) e.preventDefault(); });
    sheets.push(entry);
    if (tip.isConnected) tip.before(veil); else document.body.append(veil);   /* 垫在提示底下：层里的提示才盖得住遮罩 */
    requestAnimationFrame(() => veil.classList.add('is-in'));
    return close;
  };
  ASH.sheetOpen = () => sheets.length > 0;
  addEventListener('keydown', (e) => {
    const top = sheets.at(-1);
    if (!top || open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); top.close(); return; }
    if (e.key !== 'Tab') return;
    if (top.keep) { e.preventDefault(); return; }
    const all = $$('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]', top.veil).filter((el) => el.offsetParent);
    if (!all.length) return;
    e.preventDefault();
    all[(all.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
  }, true);

  /* 确认框：回不去的动作（删除这一类）都走这一个。居中、有遮罩；Esc 或点遮罩 = 取消，关掉后焦点回到触发处。
     const yes = await ASH.confirm({ title, body, ok: '删除', danger: true }) */
  ASH.confirm = ({ title, body, ok = '确定', danger = false }) => new Promise((done) => {
    const yes = h(`button.btn${danger ? '.danger' : '.pri'}`, { type: 'button', onclick: () => close(true) }, ok);
    const no = h('button.btn', { type: 'button', onclick: () => close(false) }, '取消');
    const close = ASH.sheet(h('div.dlg', { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', title), body && h('p', body), h('div.dlg-acts', no, yes)),
      { onclose: (answer) => done(Boolean(answer)) });
    no.focus();
  });

  /* 提示：data-tip（可带 data-key）。第一次等 0.4 秒，0.3 秒内接着看下一个不等；键盘聚焦不等 */
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

  /* 样机没画下去的去处（F 铺开的宽列表、差异查看……）：产品的界面里不解释，只在样机自己那条栏里说一句 */
  let sayTimer = 0;
  ASH.todo = (what) => {
    const say = $('#dbarSay');
    say.textContent = `样机没画这一步：${what}`;
    say.classList.add('is-in');
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => say.classList.remove('is-in'), 2600);
  };
  /* 通往别处的入口发的事件。改动工作区（验收台）在任务页画了一张占位，由它自己接 changes:open；其余的只说一句 */
  const ELSEWHERE = { 'diff:open': '差异查看', 'file:open': '文件查看', 'folder:open': '文件夹详情', 'preview:open': '预览指正的工作区', 'files:reveal': '交给系统去打开', 'queue:open': '队列抽屉', 'task:open': '别的任务的会话' };
  for (const [evt, name] of Object.entries(ELSEWHERE)) ASH.on(evt, () => ASH.todo(name));

  /* 深浅色：一份偏好（system / light / dark），缺省跟随系统。样机栏的「深色」键、侧栏项目菜单、设置页那颗分段读写的都是它；改了发 theme:change */
  const root = document.documentElement;
  const sysDark = matchMedia('(prefers-color-scheme: dark)');
  ASH.theme = {
    pref: 'system',
    get dark() { return root.dataset.theme === 'dark'; },
    set(pref) {
      ASH.theme.pref = pref;
      root.dataset.theme = pref === 'system' ? (sysDark.matches ? 'dark' : 'light') : pref;
      ASH.emit('theme:change', pref);
    },
  };
  sysDark.addEventListener('change', () => { if (ASH.theme.pref === 'system') ASH.theme.set('system'); });

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
      for (const layer of [...sheets]) layer.close();
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
  const toggle = (btn, on) => btn.setAttribute('aria-pressed', String(on));
  function boot() {
    const params = new URLSearchParams(location.search);
    ASH.theme.set(['dark', 'light'].includes(params.get('theme')) ? params.get('theme') : 'system');
    if (params.get('motion')) root.dataset.motion = params.get('motion');
    if (params.has('embed')) document.body.classList.add('embed', `embed-${params.get('embed') || 'feed'}`);
    document.body.append(tip);
    ASH.mount('side', $('#side'));
    $('#themeBtn').addEventListener('click', () => ASH.theme.set(ASH.theme.dark ? 'light' : 'dark'));
    ASH.on('theme:change', () => toggle($('#themeBtn'), ASH.theme.dark));
    $('#motionBtn').addEventListener('click', (e) => { root.dataset.motion = ASH.reduced() ? 'full' : 'reduce'; toggle(e.currentTarget, ASH.reduced()); });
    $('#notesBtn').addEventListener('click', (e) => { toggle(e.currentTarget, document.body.classList.toggle('notes-on')); ASH.notes?.render(current); });
    toggle($('#themeBtn'), ASH.theme.dark);
    toggle($('#motionBtn'), ASH.reduced());
    addEventListener('hashchange', render);
    render();
    toggle($('#notesBtn'), document.body.classList.contains('notes-on'));
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
