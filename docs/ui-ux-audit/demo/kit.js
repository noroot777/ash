/* 样机的小工具：造节点、图标、事件、几种动效的唯一实现。先于其他脚本加载。 */
(() => {
  const ASH = (window.ASH = { surfaces: {}, partDefs: {}, parts: {}, prep: {} });

  /* h('button.btn.pri', { onclick, 'data-m': 'x' }, child, 'text')；第二个参数不是普通对象就当成子节点 */
  ASH.h = (spec, attrs, ...kids) => {
    if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; }
    const [tag, ...cls] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (cls.length) el.className = cls.join(' ');
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat(Infinity).filter((kid) => kid != null && kid !== false));
    return el;
  };
  ASH.$ = (sel, root = document) => root.querySelector(sel);
  ASH.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* 图标：16 格、1.4 描边。各面缺的自己往 ASH.icons 里加 */
  ASH.icons = {
    more: '<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',
    panel: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>',
    sidebar: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
    fork: '<circle cx="4" cy="3.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4 5v1.5a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V5M8 8.5V11"/>',
    redo: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>',
    undo: '<path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3"/>',
    clip: '<path d="M13 7.5 8 12.5a3 3 0 0 1-4.3-4.2l5-5a2 2 0 0 1 2.9 2.8l-5 5a1 1 0 0 1-1.5-1.4L9.5 5.5"/>',
    up: '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
    down: '<path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/>',
    top: '<path d="M4 3h8M8 13V6M4.5 9.5 8 6l3.5 3.5"/>',
    bottom: '<path d="M4 13h8M8 3v7M4.5 6.5 8 10l3.5-3.5"/>',
    check: '<path d="m3 8.5 3.2 3L13 4.5"/>',
    warn: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.6M8 11v.2"/>',
    info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3v3.4M8 5.2v.2"/>',
    help: '<circle cx="8" cy="8" r="5.5"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.4 1.9c-.5.3-.8.6-.8 1.2M8 11.3v.2"/>',
    pin: '<path d="M6 2.5h4l-.5 4 2.3 2.5H4.2l2.3-2.5z"/><path d="M8 9v4.5"/>',
    star: '<path d="m8 2.2 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z"/>',
    caret: '<path d="m4 6 4 4 4-4"/>',
    chev: '<path d="m6 4 4 4-4 4"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
    sand: '<path d="M4.5 2.5h7M4.5 13.5h7M5.5 2.5v2.3L8 8l2.5-3.2V2.5M5.5 13.5v-2.3L8 8l2.5 3.2v2.3"/>',
    x: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
    sliders: '<path d="M2.5 5h7M12 5h1.5M2.5 11h1.5M6.5 11h7"/><circle cx="10.5" cy="5" r="1.5"/><circle cx="5" cy="11" r="1.5"/>',
    filter: '<path d="M2.5 4h11M4.5 8h7M6.5 12h3"/>',
    list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.2M2.5 8h.2M2.5 12h.2"/>',
    queue: '<path d="M3 5h10M3 8h10M3 11h6"/>',
    folder: '<path d="M2.5 4.5a1 1 0 0 1 1-1h2.6l1.4 1.5h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
    file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
    image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="m2.5 10.5 3-3 3 3 2-2 3 3"/><circle cx="10.5" cy="6" r="1"/>',
    box: '<path d="m8 2 5 2.7v6.6L8 14l-5-2.7V4.7z"/><path d="m3 4.7 5 2.7 5-2.7M8 7.4V14"/>',
    diff: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.6-3.4 2-5.4 3.6"/>',
    commit: '<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>',
    note: '<path d="M3.5 2.5h9v7l-3.5 4H3.5z"/><path d="M12.5 9.5H9v4"/>',
    chat: '<path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z"/>',
    flow: '<circle cx="3.5" cy="8" r="1.5"/><circle cx="12.5" cy="4" r="1.5"/><circle cx="12.5" cy="12" r="1.5"/><path d="M5 8h1.5c2 0 1.5-4 4.5-4M6.5 8c2 0 1.5 4 4.5 4"/>',
    shield: '<path d="M8 2 3.5 3.8v3.7c0 3 1.9 5 4.5 6.5 2.6-1.5 4.5-3.5 4.5-6.5V3.8z"/><path d="m6 8 1.5 1.5 2.7-2.9"/>',
    eye: '<path d="M1.5 8S3.9 3.5 8 3.5 14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    pulse: '<path d="M1.5 8.5h3l1.5-4 3 7.5 1.5-3.5h4"/>',
    bot: '<rect x="3" y="5.5" width="10" height="7.5" rx="2"/><path d="M8 5.5V3M6 9v1M10 9v1"/>',
    user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-2.5 2.6-3.8 5-3.8s4.4 1.3 5 3.8"/>',
    team: '<circle cx="6" cy="6" r="2.2"/><path d="M2 13c.4-2 1.9-3.2 4-3.2s3.6 1.2 4 3.2M10.5 4a2.2 2.2 0 0 1 0 4.3M12 9.9c1.2.5 1.8 1.6 2 3.1"/>',
    stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/>',
    play: '<path d="M5 3.5v9l7.5-4.5z"/>',
    send: '<path d="M14 2 7 9M14 2 9.5 14 7 9 2 6.5z"/>',
    term: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="m4.8 6.5 2 1.8-2 1.8M8.5 10.2h2.7"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
    edit: '<path d="m3 13 .5-2.8 7-7 2.3 2.3-7 7z"/>',
    ext: '<path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5"/>',
    link: '<path d="M6.8 9.2 9.2 6.8M7.5 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M8.5 11.5l-1 1A2.5 2.5 0 0 1 4 9l1-1"/>',
    home: '<path d="M2.5 7.5 8 3l5.5 4.5V13h-4V9.5h-3V13h-4z"/>',
    globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/>',
    tool: '<path d="M10.5 2.5a3.2 3.2 0 0 0-2.9 4.6L2.5 12.2l1.3 1.3 5.1-5.1a3.2 3.2 0 0 0 4.6-2.9l-2 2-1.9-.6-.6-1.9z"/>',
    camera: '<rect x="2" y="4.5" width="12" height="8.5" rx="1.5"/><circle cx="8" cy="8.8" r="2.2"/><path d="M6 4.5 6.8 3h2.4l.8 1.5"/>',
    monitor: '<rect x="2.5" y="3.5" width="11" height="7.5" rx="1.5"/><path d="M6 13.5h4M8 11v2.5"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>',
    bolt: '<path d="M9 2 3.5 9h4L7 14l5.5-7h-4z"/>',
    sun: '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2"/>',
    moon: '<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z"/>',
    spark: '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12"/>',
  };
  ASH.icon = (name, cls = '') => {
    const t = document.createElement('template');
    t.innerHTML = `<svg class="i ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ASH.icons[name] ?? ''}</svg>`;
    return t.content.firstChild;
  };

  /* 事件：各面之间只通过它说话（task:status、usage、run:start、run:end …） */
  const listeners = {};
  ASH.on = (evt, fn) => { (listeners[evt] ??= new Set()).add(fn); return () => listeners[evt].delete(fn); };
  ASH.emit = (evt, data) => { for (const fn of listeners[evt] ?? []) fn(data); };

  ASH.reduced = () => {
    const mode = document.documentElement.dataset.motion;
    return mode === 'reduce' || (mode !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  };
  ASH.wait = (ms) => new Promise((done) => setTimeout(done, ms));

  /* 用时：59s / 1m 05s / 1h 02m；大数：182k / 48.9M */
  ASH.dur = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  };
  ASH.num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

  /* 换字：旧的上去，新的上来。同一个元素连着换时只认最后一次。
     字换了宽度会变：给了 row（它所在的那一排）时，排里别的东西从旧位置滑到新位置，不会一帧横跳 */
  ASH.swap = (el, text, { row } = {}) => {
    clearTimeout(el._swap);
    if (el.textContent === text) { el.classList.remove('is-out'); return; }
    if (ASH.reduced()) { el.textContent = text; return; }
    el.classList.add('swap');
    el.classList.add('is-out');
    el._swap = setTimeout(() => {
      const put = () => { el.textContent = text; };
      if (row?.isConnected) ASH.flip(row, put, { skip: el, ms: 200 }); else put();
      el.classList.remove('is-out');
      el.classList.add('is-pre');
      void el.offsetWidth;
      el.classList.remove('is-pre');
    }, 150);
  };

  /* 数字滚到新值：配等宽数字，位置不抖。时长和 --dur-3 同值 */
  ASH.roll = (el, to, { ms = 320, fmt = ASH.num } = {}) => {
    const from = Number(el.dataset.v ?? to);
    el.dataset.v = to;
    el.classList.add('num');
    cancelAnimationFrame(el._roll);
    if (ASH.reduced() || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.max(0, Math.min(1, (now - t0) / ms));   /* rAF 给的时刻可能比 t0 还早：不夹住的话第一帧会朝反方向冲一下 */
      el.textContent = fmt(from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1) el._roll = requestAnimationFrame(tick);
    };
    el._roll = requestAnimationFrame(tick);
  };

  /* 重排：先记下每个孩子在哪，改完，再让它们从原位滑到新位（只动 transform）。
     原来不在、或者原来藏着的（量出来是零）算新来的：淡入。skip 是自己另有过渡的那一个（它或者装着它的那个孩子不滑） */
  ASH.flip = (container, mutate, { skip, ms = 320 } = {}) => {
    const kids = [...container.children];
    const before = new Map(kids.map((kid) => [kid, kid.getBoundingClientRect()]));
    mutate();
    if (ASH.reduced()) return;
    const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';
    for (const kid of container.children) {
      if (skip && (kid === skip || kid.contains(skip))) continue;
      const was = before.get(kid);
      const now = kid.getBoundingClientRect();
      if (!now.width && !now.height) continue;
      if (!was || (!was.width && !was.height)) { kid.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing }); continue; }
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (dx || dy) kid.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: ms, easing });
    }
  };

  /* 短提示：保存、复制之后那一句。底部居中，2.4 秒后自己走；连着来只留最新的一句 */
  let toastEl = null;
  let toastTimer = 0;
  ASH.toast = (text) => {
    toastEl ??= document.body.appendChild(ASH.h('div.toast', { role: 'status' }));
    toastEl.textContent = text;
    toastEl.classList.add('is-in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-in'), 2400);
  };
})();
