/* 交付条（部件 next）：回复框上面的一行，不带框。任务头上原来那几颗按钮都在这里——
   这一行说的是「它交出来什么、轮到你做什么」：左边是这个任务还没验收的改动（几个文件、增删），右边是此刻轮到你的那一步（验收 / 重试 / 运行）。
   放在回复框上面，是因为一轮结束时你要做的决定就两个：再说一句，或者收下——两样摆在一起。会话里因此不用再挂按钮。
   「验收」和点左边那一段到的是同一处：改动工作区（changes.js），真正的「验收通过」在那里面，和现在一样。
   任务在跑、在排队时没有右半边（停止是发送键）；验收过了、又没有别的事要你做时，整行不画。
   哪个状态有哪几步，查的是 ASH.taskLook（task.js），和任务头的状态词同一张表。
   发 changes:open、task:act { label }（重试 / 运行，由 live.js 接）；听 task:status、run:state、ASH.changes 的变动。 */
(() => {
  const { h } = ASH;
  const int = (n) => String(Math.round(n));

  ASH.part('next', {
    mount(el) {
      const task = ASH.data.tasks.find((t) => t.id === ASH.data.current);
      const m = ASH.changes;
      let status = task.status;
      let accepted = Boolean(task.accepted);
      let running = Boolean(ASH.parts.live?.running);

      const files = h('span');
      const add = h('span.plus');
      const del = h('span.minus');
      const sum = h('button.next-sum', { type: 'button', 'data-tip': '看改动', onclick: () => ASH.emit('changes:open') }, h('span', files, ' 个文件'), add, del);
      const acts = h('span.next-acts');
      const row = h('div.next', { 'data-m': 'reply-6', hidden: true }, sum, h('span.grow'), acts);
      el.append(row);

      const press = (label) => { if (label === '验收') ASH.emit('changes:open'); else ASH.emit('task:act', { label }); };
      const button = (label) => h('button.btn.sm', { type: 'button', 'data-act': label, onclick: () => press(label) }, label);

      /* 换状态：用不上的那颗先淡出（.btn 自带 120ms 的透明度过渡），留着的不重画、滑到新位置，新来的淡入（ASH.flip）。连着换只认最后一次 */
      let landing = 0;
      function paint(first) {
        const want = running ? [] : ASH.taskLook(status, accepted).acts;
        const owed = m.rows.length > 0 && !accepted;
        const show = owed || want.length > 0;
        ASH.roll(files, m.rows.length, { fmt: int });
        ASH.roll(add, m.sum('add'), { fmt: (n) => `+${int(n)}` });
        ASH.roll(del, m.sum('del'), { fmt: (n) => `−${int(n)}` });
        const land = () => {
          const old = new Map([...acts.children].map((btn) => [btn.dataset.act, btn]));
          const redraw = () => { sum.hidden = !owed; acts.replaceChildren(...want.map((label) => old.get(label) ?? button(label))); };
          if (first || row.hidden || !show) redraw(); else ASH.flip(acts, redraw);
          if (row.hidden === show) {
            row.hidden = !show;
            if (show && !first) { row.classList.remove('enter'); void row.offsetWidth; row.classList.add('enter'); }
            ASH.parts.feed?.follow?.();
          }
        };
        clearTimeout(landing);
        if (first || ASH.reduced() || row.hidden) { land(); return; }
        for (const btn of acts.children) btn.classList.toggle('is-out', !want.includes(btn.dataset.act));
        landing = setTimeout(land, 150);
      }
      paint(true);

      m.subs.push(paint);
      const offs = [
        ASH.on('run:state', (state) => { running = Boolean(state?.running); paint(); }),
        ASH.on('task:status', ({ id, status: next, accepted: flag } = {}) => {
          if (id !== task.id || !next) return;
          if (next === 'accepted') { status = 'done'; accepted = true; }
          else { status = next; if (typeof flag === 'boolean') accepted = flag; else if (['done', 'running', 'queued'].includes(next)) accepted = false; }
          paint();
        }),
      ];
      return { el: row, destroy() { for (const off of offs) off(); clearTimeout(landing); m.subs.splice(m.subs.indexOf(paint), 1); } };
    },
  });
})();
