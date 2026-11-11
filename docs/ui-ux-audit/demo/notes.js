/* 对照清单：右边一列列出这一面的每一条（现在 → 改后），页面里对应的位置各有一颗同号的圆圈。
   数据来自 ../checklist.js（报告的 05 节读的是同一份）。元素用 data-m="条目 id" 认领，一处可以认领几条（空格分开）。 */
(() => {
  const { h, $, $$ } = ASH;
  const data = window.AUDIT ?? { surfaces: [], items: [] };
  const surfaceOf = Object.fromEntries(data.surfaces.map((s) => [s.key, s]));
  const routeOf = (item) => item.at ?? surfaceOf[item.s].at;
  const numberOf = new Map(data.items.map((item, i) => [item.id, i + 1]));
  const targetOf = (id) => $(`[data-m~="${id}"]`);
  const sameRoute = (item, route) => {
    const [name, sub] = routeOf(item).replace(/^#\//, '').split('/');
    return name === route.name && (!sub || !route.sub || sub === route.sub);
  };
  let shown = [];
  let looping = false;

  /* 被滚动容器裁掉、或者根本没画出来的，不放圆圈 */
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflow === 'visible') continue;
      const c = p.getBoundingClientRect();
      if (r.top < c.top - 4 || r.top > c.bottom - 8 || r.left < c.left - 4 || r.left > c.right - 8) return null;
    }
    return (r.top < 36 && !el.closest('.dbar')) || r.top > innerHeight || r.left > innerWidth ? null : r;
  }

  function place() {
    if (!document.body.classList.contains('notes-on')) { looping = false; return; }
    for (const pin of $$('#pins button')) {
      const el = targetOf(pin.dataset.id);
      const r = el && visibleRect(el);
      pin.hidden = !r;
      if (r) pin.style.translate = `${Math.round(r.left)}px ${Math.round(r.top)}px`;
      $(`.notes li[data-id="${pin.dataset.id}"]`)?.classList.toggle('off', !r);
    }
    requestAnimationFrame(place);
  }

  ASH.focusMark = (id) => {
    ASH.prep[id]?.();
    requestAnimationFrame(() => {
      const el = targetOf(id);
      for (const li of $$('.notes li')) li.classList.toggle('on', li.dataset.id === id);
      $(`.notes li[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
      for (const pin of $$('#pins button')) pin.classList.toggle('on', pin.dataset.id === id);
      if (!el) return;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: ASH.reduced() ? 'auto' : 'smooth' });
      el.classList.add('mark-on');
      clearTimeout(el._mark);
      el._mark = setTimeout(() => el.classList.remove('mark-on'), 1800);
    });
  };

  function pick(item, route) {
    if (sameRoute(item, route) && (targetOf(item.id) || ASH.prep[item.id])) ASH.focusMark(item.id);
    else ASH.go(`${routeOf(item)}?m=${item.id}`);
  }

  ASH.notes = {
    render(route) {
      const box = $('#notes > div');
      const pins = $('#pins');
      if (!document.body.classList.contains('notes-on')) { pins.replaceChildren(); return; }
      shown = data.items.filter((item) => sameRoute(item, route) || surfaceOf[item.s].everywhere);
      const groups = data.surfaces.filter((s) => shown.some((item) => item.s === s.key));
      box.replaceChildren(...groups.flatMap((s) => [
        h('h3', s.name),
        h('ul', shown.filter((item) => item.s === s.key).map((item) => h(`li${item.keep ? '.keep' : ''}`, { 'data-id': item.id },
          h('button', { type: 'button', onclick: () => pick(item, route) }, h('i', String(numberOf.get(item.id))), h('span', item.now), item.after && h('span', item.after), item.ask && h('em', '要你点头'))))),
      ]));
      pins.replaceChildren(...shown.map((item) => h(`button${item.keep ? '.keep' : ''}`, { 'data-id': item.id, 'aria-label': `清单第 ${numberOf.get(item.id)} 条`, onclick: () => ASH.focusMark(item.id) }, String(numberOf.get(item.id)))));
      if (!looping) { looping = true; requestAnimationFrame(place); }
    },
  };
})();
