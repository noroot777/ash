/* 改动工作区（部件 changes）：点「验收」、更多里的「查看改动与审查」、右侧面板里通到「完整 diff 与提交」的入口，到的都是这一面。
   这一面这一轮不动，照现状只画了骨架（web/src/review/TaskReviewWorkspace.tsx）：一行标题和验收动作、分支与提交、改动的文件。
   差异本身没画：点一个文件只发 diff:open。开着的时候它顶替会话那一列，「返回对话」在它自己那一行的最左（任务头上没有按钮）。
   听 changes:open（开；开着的时候再来一次是关）、task:status、review:change；发 changes:state { open }。 */
(() => {
  const { h, icon } = ASH;
  const LIVE = ['running', 'waiting', 'queued', 'paused'];
  ASH.icons.back ??= '<path d="M13 8H3M7 4 3 8l4 4"/>';

  ASH.part('changes', {
    mount(el, { talk = [] } = {}) {
      const cur = ASH.data.cur;
      const m = ASH.changes;
      const task = ASH.data.tasks.find((t) => t.id === ASH.data.current);
      let open = false;
      let status = task.status;
      let accepted = Boolean(task.accepted);

      const accept = h('button.btn.pri', { type: 'button', onclick: async () => {
        const yes = await ASH.confirm({ title: '验收通过', ok: '验收通过', body: `先跑一遍验收前置命令，通过后把 ${cur.branch} 合并进 ${cur.target}，再清理任务分支和它的工作区。` });
        if (!yes) return;
        show(false);
        ASH.parts.live?.accept?.();
      } }, icon('check'), '验收通过');
      const done = h('span.changes-done', icon('check'), '验收完成');
      const warn = h('p.note.warn', { role: 'alert' }, icon('warn'), h('span'));
      const meta = h('p.changes-meta');
      const files = h('ul');
      const log = h('ul');
      const count = h('b');
      const logCount = h('b');
      el.append(
        h('header.changes-bar', h('button.btn.quiet.sm', { type: 'button', onclick: () => show(false) }, icon('back'), '返回对话'), h('b', '改动与提交'), h('span.grow'), done, accept),
        h('div.changes-body', warn, meta, h('h4.sec', '改动的文件', count), files, h('h4.sec', '提交', logCount), log));

      function paint() {
        const last = ASH.review.rounds.at(-1);
        const risk = accepted ? '' : last && !last.ok ? `最后一轮审查未通过（第 ${last.n} 轮）——验收合并即表示你接受该风险`
          : ASH.review.stale ? '审查通过后代码又有变化，结论可能已过期——可先「审查新改动」再验收' : '';
        warn.hidden = !risk;
        warn.lastChild.textContent = risk;
        done.hidden = !accepted;
        accept.hidden = accepted;
        accept.disabled = LIVE.includes(status);
        meta.replaceChildren(icon('branch', 'sm'), h('b', cur.branch), icon('chev', 'sm'), h('b', cur.target),
          h('span.num', `${m.rows.length} 个文件`), h('span.plus.num', `+${m.sum('add')}`), h('span.minus.num', `−${m.sum('del')}`));
        count.textContent = String(m.rows.length);
        logCount.textContent = String(m.commits.length);
        files.replaceChildren(...m.rows.map((r) => h('li', h('button.rowring', { type: 'button', onclick: () => ASH.emit('diff:open', { path: `${r.dir}/${r.name}` }) },
          icon('file', 'sm'), h('span.cut', h('span.changes-dir', `${r.dir}/`), r.name), h('span.plus.num', `+${r.add}`), h('span.minus.num', `−${r.del}`)))));
        log.replaceChildren(...m.commits.map((k) => h('li', h('button.rowring', { type: 'button', onclick: () => ASH.go('#/git') },
          h('code', k.hash.slice(0, 7)), h('span.cut', k.text), h('time.num', k.at)))));
      }

      function show(next) {
        if (open === next) return;
        open = next;
        el.hidden = !open;
        for (const node of talk) node.hidden = open;
        if (open) { paint(); el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
        else ASH.parts.feed?.follow?.();
        ASH.emit('changes:state', { open });
      }

      m.subs.push(paint);
      const offs = [
        ASH.on('changes:open', () => show(!open)),
        ASH.on('review:change', () => { if (open) paint(); }),
        ASH.on('task:status', ({ id, status: next, accepted: flag } = {}) => {
          if (id !== task.id || !next) return;
          if (next === 'accepted') { status = 'done'; accepted = true; }
          else { status = next; if (typeof flag === 'boolean') accepted = flag; else if (['done', 'running', 'queued'].includes(next)) accepted = false; }
          if (open) paint();
        }),
      ];
      return {
        get open() { return open; },
        show,
        destroy() { for (const off of offs) off(); m.subs.splice(m.subs.indexOf(paint), 1); },
      };
    },
  });
})();
