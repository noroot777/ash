// 报告页的全部脚本：图标表、两张分布图、逐面清单、滚动淡入、五个「现在 / 之后」对照演示、发送设置与右侧面板两个样机、嵌进来的执行中样机。
// anime.js 从 CDN 动态加载；连不上时右栏退回 WAAPI，并在页面上如实写明。

const ANIME_URL = 'https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.esm.min.js';
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- 图标：页面里的 <svg><use href="#i-名字"/></svg> 引用的都是这一张表（16 格、描边） ---------- */

const ICONS = {
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  monitor: '<rect x="2.5" y="3.5" width="11" height="7.5" rx="1.5"/><path d="M6 13.5h4M8 11v2.5"/>',
  send: '<path d="M14 2 7 9M14 2 9.5 14 7 9 2 6.5z"/>',
  more: '<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',
  panel: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  fork: '<circle cx="4" cy="3.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4 5v1.5a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V5M8 8.5V11"/>',
  redo: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>',
  clip: '<path d="M13 7.5 8 12.5a3 3 0 0 1-4.3-4.2l5-5a2 2 0 0 1 2.9 2.8l-5 5a1 1 0 0 1-1.5-1.4L9.5 5.5"/>',
  up: '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
  check: '<path d="m3 8.5 3.2 3L13 4.5"/>',
  warn: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.6M8 11v.2"/>',
  pin: '<path d="M6 2.5h4l-.5 4 2.3 2.5H4.2l2.3-2.5z"/><path d="M8 9v4.5"/>',
  caret: '<path d="m4 6 4 4 4-4"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
  sand: '<path d="M4.5 2.5h7M4.5 13.5h7M5.5 2.5v2.3L8 8l2.5-3.2V2.5M5.5 13.5v-2.3L8 8l2.5 3.2v2.3"/>',
  x: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  top: '<path d="M4 3h8M8 13V6M4.5 9.5 8 6l3.5 3.5"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3v3.4M8 5.2v.2"/>',
  folder: '<path d="M2.5 4.5a1 1 0 0 1 1-1h2.6l1.4 1.5h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
  box: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="m2.5 10.5 3-3 3 3 2-2 3 3"/><circle cx="10.5" cy="6" r="1"/>',
  diff: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.6-3.4 2-5.4 3.6"/>',
  note: '<path d="M3.5 2.5h9v7l-3.5 4H3.5z"/><path d="M12.5 9.5H9v4"/>',
  chat: '<path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z"/>',
  flow: '<path d="M2 4.5h2c3.2 0 4.3 7 7.5 7H14M2 11.5h2c1.2 0 2.1-1 2.9-2.2M9.2 6.6c.7-1.2 1.4-2.1 2.3-2.1H14M12 2.5l2 2-2 2M12 9.5l2 2-2 2"/>',
  shield: '<circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.1 3.1"/>',
  eye: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6.5h12"/>',
  pulse: '<path d="M1.5 8.5h3l1.5-4 3 7.5 1.5-3.5h4"/>',
  bot: '<rect x="3" y="5.5" width="10" height="7.5" rx="2"/><path d="M8 5.5V3M6 9v1M10 9v1"/>',
};

function mountIcons() {
  const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sprite.setAttribute('aria-hidden', 'true');
  sprite.setAttribute('width', '0');
  sprite.setAttribute('height', '0');
  sprite.style.position = 'absolute';
  sprite.innerHTML = Object.entries(ICONS).map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 16 16">${body}</symbol>`).join('');
  document.body.prepend(sprite);
}

/* ---------- 分布图 ---------- */

// web/src 下全部 CSS 的 font-size 声明（px），2026-11-11 统计
const FONT_SIZES = [
  [7, 1], [7.5, 1], [8, 9], [8.5, 27], [9, 172], [9.5, 201], [10, 271], [10.5, 200], [11, 289], [11.5, 92],
  [12, 196], [12.5, 70], [13, 71], [13.5, 7], [14, 17], [15, 12], [16, 7], [17, 7], [18, 9],
  [20, 7], [21, 3], [22, 2], [23, 3], [24, 1], [25, 2], [26, 1], [28, 3], [29, 1],
];
const FLOOR_PX = 12;
const HIST_LABELS = new Set([8, 10, 12, 14, 18, 22, 29]);

function drawHistogram(root) {
  if (!root) return;
  const max = Math.max(...FONT_SIZES.map(([, n]) => n));
  for (const [px, n] of FONT_SIZES) {
    const bar = document.createElement('div');
    bar.className = px < FLOOR_PX ? 'bar small' : 'bar';
    bar.style.height = `${(n / max) * 100}%`;
    bar.setAttribute('aria-label', `${px}px：${n} 处`);
    if (HIST_LABELS.has(px)) bar.innerHTML = `<span>${px}</span>`;
    root.append(bar);
  }
  const floorIndex = FONT_SIZES.findIndex(([px]) => px >= FLOOR_PX);
  const floor = document.createElement('div');
  floor.className = 'floor';
  floor.style.left = `calc(${(floorIndex / FONT_SIZES.length) * 100}% - 2px)`;
  floor.innerHTML = `<span>${FLOOR_PX}px 下限</span>`;
  root.append(floor);
}

// 生效的 transition 按逐属性计的时长（ms）与次数，共 163 次；120–160 这五档肉眼分不出
const DURATIONS = [[120, 28], [130, 15], [140, 23], [150, 48], [160, 19], [180, 7], [200, 10], [250, 7], [260, 6]];

function drawDurations(root) {
  if (!root) return;
  const max = Math.max(...DURATIONS.map(([, n]) => n));
  for (const [ms, n] of DURATIONS) {
    const row = document.createElement('div');
    if (ms <= 160) row.className = 'same';
    row.innerHTML = `<span>${ms}ms</span><i style="width:${(n / max) * 100}%"></i><span>${n}</span>`;
    root.append(row);
  }
}

/* ---------- 05 逐面清单：数据在 checklist.js，样机的「对照清单」读的是同一份 ---------- */

function drawChecklist(root) {
  const audit = window.AUDIT;
  if (!root || !audit) return;
  const make = (tag, cls, html) => { const el = document.createElement(tag); el.className = cls; el.innerHTML = html; return el; };
  let n = 0;
  for (const surface of audit.surfaces) {
    const block = make('div', 'cl', `<h3>${surface.name}<a href="demo.html${surface.at}">在样机里看</a></h3>`);
    const list = make('ol', '', '');
    for (const item of audit.items.filter((it) => it.s === surface.key)) {
      n += 1;
      const href = `demo.html${item.at ?? surface.at}?m=${item.id}`;
      const text = item.keep ? `<p>${item.now}</p>` : `<p class="was">${item.now}</p><p>${item.after}</p>`;
      const ask = item.ask ? `<p class="ask">${item.ask}</p>` : '';
      list.append(make('li', item.keep ? 'keep' : item.p, `<a href="${href}" aria-label="在样机里看第 ${n} 条"><img src="shots/after/${item.id}.webp" alt="" loading="lazy"></a><i>${n}</i><div>${text}${ask}</div>`));
    }
    block.append(list);
    root.append(block);
  }
  const asks = audit.items.filter((it) => it.ask).length;
  const tag = $('.legend .ask');
  if (tag) tag.textContent = `要你点头 ${asks} 处`;
}

/* ---------- 06 执行中：嵌进来的是样机的会话那一列，隔着 iframe 只能递消息 ---------- */

function setupRun(root) {
  const frame = $('iframe', root);
  if (!frame) return;
  // 地址只设一次：先写在 src 里再按主题改，第一次加载会被掐掉，白白报一串请求失败
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  frame.loading = 'lazy';
  frame.src = dark ? frame.dataset.src.replace('?embed', '?embed&theme=dark') : frame.dataset.src;
  for (const btn of $$('[data-run]', root)) btn.addEventListener('click', () => frame.contentWindow?.postMessage({ ash: 'play', name: btn.dataset.run }, '*'));
}

/* ---------- 滚动淡入 ---------- */

function setupReveal() {
  const targets = $$('.head, .shot, .notes, .kind, .cause, .versus, .rewrite, .tabs4, .pair, .cl, .split, .layers, .demo, .map, .steps');
  if (reduceMotion || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const el of targets) {
    // 已经在视口里的不藏，避免首屏闪一下
    if (el.getBoundingClientRect().top < innerHeight) continue;
    el.classList.add('reveal');
    io.observe(el);
  }
}

/* ---------- anime.js 加载 ---------- */

let anime = null;

function loadAnime() {
  const status = $('.d-status');
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000));
  return Promise.race([import(ANIME_URL), timeout])
    .then((mod) => {
      anime = mod;
      if (status) status.textContent = 'anime.js 4.5.0 已从 jsDelivr 加载：后三个演示的右栏由它驱动。';
    })
    .catch(() => {
      if (status) status.textContent = '没连上 jsDelivr：后三个演示的右栏改用 WAAPI 近似，手感略有差别。';
    });
}

/* ---------- A 菜单开合：纯 CSS ---------- */

function demoMenu(root) {
  let open = false;
  return () => {
    open = !open;
    for (const menu of $$('.d-menu', root)) menu.classList.toggle('open', open);
  };
}

/* ---------- B 列表重排 ---------- */

const LIST_ITEMS = ['修复斜杠补全回车', '审查界面与动效', '合并移动端轮询', '起手式站点线', '导出周报'];
const LIST_LABEL = { run: '运行中', wait: '等你处理', fresh: '刚完成' };
// 真实的排序只有一条：按更新时间倒序。所以哪一行的状态变了，它就跳到最上面——完成也是往上跳，不是沉底
const LIST_FRAMES = [
  { order: [0, 1, 2, 3, 4], state: { 0: 'run', 1: 'run' } },
  { order: [3, 0, 1, 2, 4], state: { 0: 'run', 1: 'run', 3: 'wait' } },
  { order: [1, 3, 0, 2, 4], state: { 0: 'run', 1: 'fresh', 3: 'wait' } },
  { order: [3, 1, 0, 2, 4], state: { 0: 'run', 1: 'fresh', 3: 'run' } },
];

function buildList(list) {
  list.replaceChildren(...LIST_ITEMS.map((name, id) => {
    const li = document.createElement('li');
    li.dataset.id = String(id);
    li.innerHTML = `${name}<span></span>`;
    return li;
  }));
  applyFrame(list, LIST_FRAMES[0]);
}

function applyFrame(list, frame) {
  const byId = new Map($$('li', list).map((li) => [Number(li.dataset.id), li]));
  for (const id of frame.order) {
    const li = byId.get(id);
    const s = frame.state[id] ?? '';
    li.dataset.s = s;
    $('span', li).textContent = LIST_LABEL[s] ?? '';
    list.append(li);
  }
}

// 手写 FLIP：记下旧位置 → 改 DOM → 从旧位置补到新位置
function flip(list, mutate) {
  const before = new Map($$('li', list).map((li) => [li, li.getBoundingClientRect().top]));
  mutate();
  for (const [li, top] of before) {
    const dy = top - li.getBoundingClientRect().top;
    if (dy) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: EASE_OUT });
  }
}

function demoList(root) {
  const [nowList, nextList] = $$('.d-list', root);
  buildList(nowList);
  buildList(nextList);
  let step = 0;
  let layout = null;
  return () => {
    step = (step + 1) % LIST_FRAMES.length;
    const frame = LIST_FRAMES[step];
    applyFrame(nowList, frame);
    if (reduceMotion) return applyFrame(nextList, frame);
    if (anime) {
      try {
        layout ??= anime.createLayout(nextList);
        layout.update(() => applyFrame(nextList, frame), {
          duration: 320,
          ease: anime.spring({ bounce: 0.22, duration: 320 }),
          delay: anime.stagger(18),
        });
        return;
      } catch (err) {
        console.warn('createLayout 失败，退回 FLIP', err);
        layout = null;
      }
    }
    flip(nextList, () => applyFrame(nextList, frame));
  };
}

/* ---------- C 执行过程展开 ---------- */

function demoFold(root) {
  const [nowFold, nextFold] = $$('.d-fold', root);
  let open = false;
  return () => {
    open = !open;
    nowFold.classList.toggle('open', open);
    nextFold.classList.toggle('open', open);
    if (!open || reduceMotion) return;
    const rows = $$('.d-steps p', nextFold);
    if (anime) {
      anime.animate(rows, { opacity: [0, 1], y: [8, 0], duration: 360, delay: anime.stagger(45, { start: 60 }), ease: 'outExpo' });
      return;
    }
    rows.forEach((row, i) => row.animate(
      [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 360, delay: 60 + i * 45, easing: EASE_OUT, fill: 'backwards' },
    ));
  };
}

/* ---------- D 数字滚动 ---------- */

const NUM_FRAMES = [
  { tokens: 12840, add: 96, del: 12 },
  { tokens: 48210, add: 371, del: 65 },
  { tokens: 73655, add: 512, del: 140 },
];
const NUM_PREFIX = { tokens: '', add: '+', del: '−' };
const fmt = (key, v) => NUM_PREFIX[key] + Math.round(v).toLocaleString('en-US');

function demoNumbers(root) {
  const [nowPane, nextPane] = $$('.d-nums', root);
  const cell = (pane, key) => $(`[data-k="${key}"]`, pane);
  const shown = { ...NUM_FRAMES[0] };
  const paint = (pane, values) => { for (const key of Object.keys(NUM_PREFIX)) cell(pane, key).textContent = fmt(key, values[key]); };
  paint(nowPane, shown);
  paint(nextPane, shown);
  let step = 0;
  let raf = 0;
  return () => {
    step = (step + 1) % NUM_FRAMES.length;
    const target = NUM_FRAMES[step];
    paint(nowPane, target);
    if (reduceMotion) return paint(nextPane, Object.assign(shown, target));
    if (anime) {
      anime.animate(shown, { ...target, duration: 400, ease: 'outExpo', onUpdate: () => paint(nextPane, shown) });
      return;
    }
    cancelAnimationFrame(raf);
    const from = { ...shown };
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / 400);
      const eased = 1 - 2 ** (-10 * p);
      for (const key of Object.keys(target)) shown[key] = from[key] + (target[key] - from[key]) * (p === 1 ? 1 : eased);
      paint(nextPane, shown);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
}

/* ---------- 回到顶部：位置不动，只在使用者自己滚的时候出现 ---------- */

const TOP_EDGE = 24;        // 离顶这么近就不需要它（真实界面是 80px，演示框矮，按比例缩了）
const INTENT_MS = 800;      // 一次滚轮 / 触摸 / 按键之后，这么久以内的 scroll 算「自己在滚」
const IDLE_MS = 1000;       // 停下这么久淡出
const FEED_WIDTHS = [62, 88, 74, 94, 55, 81, 68];

function feedLine(i, fresh) {
  const p = document.createElement('p');
  p.style.setProperty('--w', `${FEED_WIDTHS[i % FEED_WIDTHS.length]}%`);
  if (fresh) p.className = 'new';
  else if (i % 6 === 4) p.className = 'me';
  return p;
}

function demoBacktop(root) {
  const feeds = $$('.pane', root).map((pane, k) => {
    const feed = $('.d-feed', pane);
    const btn = $('.d-top', pane);
    for (let i = 0; i < 28; i++) feed.append(feedLine(i));
    feed.scrollTop = feed.scrollHeight;
    const toTop = () => feed.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    if (k === 0) {
      // 现在：只看位置
      feed.addEventListener('scroll', () => btn.classList.toggle('is-hidden', feed.scrollTop <= TOP_EDGE));
      btn.addEventListener('click', toTop);
      return feed;
    }
    // 之后：位置 + 「自己在滚」。流式输出的自动跟随也会派发 scroll，所以要两个条件一起判
    let intentUntil = 0;
    let dragging = false;
    let idle = 0;
    const note = () => { intentUntil = performance.now() + INTENT_MS; };
    const rest = () => {
      if (btn.matches(':hover, :focus-visible')) idle = setTimeout(rest, 400);
      else btn.classList.add('is-idle');
    };
    for (const type of ['wheel', 'touchmove', 'keydown']) feed.addEventListener(type, note, { passive: true });
    feed.addEventListener('pointerdown', () => { dragging = true; });
    addEventListener('pointerup', () => { dragging = false; });
    feed.addEventListener('scroll', () => {
      btn.classList.toggle('is-hidden', feed.scrollTop <= TOP_EDGE);
      if (!dragging && performance.now() > intentUntil) return;
      btn.classList.remove('is-idle');
      clearTimeout(idle);
      idle = setTimeout(rest, IDLE_MS);
    });
    btn.addEventListener('click', () => { note(); toTop(); });
    return feed;
  });
  let run = 0;
  return () => {
    clearInterval(run);
    let n = 0;
    run = setInterval(() => {
      for (const feed of feeds) {
        feed.append(feedLine(n, true));
        if (feed.children.length > 60) feed.firstElementChild.remove();
        feed.scrollTop = feed.scrollHeight;
      }
      if (++n >= 10) clearInterval(run);
    }, 300);
  };
}

/* ---------- 发送设置样机：选一档，发送键跟着变 ---------- */

const SEND_MODES = {
  now: { label: '', icon: 'i-caret', hint: '' },
  timed: { label: '14:30 发送', icon: 'i-clock', hint: '11/11 14:30 自动发出，发出前可以在待发送里撤回。' },
  after: { label: '完成后发送', icon: 'i-sand', hint: '等「修复斜杠补全回车」完成后发出。' },
};

function setupSend(root) {
  const main = $('.m-key > :first-child', root);
  const cfg = $('.m-key > :last-child', root);
  const hint = $('.m-pop p', root);
  const chips = $$('[data-mode]', root);
  const pick = (mode) => {
    const { label, icon, hint: text } = SEND_MODES[mode];
    for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.mode === mode));
    $('span', main).textContent = label;
    main.classList.toggle('txt', Boolean(label));
    $('use', cfg).setAttribute('href', `#${icon}`);
    hint.textContent = text;
  };
  for (const c of chips) c.addEventListener('click', () => pick(c.dataset.mode));
  pick('timed');
}

/* ---------- 面板样机：竖轨切格、再点收起整栏、关闭键移出、「+」加回 ---------- */

function setupRail(root) {
  const rail = $('.m-rail', root);
  const tabs = $$(':scope > [data-to]', rail);
  const panes = $$('.m-view', root);
  const title = $('.m-ph b', root);
  const remove = $('[data-remove]', root);
  const ink = $('.m-ink', rail);
  const add = $('.add', rail);
  const menu = $('.m-menu', rail);
  const tabOf = (name) => tabs.find((t) => t.dataset.to === name);
  let current = tabs.find((t) => t.getAttribute('aria-pressed') === 'true');

  const paint = () => {
    const shut = root.classList.contains('shut');
    let prev = null;
    for (const t of tabs) {
      t.setAttribute('aria-pressed', String(!shut && t === current));
      if (t.hidden) continue;
      // 相邻两格不在同一簇，中间留一道空；某一簇整簇不在条上时不会留出双倍
      t.classList.toggle('gap', Boolean(prev) && prev.dataset.g !== t.dataset.g);
      prev = t;
    }
    for (const p of panes) p.classList.toggle('on', p.dataset.pane === current.dataset.to);
    title.textContent = current.getAttribute('aria-label');
    remove.hidden = current.dataset.to === 'info';   // 「信息」是必留格
    for (const item of $$('button', menu)) item.disabled = !tabOf(item.dataset.add).hidden;
    if (!shut) ink.style.setProperty('--y', `${current.offsetTop + (current.offsetHeight - 18) / 2}px`);
  };
  let openedAt = 0;
  const open = (tab) => {
    tab.hidden = false;
    current = tab;
    openedAt = performance.now();
    root.classList.remove('shut');
    paint();
  };
  const closeMenu = () => { menu.hidden = true; add.setAttribute('aria-expanded', 'false'); };

  for (const t of tabs) {
    t.addEventListener('click', (e) => {
      // 再点已选中的格 = 收起整栏。只认鼠标：回车、空格触发的 click，detail 是 0；
      // 刚切过来的那一下双击不算（否则双击一格会「先选中再收起」）
      const again = t === current && e.detail > 0 && performance.now() - openedAt > 350;
      if (again) { root.classList.add('shut'); paint(); } else if (t !== current) open(t);
    });
    const item = document.createElement('button');
    item.dataset.add = t.dataset.to;
    item.innerHTML = `${t.innerHTML}${t.getAttribute('aria-label')}<kbd>${t.dataset.key}</kbd>`;
    item.addEventListener('click', () => { closeMenu(); open(t); });
    menu.append(item);
  }
  for (const b of $$('.m-main [data-to]', root)) b.addEventListener('click', () => open(tabOf(b.dataset.to)));
  remove.addEventListener('click', () => {
    const shown = tabs.filter((t) => !t.hidden);
    const i = shown.indexOf(current);
    current.hidden = true;
    current = shown[i + 1] ?? shown[i - 1];
    paint();
    current.focus();
  });
  $('.m-back button', root).addEventListener('click', () => open(current));
  add.addEventListener('click', () => { menu.hidden = !menu.hidden; add.setAttribute('aria-expanded', String(!menu.hidden)); });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('.m-menu, .add')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // 提示：第一次悬停等一下，连着看下一格不等
  let warm = 0;
  rail.addEventListener('pointerenter', () => { clearTimeout(warm); warm = setTimeout(() => rail.classList.add('warm'), 420); });
  rail.addEventListener('pointerleave', () => { clearTimeout(warm); warm = setTimeout(() => rail.classList.remove('warm'), 300); });
  paint();
  addEventListener('resize', paint);
  document.fonts?.ready.then(paint);
}

/* ---------- 启动 ---------- */

const DEMOS = { backtop: demoBacktop, menu: demoMenu, list: demoList, fold: demoFold, numbers: demoNumbers };

function setupDemos() {
  for (const root of $$('.demo[data-demo]')) {
    const run = DEMOS[root.dataset.demo]?.(root);
    if (run) $('.play', root)?.addEventListener('click', run);
  }
}

mountIcons();
drawHistogram($('.hist'));
drawDurations($('.durs'));
drawChecklist($('#checklist'));
setupRun($('.runlive'));
setupReveal();
setupDemos();
$$('[data-send]').forEach(setupSend);
$$('[data-rail]').forEach(setupRail);
loadAnime();
