/* 设置 › 起手式（#/settings/workflow）。照 web/src/settings/WorkflowsSettings.tsx 和 web/src/workflow/ 画：
   页签一排（系统自带 / 我建的 / 已停用，末尾「新建」）、名牌卡、工作区开关、站点线。
   站点线是保留项（清单 set-keep），结构原样：每站的短名和全名、两位数编号、← → ✕ 三颗操作键、站下面的参数标签和「失败 → …」。
   只有两处不一样：线上的小字提到 12px；设置页上没有任务在走，不再把整条线压成半透明。
   「谁来干 / 谁来验」点开是全应用那一颗三段胶囊（ASH.target），多一档「跟随任务的执行器」。
   点一颗标签就地改那一项：单选开全应用那一种菜单；多选、填字、选人、失败去向开一张小浮层，里面的选项也是同一种菜单行（选中打勾）。
   数据（系统自带的五条线、各站的缺省参数）在 settings.js 的 ASH.setData 里；小件取 ASH.setKit。 */
(() => {
  const { h, $, icon } = ASH;
  const P = (ASH.setPages ??= {});

  const SHELL_HINT = '命令交给系统 shell 跑：macOS/Linux 是 `sh -lc`，Windows 是 `cmd /d /s /c`。POSIX 专有写法（`FOO=1 cmd` 前缀、`$(…)`、`2>/dev/null`）在 Windows 上不成立，要跨平台就写成 npm scripts 再调。';
  const PORT_HINT = 'ash 会把上面的选择作为 $ASH_PREVIEW_MODE 传给命令；项目不识别它时，就是普通自定义命令。同时每次借一个空闲端口，用 $PORT 传入。端口写死的话，同一个项目已经有一份在跑时必然撞车 —— 写成认 $PORT 的形式（例如 npm run dev -- --port $PORT）才错得开。';

  /* 站的种类：线上的短名、全名、任务走到这一站时列表里显示什么（note 是后面那句小字）、站下面有哪些参数。
     名字和选项的字照 shared/src/workflow.ts、web/src/workflow/stepFields.ts。
     参数的种类：text 填一段字 / who 选谁干（三段胶囊）/ multi 多选 / pick 单选。empty = 没填没选时标签上写什么 */
  const KIND = {
    run: { name: '让 AI 干活', shows: '运行中', fields: [
      { t: 'text', k: 'instruction', label: '额外交代', ph: '留空就照任务描述做', empty: '照任务描述做' },
      { t: 'who', label: '谁来干' }] },
    verify: { name: '自动验证', shows: '验证中', fields: [
      { t: 'who', label: '谁来验' },
      { t: 'multi', k: 'checks', label: '验什么（全过才算过）', empty: '还没选验什么', o: [['build', '构建 + 类型检查'], ['tests', '回归测试'], ['browser', '浏览器真实点检'], ['smoke', '接口冒烟'], ['lint', '跑一遍 lint']] }] },
    preview: { name: '打开预览', shows: '运行中', note: '预览已起', fields: [
      { t: 'pick', k: 'mode', label: '启动方式', o: [['command', '按项目启动命令'], ['frontend', '只启动前端'], ['full', '前后端全启动（独立新库）'], ['test', '前后端 + 测试库快照']] },
      { t: 'text', k: 'cmd', label: '启动命令', ph: 'npm run dev', empty: '还没填命令', hint: `${PORT_HINT}\n${SHELL_HINT}` },
      { t: 'pick', k: 'ready', label: '怎么算起来了', o: [['port', '端口可连就算起来了'], ['port+log', '端口可连 + 日志 ready'], ['http200', 'HTTP 返回 200']] },
      { t: 'pick', k: 'life', label: '什么时候关掉', o: [['gate', '下一个人工关口结束时回收'], ['task', '任务结束时回收'], ['idle30', '起来满 30 分钟就回收']] }] },
    human: { name: '等我点头', shows: '待验收', fields: [
      { t: 'multi', k: 'show', label: '给我看什么', empty: '什么都不给，我自己去看', emptyOk: true, o: [['diff', 'diff'], ['report', '验证报告'], ['shots', '截图']] },
      { t: 'multi', k: 'notify', label: '怎么叫我', empty: '不通知', emptyOk: true, o: [['inbox', '落「需处理」'], ['push', '推送通知'], ['mail', '邮件']] }] },
    command: { name: '跑一条命令', shows: '运行中', note: '跑命令', fields: [
      { t: 'text', k: 'cmd', label: '命令', ph: 'npm run lint', empty: '还没填命令', hint: SHELL_HINT },
      { t: 'pick', k: 'where', label: '在哪跑', o: [['workspace', '任务工作区'], ['repo', '项目根目录']] }] },
    accept: { name: '合并并清理', shows: '验收完成', fields: [
      { t: 'pick', k: 'strategy', label: '怎么合', o: [['safe', '安全合并（仓库锁内）'], ['squash', 'squash 合并'], ['tag', '只打标签不合并']] },
      { t: 'pick', k: 'clean', label: '合完清理', o: [['all', '删 worktree 和任务分支'], ['worktree', '只删 worktree'], ['none', '都留着']] }] },
  };
  const ORDER = ['run', 'verify', 'preview', 'human', 'command', 'accept'];
  const ONCE = ['run', 'accept'];   /* 这两种站一条线上只能有一个 */
  const MAX_STOPS = 24;
  const FAIL = [['stop', '停下等人'], ['ask', '问我一句'], ['back', '打回给 AI 重做']];
  const failText = (fail) => (fail.mode === 'stop' ? '停下等人' : fail.mode === 'ask' ? '问我一句再决定' : `打回给 AI 重做 · 最多 ${fail.max} 轮`);

  /* 站下面那排标签上的字：[参数, 字, 要不要标黄]。没填的文字项、一个没选的必选项标黄，和现在一样 */
  const chipsOf = (s) => KIND[s.kind].fields.flatMap((fd) => {
    if (fd.t === 'who') { const w = s.p.who; return w ? [[fd, w.agent], w.model && [fd, w.model], w.level && [fd, w.level]].filter(Boolean) : [[fd, '跟随任务的执行器']]; }
    const v = s.p[fd.k];
    if (fd.t === 'multi') { const names = v.map((key) => fd.o.find(([x]) => x === key)?.[1] ?? key); return [[fd, names.join('、') || fd.empty, !names.length && !fd.emptyOk]]; }
    if (fd.t === 'pick') return [[fd, fd.o.find(([key]) => key === v)?.[1] ?? '']];
    return [[fd, v.trim() || fd.empty, !v.trim()]];
  });

  /* 这条线存不存得进去（只查会被拒的那几条）：[原因, 出问题的那一站] */
  const issues = (f) => {
    const st = f.stops;
    if (!st.length) return [['一条线至少要有一站']];
    const out = st.some((s) => s.kind === 'run') ? [] : [['没有「让 AI 干活」这一站，任务不会开工']];
    st.forEach((s, i) => {
      if (s.kind === 'accept' && !st.slice(0, i).some((p) => p.kind === 'human')) out.push(['合并之前必须有一站「等我点头」', s]);
      if (s.kind === 'preview' && !st.slice(i + 1).some((p) => p.kind === 'human')) out.push(['预览起来之后没有人工关口，没人会去看它', s]);
      if (s.kind === 'command' && !s.p.cmd.trim()) out.push(['命令是空的', s]);
      if (s.kind === 'preview' && !s.p.cmd.trim()) out.push(['预览的启动命令是空的', s]);
    });
    return out;
  };

  /* 站上的小编辑器：锚在那颗标签下面的一小张浮层。里面还要再开全应用那一种菜单（三段胶囊的每一段、「最多重做」的下拉），
     而 ASH.pop 一次只许开一张，所以这一张自己管：点外面、Esc、滚动、切页都会关，关掉后焦点回到标签上。 */
  let host = null;
  function closeHost(refocus) {
    if (!host) return;
    const { el, anchor, off } = host;
    host = null;
    off();
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 130);
    anchor.setAttribute('aria-expanded', 'false');
    if (refocus) anchor.focus({ preventScroll: true });
  }
  function openHost(anchor, label, content) {
    closeHost();
    ASH.closePop();
    const el = h('div.pop.sv-set-host', { role: 'dialog', 'aria-label': label }, content);
    document.body.append(el);
    const a = anchor.getBoundingClientRect();
    const up = a.bottom + 6 + el.offsetHeight > innerHeight - 8 && a.top - el.offsetHeight - 6 > 8;
    el.style.left = `${Math.max(8, Math.min(a.left + a.width / 2 - el.offsetWidth / 2, innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${up ? a.top - el.offsetHeight - 6 : a.bottom + 6}px`;
    el.style.setProperty('--origin', `${up ? 'bottom' : 'top'} center`);
    requestAnimationFrame(() => el.classList.add('is-in'));
    anchor.setAttribute('aria-expanded', 'true');
    const away = (e) => { if (!e.target.closest?.('.pop') && !host?.anchor.contains(e.target)) closeHost(); };
    /* 里面那张菜单还开着时，这一下 Esc 归它 */
    const key = (e) => { if (e.key === 'Escape' && !$('.pop.is-in:not(.sv-set-host)')) { e.stopPropagation(); closeHost(true); } };
    addEventListener('pointerdown', away, true);
    addEventListener('scroll', away, true);
    addEventListener('keydown', key, true);
    /* 选项之间上下键走，和菜单一样 */
    el.addEventListener('keydown', (e) => {
      const all = [...el.querySelectorAll('.menu > button')];
      const i = all.indexOf(document.activeElement);
      const to = i < 0 ? null : { ArrowDown: all[(i + 1) % all.length], ArrowUp: all[(i - 1 + all.length) % all.length], Home: all[0], End: all.at(-1) }[e.key];
      if (to) { e.preventDefault(); to.focus(); }
    });
    host = { el, anchor, off() { removeEventListener('pointerdown', away, true); removeEventListener('scroll', away, true); removeEventListener('keydown', key, true); } };
    (el.querySelector('textarea, [aria-selected="true"]') ?? el.querySelector('button'))?.focus({ preventScroll: true });
  }

  P.workflow = (page) => {
    const { head, card, row, btn, sw, area, replay } = ASH.setKit;
    const D = ASH.setData;
    const tabs = h('div.sv-set-tabs', { role: 'tablist', 'aria-label': '起手式' });
    const box = h('div.sv-set-stack');
    const railbox = h('div.card.sv-set-railbox', { 'data-m': 'set-keep' });
    const rail = h('div.sv-set-rail');
    const denyText = h('span');
    const deny = h('div.note.bad', { hidden: true }, icon('warn'), denyText);
    const cur = () => D.flows.find((f) => f.key === D.flow);
    let restoreKey = null;

    /* ---------- 页签：系统自带 → 我建的 → 已停用；左右方向键在页签之间走 ---------- */
    const tabKids = (f) => [f.name, f.modified && h('em.is-edited', '已改过'), f.off && h('em', '已停用')];
    function drawTabs() {
      const groups = [['系统自带', D.flows.filter((f) => f.builtin && !f.off)], ['我建的', D.flows.filter((f) => !f.builtin && !f.off)], ['已停用', D.flows.filter((f) => f.off)]];
      tabs.replaceChildren(...groups.flatMap(([label, list]) => (list.length ? [h('span', label), ...list.map((f) => h('button', { type: 'button', role: 'tab', 'data-flow': f.key,
        'aria-selected': String(f.key === D.flow), tabindex: f.key === D.flow ? '0' : '-1', onclick: () => choose(f.key) }, tabKids(f)))] : [])),
      ...(D.flows.length ? [] : [h('span', '一个起手式都没有')]),
      h('button.sv-set-newtab', { type: 'button', onclick: () => create() }, icon('plus', 'sm'), '新建'));
    }
    tabs.addEventListener('keydown', (e) => {
      const all = [...tabs.querySelectorAll('[role="tab"]')];
      const to = all[all.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : NaN)];
      if (to) { e.preventDefault(); choose(to.dataset.flow, true); }
    });
    function choose(key, focus) {
      D.flow = key;
      drawTabs();
      drawMain();
      replay(box);
      const on = tabs.querySelector('[aria-selected="true"]');
      on?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (focus) on?.focus();
    }
    /* 系统自带的改的就是它本身：一动就带上「已改过」，「恢复系统默认」随之可点 */
    const touch = () => {
      const f = cur();
      if (!f?.builtin || f.modified) return;
      f.modified = true;
      tabs.querySelector(`[data-flow="${f.key}"]`)?.replaceChildren(...tabKids(f).filter(Boolean));
      if (restoreKey) restoreKey.disabled = false;
    };
    const create = (from) => {
      const f = from ? { ...structuredClone({ desc: from.desc, iso: from.iso, stops: from.stops }), name: `${from.name} 副本` } : { name: '新起手式', desc: '', iso: true, stops: [D.stop('run')] };
      D.flows.push(Object.assign(f, { key: `mine-${++D.made}`, builtin: false, off: false, modified: false }));
      choose(f.key, true);
    };

    /* ---------- 站点线 ---------- */
    function draw({ keep, focus, fresh } = {}) {
      const f = cur();
      const st = f.stops;
      const bad = issues(f);
      const flagged = new Set(bad.map(([, s]) => s));
      deny.hidden = !bad.length;
      denyText.textContent = `这条线现在存不进去，先改好这个：${bad.map(([why]) => why).join('；')}`;
      if (!st.length) {
        railbox.replaceChildren(h('p.sv-set-norail', '这条线上还没有站。', h('button.btn.sm', { type: 'button', onclick: () => { st.push(D.stop('run')); touch(); draw(); } }, '＋ 加第一站')));
        return;
      }
      const again = (key) => draw({ keep: key });
      const move = (i, by) => {
        const [s] = st.splice(i, 1);
        st.splice(i + by, 0, s);
        touch();
        draw({ focus: () => $(`[data-op="${i + by}:${by}"]:not([disabled])`, rail) ?? $(`[data-op="${i + by}:${-by}"]`, rail) });
      };
      const taken = (kind) => ONCE.includes(kind) && st.some((s) => s.kind === kind);
      /* 段中间的 ＋：加一站。已经有了的「让 AI 干活」「合并并清理」灰掉，并说明白 */
      const add = (at) => h('div.sv-set-seg', st.length < MAX_STOPS && h('button', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': `在第 ${at + 1} 站前面加一站`, 'data-add': at, onclick: (e) => {
        closeHost();
        ASH.menu(e.currentTarget, [...ORDER.map((kind) => ({ label: KIND[kind].name, disabled: taken(kind), onpick: () => {
          const s = D.stop(kind);
          st.splice(at, 0, s);
          touch();
          draw({ fresh: s, focus: () => $(`[data-chip^="${at}:"]`, rail) });
        } })), ...(ORDER.some(taken) ? ['灰掉的站这条线上已经有了 —— 「让 AI 干活」和「合并并清理」各只能有一站。'] : [])], { cls: 'sv-set-addmenu' });
      } }, icon('plus')));

      /* 点一颗标签，就地改这一项：单选是一张菜单，选完即关；其余开一张小浮层 */
      const edit = (el, key, s, fd) => {
        if (host?.anchor === el) { closeHost(true); return; }
        if (fd.t === 'pick') {
          closeHost();
          ASH.menu(el, fd.o.map(([value, name]) => ({ label: name, selected: s.p[fd.k] === value, onpick: () => { s.p[fd.k] = value; touch(); draw({ focus: () => $(`[data-chip="${key}"]`, rail) }); } })), { role: 'listbox' });
          return;
        }
        if (fd.t === 'who') {
          /* 和新建面板同一颗三段胶囊；选回「跟随任务的执行器」时模型和智能水平一起清 */
          openHost(el, fd.label, h('div.sv-set-form', h('small', '智能体 · 模型 · 智能水平'),
            ASH.target({ value: s.p.who, follow: '跟随任务的执行器', label: fd.label, onchange: (who) => { s.p.who = who; touch(); again(key); } }).el));
          return;
        }
        if (fd.t === 'multi') {
          const opts = h('div.menu.sel-menu', { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': fd.label });
          const sync = () => { for (const b of opts.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.v ? s.p[fd.k].includes(b.dataset.v) : !s.p[fd.k].length)); };
          const set = (next) => { s.p[fd.k] = next; sync(); touch(); again(key); };
          const option = (name, value, onclick) => h('button', { type: 'button', role: 'option', 'data-v': value, onclick }, h('span', name));
          /* 「一个都不选」是这组选项的反面，用一条线和上面几项隔开 */
          opts.append(...fd.o.map(([value, name]) => option(name, value, () => set(s.p[fd.k].includes(value) ? s.p[fd.k].filter((x) => x !== value) : [...s.p[fd.k], value]))),
            ...(fd.emptyOk ? [h('hr'), option(fd.empty, null, () => set([]))] : []));
          sync();
          openHost(el, fd.label, opts);
          return;
        }
        const input = area(fd.label, s.p[fd.k], fd.ph, fd.k === 'instruction' ? 3 : 1, { oninput: () => { s.p[fd.k] = input.value; touch(); again(key); } });
        openHost(el, fd.label, h('div.sv-set-form', input, fd.hint && h('p', fd.hint)));
      };
      /* 「失败 → …」：三档；打回给 AI 重做时再选最多几轮 */
      const editFail = (el, key, s) => {
        if (host?.anchor === el) { closeHost(true); return; }
        const form = h('div.sv-set-form');
        const paint = (focus) => {
          form.replaceChildren(h('div.menu.sel-menu', { role: 'listbox', 'aria-label': '这一站失败了怎么办' }, FAIL.map(([mode, name]) => h('button', { type: 'button', role: 'option', 'data-v': mode, 'aria-selected': String(s.fail.mode === mode),
            onclick: () => { s.fail.mode = mode; touch(); again(key); paint(mode); } }, h('span', name)))),
          s.fail.mode === 'back' && h('div.sv-set-line', h('span', '最多重做'), ASH.select({ value: s.fail.max, label: '最多重做几轮', options: [1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} 轮` })),
            onchange: (n) => { s.fail.max = n; touch(); again(key); } })));
          if (focus) form.querySelector(`[data-v="${focus}"]`)?.focus();
        };
        paint();
        openHost(el, '这一站失败了怎么办', form);
      };

      const stopCols = (s, i) => {
        const k = KIND[s.kind];
        const cls = s === fresh ? '.enter' : '';
        return [
          h(`div.sv-set-plate${cls}${flagged.has(s) ? '.has-issue' : ''}`,
            h('div.sv-set-ops',
              h('button', { type: 'button', 'aria-label': '往前挪', disabled: i === 0, 'data-op': `${i}:-1`, onclick: () => move(i, -1) }, '←'),
              h('button', { type: 'button', 'aria-label': '往后挪', disabled: i === st.length - 1, 'data-op': `${i}:1`, onclick: () => move(i, 1) }, '→'),
              h('button.is-del', { type: 'button', 'aria-label': '拆掉这一站', onclick: () => { st.splice(i, 1); touch(); draw({ focus: () => $(`[data-add="${Math.min(i, st.length)}"]`, rail) }); } }, '✕')),
            h('span', D.SHORT[s.kind]), h('h4', k.name)),
          h(`div.sv-set-node${cls}`, h('i', String(i + 1).padStart(2, '0'))),
          h(`div.sv-set-body${cls}`,
            h('p', '任务显示 ', h('b', k.shows), k.note && h('em', `· ${k.note}`)),
            chipsOf(s).map(([fd, label, warn]) => { const key = `${i}:${fd.k ?? 'who'}`; return h(`button.sv-set-chip${warn ? '.is-warn' : ''}`, { type: 'button', 'aria-haspopup': fd.t === 'pick' ? 'listbox' : 'dialog', 'aria-expanded': 'false',
              'aria-label': `${fd.label}：${label}`, 'data-chip': key, onclick: (e) => edit(e.currentTarget, key, s, fd) }, h('span', label)); }),
            s.fail && h('button.sv-set-chip.is-fail', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-chip': `${i}:fail`, onclick: (e) => editFail(e.currentTarget, `${i}:fail`, s) },
              icon('setTurn', 'sm'), h('span', `失败 → ${failText(s.fail)}`))),
        ];
      };
      rail.dataset.dense = st.length >= 6 ? 'yes' : 'no';   /* 站数到 6 就整体紧一档（只收列宽，字不再缩） */
      rail.replaceChildren(add(0), ...st.flatMap((s, i) => [...stopCols(s, i), add(i + 1)]));
      if (!rail.isConnected) railbox.replaceChildren(rail);
      /* 改到一半浮层还开着：把它重新挂到新画出来的那颗标签上 */
      if (host && keep) { host.anchor = $(`[data-chip="${keep}"]`, rail) ?? host.anchor; host.anchor.setAttribute('aria-expanded', 'true'); }
      focus?.()?.focus({ preventScroll: true });
    }

    /* ---------- 名牌卡 + 工作区开关 + 站点线 ---------- */
    function drawMain() {
      closeHost();
      const f = cur();
      if (!f) { box.replaceChildren(h('p.none', '上面挑一个起手式。')); return; }
      const name = h('input.sv-set-title', { type: 'text', value: f.name, 'aria-label': '起手式名字', spellcheck: 'false' });
      name.addEventListener('blur', () => { const v = name.value.trim(); if (!v || v === f.name) return; f.name = v; touch(); tabs.querySelector(`[data-flow="${f.key}"]`)?.replaceChildren(...tabKids(f).filter(Boolean)); });
      const desc = h('input.sv-set-desc', { type: 'text', value: f.desc, placeholder: '一句话说明什么时候用它', 'aria-label': '起手式说明', spellcheck: 'false' });
      desc.addEventListener('blur', () => { const v = desc.value.trim(); if (v !== f.desc) { f.desc = v; touch(); } });
      const redo = (act) => { drawTabs(); drawMain(); box.querySelector(`[data-act="${act}"]`)?.focus(); };
      /* 系统自带的删不掉，只能停用；自己建的可以删（删除走统一的确认框） */
      restoreKey = f.builtin ? btn('恢复系统默认', () => { Object.assign(f, D.builtinFlow(f.key), { off: f.off }); redo('copy'); }, '.sm', 'undo') : null;
      if (restoreKey) restoreKey.disabled = !f.modified;
      const remove = async () => {
        if (!(await ASH.confirm({ title: '删除起手式', body: `删掉「${f.name}」之后，新建任务里就挑不到它了。已经建好的任务不受影响。`, ok: '删除', danger: true }))) return;
        D.flows.splice(D.flows.indexOf(f), 1);
        choose(D.flows[0]?.key, true);
      };
      const acts = h('div.sv-set-acts',
        h('button.btn.sm', { type: 'button', 'data-act': 'copy', onclick: () => create(f) }, icon('copy'), '复制一份'),
        restoreKey,
        h('button.btn.sm', { type: 'button', 'data-act': 'off', onclick: () => { f.off = !f.off; redo('off'); } }, icon('setBan'), f.off ? '重新启用' : '停用'),
        !f.builtin && h('button.btn.sm.danger', { type: 'button', onclick: remove }, icon('trash'), '删除'));
      const hint = f.off ? '这条已停用，新建任务里挑不到它 —— 按上面的「重新启用」随时拿回来。' : f.builtin && '系统自带的删不掉，只能停用；停用后新建任务里看不到它，随时能恢复。';
      box.replaceChildren(
        h('div.card.sv-set-plaque', name, desc, acts, hint && h('p', hint)),
        card(row('单独开一份工作区（worktree）', '开 = 给任务开一份 worktree，跟你自己那份互不打扰；关 = 直接在项目目录里干活，改动当场落在项目目录里',
          sw(f.iso, ['单独开一份工作区', '直接在项目目录里干活'], (on) => { f.iso = on; touch(); }))),
        deny, railbox);
      draw();
    }

    /* 标题下的说明至多一句：留原话的第一句 */
    page.append(head('起手式', '新建任务时挑一条线起手，挑完还能改。'), tabs, box);
    if (!cur()) D.flow = D.flows[0]?.key;
    drawTabs();
    drawMain();
    return () => closeHost();
  };
})();
