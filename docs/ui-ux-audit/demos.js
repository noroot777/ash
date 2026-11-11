// 报告页的全部脚本：两张分布图、滚动淡入、四个「现在 / 之后」对照演示、右侧面板样机的切换。
// anime.js 从 CDN 动态加载；连不上时右栏退回 WAAPI，并在页面上如实写明。

const ANIME_URL = 'https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.esm.min.js';
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- 分布图 ---------- */

// web/src 下全部 CSS 的 font-size 声明（px），2026-11-11 统计
const FONT_SIZES = [
  [7, 1], [8, 9], [8.5, 27], [9, 172], [9.5, 201], [10, 271], [10.5, 200], [11, 289], [11.5, 92],
  [12, 196], [12.5, 70], [13, 71], [13.5, 7], [14, 17], [15, 12], [16, 7], [17, 7], [18, 9],
  [20, 7], [21, 3], [22, 2], [23, 3], [25, 2], [28, 3],
];
const FLOOR_PX = 12;
const HIST_LABELS = new Set([8, 10, 12, 14, 18, 22, 28]);

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

// transition 时长（ms）与出现次数；120–160 这五档肉眼分不出
const DURATIONS = [[120, 17], [130, 16], [140, 24], [150, 43], [160, 20], [180, 11], [200, 8], [220, 3], [260, 4]];

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

/* ---------- 滚动淡入 ---------- */

function setupReveal() {
  const targets = $$('.head, .shot, .notes, .kind, .cause, .versus, .rewrite, .tabs4, .pair, .surface, .split, .layers, .demo, .map, .steps');
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
const LIST_LABEL = { run: '运行中', wait: '等你处理' };
const LIST_FRAMES = [
  { order: [0, 1, 2, 3, 4], state: { 0: 'run', 1: 'run' } },
  { order: [3, 0, 1, 2, 4], state: { 0: 'run', 1: 'run', 3: 'wait' } },
  { order: [3, 1, 2, 4, 0], state: { 1: 'run', 3: 'wait' } },
  { order: [1, 3, 2, 4, 0], state: { 1: 'wait', 3: 'run' } },
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
    if (dy) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 380, easing: EASE_OUT });
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
          duration: 460,
          ease: anime.spring({ bounce: 0.22, duration: 380 }),
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
      anime.animate(shown, { ...target, duration: 900, ease: 'outExpo', onUpdate: () => paint(nextPane, shown) });
      return;
    }
    cancelAnimationFrame(raf);
    const from = { ...shown };
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / 900);
      const eased = 1 - 2 ** (-10 * p);
      for (const key of Object.keys(target)) shown[key] = from[key] + (target[key] - from[key]) * (p === 1 ? 1 : eased);
      paint(nextPane, shown);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
}

/* ---------- 面板样机：页签与分段共用一套切换 ---------- */

// [data-switch] 里的 [data-to] 按钮切同一层的 [data-pane]；可以嵌套，各管各的那一层。
function setupSwitcher(root) {
  const buttons = $$('[data-to]', root).filter((b) => b.closest('[data-switch]') === root);
  const panes = $$('[data-pane]', root).filter((p) => p.parentElement.closest('[data-switch]') === root);
  const ink = $(':scope > .m-tabs > .m-ink', root);
  const moveInk = () => {
    const tab = ink && $(':scope > .m-tabs > [aria-selected="true"]', root);
    if (!tab) return;
    ink.style.setProperty('--x', `${tab.offsetLeft + 9}px`);
    ink.style.setProperty('--w', `${tab.offsetWidth - 18}px`);
  };
  const show = (name) => {
    const from = panes.findIndex((p) => p.classList.contains('on'));
    const to = panes.findIndex((p) => p.dataset.pane === name);
    if (to < 0 || to === from) return;
    root.style.setProperty('--dir', to > from ? 1 : -1);
    panes.forEach((p, i) => p.classList.toggle('on', i === to));
    for (const b of buttons) if (b.hasAttribute('aria-selected')) b.setAttribute('aria-selected', String(b.dataset.to === name));
    moveInk();
  };
  for (const b of buttons) b.addEventListener('click', () => show(b.dataset.to));
  if (ink) {
    moveInk();
    addEventListener('resize', moveInk);
    document.fonts?.ready.then(moveInk);
  }
}

/* ---------- 启动 ---------- */

const DEMOS = { menu: demoMenu, list: demoList, fold: demoFold, numbers: demoNumbers };

function setupDemos() {
  for (const root of $$('.demo[data-demo]')) {
    const run = DEMOS[root.dataset.demo]?.(root);
    if (run) $('.play', root)?.addEventListener('click', run);
  }
}

drawHistogram($('.hist'));
drawDurations($('.durs'));
setupReveal();
setupDemos();
$$('[data-switch]').forEach(setupSwitcher);
loadAnime();
