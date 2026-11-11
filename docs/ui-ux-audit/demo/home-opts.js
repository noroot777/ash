/* 新建面板底排那几颗选项入口点开之后的内容（home.js 的另一半，只管「浮层里画什么」和「入口上写什么」）。
   名字、次序、默认值照 web/src/composer/ComposerFields.tsx：工作方式 / 如何交付、工作目录、组织与标签、任务示例（写作参考）、谁来做（团队配置 / 讨论者）。
   对外：ASH.homeOpts = { defaults(), face(draft, mode), wide(kind, draft, mode), sheet(kind, draft, mode, api) }
     kind 是 work / where / org / more / cast；api = { paint(), close(back), fit(), setMode(mode), insert(text) }。
   「选谁干活」每一处都是 ASH.target 那颗三段胶囊。 */
(() => {
  const { h, icon } = ASH;
  ASH.icons.tag = '<path d="M2.5 3.5a1 1 0 0 1 1-1h4.1l5.9 5.9-5.1 5.1-5.9-5.9z"/><circle cx="5.6" cy="5.6" r=".9"/>';
  ASH.icons.arrow = '<path d="M3 8h10M9 4l4 4-4 4"/>';

  const AUTO_BASE = '跟随项目分支（创建时确定）';
  const BRANCHES = [['', AUTO_BASE], ['main', 'main'], ['dev', 'dev'], ['feat/slash-complete', 'feat/slash-complete']];
  const ROUNDS = [['', '不限'], ...[1, 2, 3, 5, 8].map((n) => [String(n), `${n} 轮`])];
  const NEW_GROUP = '__new';
  const groups = [['', '无分组'], ['g-clean', '发版前清理', '串行'], ['g-ui', '界面审查', '并行']];
  /* 起手式：系统自带的五条（shared/src/workflow-presets.ts），第一档是「跟着默认走」。
     每条：值、名字、一句说明、站点、验证没过时打回给 AI 重做的轮数、验证查什么 */
  const STANDARD = [['run', 'verify', 'human', 'accept'], 2, '构建、测试'];
  const FLOWS = [['', '跟随系统默认', '标准交付 · 验证 → 人工点头 → 合并', ...STANDARD], ['blank', '空白', '从一步开始，自己搭', ['run'], 0], ['fast', '极速原型', '干完就算完', ['run'], 0],
    ['standard', '标准交付', '验证 → 人工点头 → 合并', ...STANDARD], ['frontend', '前端真实验收', '验证 → 起预览 → 人工点头 → 合并', ['run', 'verify', 'preview', 'human', 'accept'], 2, '构建、浏览器点检'],
    ['release', '发布流水', '验证 → 人工点头 → 合并 → 跑发布脚本', ['run', 'verify', 'human', 'accept', 'command'], 2, '构建、测试、代码检查']];
  const STOPS = { run: '让 AI 干活', verify: '自动验证', preview: '打开预览', human: '等我点头', command: '跑一条命令', accept: '合并并清理' };
  const STARTERS = [
    ['⌁', '解决一个问题', '现象 → 原因 → 修复与验证', 'single', '请帮我定位并修复这个问题。\n\n现象：\n复现步骤：\n期望结果：\n\n完成后，请运行相关检查并说明根因。'],
    ['＋', '做一个新功能', '目标 → 边界 → 交付标准', 'single', '我想增加一个新功能。\n\n使用场景：\n需要实现：\n不在本次范围：\n\n验收标准：'],
    ['⇄', '讨论一个方案', '比较取舍，形成共同结论', 'duet', '请比较下面的方案，并形成一个可执行的结论。\n\n背景：\n候选方案：\n主要顾虑：\n\n请说明各自的收益、成本和推荐理由。'],
  ];
  const who = (agent) => ({ agent, model: ASH.AGENTS?.[agent]?.models[0] ?? null, level: null });
  /* 样机里存着的两条组合预设（名字是编的） */
  const presets = () => [
    { id: 'p-mix', name: 'Claude 调度 · Codex 执行', lead: who('claude'), worker: who('codex'), reviewer: who('codex'), review: true },
    { id: 'p-fast', name: '全 Claude · 不自动审查', lead: who('claude'), worker: who('claude'), reviewer: who('claude'), review: false },
  ];
  const TEAM = ['lead', 'worker', 'reviewer'];
  const ROLES = { team: [['lead', '调度者执行器', '调度'], ['worker', '执行者执行器', '执行'], ['reviewer', '审查者执行器', '审查']], duet: [['voiceA', '讨论者 A', 'A'], ['voiceB', '讨论者 B', 'B']] };

  const nameOf = (pairs, value) => pairs.find(([v]) => v === value)?.[1] ?? '';
  const runText = (w) => `CLI 官方账号 · ${w.model ?? 'CLI 默认模型'} · ${w.level ?? 'CLI 默认档位'}`;
  const runLine = (role, w) => h('p.run', {}, h('b', role), ` · ${runText(w)}`);
  const same = (a, b) => a.agent === b.agent && (a.model ?? null) === (b.model ?? null) && (a.level ?? null) === (b.level ?? null);
  const replay = (el) => { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); };

  /* 浮层里的几种行：标题（名字 + 收起）、开关、下拉、说明 */
  const head = (label, api) => h('header', {}, h('b', label), h('button.ico.sm', { type: 'button', 'aria-label': `收起${label}`, onclick: () => api.close(true) }, icon('x')));
  const help = (...kids) => h('p.help', {}, kids);
  const field = (label, control) => h('div.row', {}, h('span', label), control);
  function toggle(label, on, say, onchange) {
    const knob = h('span.switch', { 'aria-checked': String(on) });
    const text = h('small', say[on ? 0 : 1]);
    const btn = h('button.row', { type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label, onclick: () => {
      on = !on;
      btn.setAttribute('aria-checked', String(on));
      knob.setAttribute('aria-checked', String(on));
      text.textContent = say[on ? 0 : 1];
      onchange(on);
    } }, h('span', label), text, knob);
    return btn;
  }
  /* 下拉：长相是公共的 .sel，菜单是公共的 ASH.menu；自己开是因为有的选项是一个动作（＋ 新建分组…），点了不该变成当前值。
     pairs 可以是函数（选项会变）；acts = { 值: 动作 } */
  function select(label, value, pairs, onchange, acts = {}) {
    const list = () => (typeof pairs === 'function' ? pairs() : pairs);
    const text = h('span', nameOf(list(), value));
    const btn = h('button.sel', { type: 'button', 'aria-haspopup': 'listbox', 'aria-label': label }, text, icon('caret'));
    btn.addEventListener('click', () => ASH.menu(btn, list().map(([v, name, detail]) => ({ label: name, kbd: detail, selected: v === value, onpick: () => {
      if (acts[v]) { acts[v](); return; }
      value = v;
      text.textContent = name;
      onchange(v);
    } })), { role: 'listbox', cls: 'sv-home-menu' }));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); btn.click(); } });
    return btn;
  }
  /* 就地起名（新分组、组合预设）：回车存，Esc 或空着离开算取消。data-esc 告诉外层浮层这一下 Esc 先归它 */
  function nameInput(label, value, onsave, oncancel) {
    let settled = false;
    const input = h('input.field', { 'aria-label': label, placeholder: label, value, 'data-esc': '' });
    const settle = (save) => {
      if (settled) return;
      const name = input.value.trim();
      if (save && !name) { input.focus(); return; }
      settled = true;
      if (save) onsave(name); else oncancel();
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); settle(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(false); }
    });
    return { input, settle };
  }

  /* ---------- 工作方式（单任务）/ 如何交付（团队、讨论） ---------- */
  const flowOf = (d) => FLOWS.find(([v]) => v === d.preset) ?? FLOWS[0];
  const stopSay = (kind, flow) => ({
    verify: `${flow[5]}；没过打回重做，最多 ${flow[4]} 轮`,
    preview: 'npm run dev，你点头后关掉',
    human: flow[0] === 'frontend' ? '看改动、报告和截图' : '看改动和报告',
    accept: '合并回项目分支，清理工作目录',
    command: './scripts/release.sh',
  })[kind];
  function work(d, mode, api) {
    if (mode === 'team') return [head('如何交付', api), toggle('自动审查', d.review, ['已开启', '已关闭'], (on) => { d.review = on; api.paint(); })];
    if (mode === 'duet') return [head('如何交付', api),
      field('最多轮数', select('最多轮数', d.rounds, ROUNDS, (v) => { d.rounds = v; api.paint(); })),
      toggle('共识闸门', d.gate, ['需要确认', '自动结束'], (on) => { d.gate = on; api.paint(); })];
    const body = h('div');
    const tabs = h('div.seg', { role: 'group', 'aria-label': '工作方式' }, [['free', '自由工作流'], ['preset', '起手式']].map(([key, name]) => h('button', { type: 'button', 'data-flow': key, onclick: () => {
      if (d.flow === key) return;
      d.flow = key;
      draw(true);
      api.paint();
      api.fit();
    } }, name)));
    /* 起手式那一半：这条线的站点和花销。展开编排 = 每一站后面摊开它的参数；谁来干活在「让 AI 干活」那一站选（底排那颗胶囊这时只读） */
    let open = false;
    function line() {
      const flow = flowOf(d);
      const stops = flow[3];
      const run = runLine('让 AI 干活', d.who.single);
      const who = () => ASH.target({ value: d.who.single, label: '让 AI 干活的执行器', onchange: (value) => {
        d.who.single = value;
        run.replaceChildren(h('b', '让 AI 干活'), ` · ${runText(value)}`);
        api.paint();
      } }).el;
      const redraw = (focus) => { body.replaceChildren(...line()); body.querySelector(focus)?.focus({ preventScroll: true }); };
      const grow = h('button.btn.sm.quiet', { type: 'button', 'aria-expanded': String(open), onclick: () => { open = !open; redraw('.sub .btn'); } }, open ? '收起' : '展开编排');
      return [run,
        h('div.sub', {}, h('div', {}, h('b', '干完之后'), h('span', '谁来验、什么时候停下等你、过了要不要合并。')), grow),
        field('起手式', select('起手式', d.preset, FLOWS, (v) => { d.preset = v; redraw('.sel'); })),
        h(`ol.stops${open ? '.is-open' : ''}`, { 'aria-label': '这条线上的站' }, stops.map((kind, i) => h('li', {}, h('i.num', String(i + 1).padStart(2, '0')), h('b', STOPS[kind]), open && (kind === 'run' ? who() : h('span', stopSay(kind, flow)))))),
        h('p.cost', {}, '顺利走完 ', h('b.num', String(stops.length)), ' 步 · 要你出面 ', h('b.num', String(stops.filter((kind) => kind === 'human').length)), ' 次 · 不顺利最多起 ', h('b.num', String(1 + (stops.includes('verify') ? flow[4] : 0))), ' 次 AI')];
    }
    function draw(fresh) {
      for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.flow === d.flow));
      if (d.flow === 'free') body.replaceChildren(help('由输入框下方的任务执行器完成目标，按需派审和预览，完成后统一验收。'), runLine('任务执行器', d.who.single));
      else body.replaceChildren(...line());
      if (fresh) replay(body);
    }
    draw(false);
    return [head('工作方式', api), tabs, body];
  }

  /* ---------- 工作目录：worktree 开关和 base 分支，外加「本项目默认」那一句 ---------- */
  function where(d, mode, api) {
    const dir = (on) => (on ? '独立 worktree' : '项目目录');
    const base = select('base 分支', d.base, BRANCHES, (v) => { d.base = v; api.paint(); });
    const note = h('p.help');
    function draw() {
      base.disabled = !d.worktree;
      if (d.worktree === d.worktreeDefault) { note.replaceChildren(`本项目默认就是「${dir(d.worktreeDefault)}」，到「设置 → 项目设置 → 工作目录」可随时改。`); return; }
      note.replaceChildren(`本项目默认是「${dir(d.worktreeDefault)}」，这次只对本任务生效。`,
        h('button.btn.sm', { type: 'button', onclick: () => { d.worktreeDefault = d.worktree; draw(); } }, '设为本项目默认'));
    }
    draw();
    return [head('工作目录', api), toggle('worktree', d.worktree, ['独立 worktree', '直接使用项目目录'], (on) => { d.worktree = on; draw(); api.paint(); }), field('base 分支', base), note];
  }

  /* ---------- 组织与标签：分组（讨论没有）和标签 ---------- */
  function org(d, mode, api) {
    const input = h('input', { 'aria-label': '添加标签', placeholder: '添加' });
    const box = h('div.labels');
    const add = () => {
      const label = input.value.trim().replace(/^#/, '');
      input.value = '';
      if (!label || d.labels.includes(label)) return;
      d.labels.push(label);
      draw();
      api.paint();
    };
    function draw() {
      box.replaceChildren(...d.labels.map((label) => h('button', { type: 'button', 'aria-label': `移除标签 ${label}`, onclick: () => { d.labels = d.labels.filter((l) => l !== label); draw(); api.paint(); input.focus(); } }, h('span.cut', label), icon('x', 'sm'))),
        h('label', {}, icon('plus', 'sm'), input));
    }
    input.addEventListener('blur', add);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229 || (e.key !== 'Enter' && e.key !== ',' && e.key !== '，')) return;
      e.preventDefault();
      add();
      input.focus();
    });
    draw();
    /* 分组那一行：平时是下拉；选了「＋ 新建分组…」就地变成起名的输入框，建好即选中 */
    const row = h('div.row');
    const pick = (focus) => {
      const sel = select('分组', d.group, () => [...groups, [NEW_GROUP, '＋ 新建分组…']], (v) => { d.group = v; api.paint(); }, { [NEW_GROUP]: naming });
      row.replaceChildren(h('span', '分组'), sel);
      if (focus) sel.focus();
    };
    function naming() {
      const name = nameInput('新分组的名字', '', (text) => {
        const id = `g-${groups.length}`;
        groups.push([id, text, '串行']);
        d.group = id;
        api.paint();
        pick(true);
      }, () => pick(true));
      name.input.addEventListener('blur', () => name.settle(Boolean(name.input.value.trim())));
      row.replaceChildren(h('span', '分组'), name.input);
      name.input.focus();
    }
    pick(false);
    return [head('组织与标签', api), mode !== 'duet' && row, h('div.row.top', {}, h('span', '标签'), box)];
  }

  /* ---------- 更多选项：写作参考（现状的「任务示例」）搬到这里 ---------- */
  function more(d, mode, api) {
    return [head('更多选项', api), h('h3.sec', '写作参考'), help('选一个起点，接着写。已有正文会保留。'),
      h('div.starters', { role: 'group', 'aria-label': '任务示例' }, STARTERS.map(([sign, name, say, to, body]) => h('button', { type: 'button', onclick: () => {
        api.close();
        api.insert(body);
        api.setMode(to === 'duet' ? 'duet' : 'single');
      } }, h('i', sign), h('span', {}, h('b', name), h('small', say)), icon('arrow', 'sm'))))];
  }

  /* ---------- 谁来做：团队是组合预设 + 调度 / 执行 / 审查三行，讨论是 A、B 两行；每行一颗三段胶囊 ---------- */
  function cast(d, mode, api) {
    const rows = h('div.roles');
    const bar = h('div.presets');
    let naming = null;   /* 正在起名：{ preset }（重命名）或 { preset: null }（保存当前组合） */
    function drawRows() {
      rows.replaceChildren(...ROLES[mode].map(([role, label, short]) => {
        const line = runLine(short, d.who[role]);
        const target = ASH.target({ value: d.who[role], label, onchange: (value) => {
          d.who[role] = value;
          line.replaceChildren(h('b', short), ` · ${runText(value)}`);
          if (mode === 'team') drawBar();
          api.paint();
        } });
        return h('div.role', {}, h('span', label), target.el, line);
      }));
    }
    function drawBar(focus) {
      const on = d.presets.find((p) => p.id === d.teamPreset);
      const off = on && (TEAM.some((role) => !same(on[role], d.who[role])) || on.review !== d.review);
      const snap = () => ({ ...Object.fromEntries(TEAM.map((role) => [role, { ...d.who[role] }])), review: d.review });
      const apply = (p) => {
        d.teamPreset = p.id;
        for (const role of TEAM) d.who[role] = { ...p[role] };
        d.review = p.review;
        naming = null;
        drawRows();
        drawBar(`[data-preset="${p.id}"]`);
        api.paint();
      };
      const remove = async () => {
        if (!(await ASH.confirm({ title: '删除执行模式预设', body: `确定删除「${on.name}」？已经用它创建的团队不会受影响。`, ok: '删除', danger: true }))) return;
        d.presets = d.presets.filter((p) => p !== on);
        d.teamPreset = null;
        drawBar('.sub .btn');
      };
      const rename = (preset) => { naming = { preset }; drawBar('input'); };
      const name = naming && nameInput('预设名称', naming.preset?.name ?? '', (text) => {
        if (naming.preset) naming.preset.name = text;
        else { const id = `p-${Date.now().toString(36)}`; d.presets.push({ id, name: text, ...snap() }); d.teamPreset = id; }
        naming = null;
        drawBar(`[data-preset="${d.teamPreset}"]`);
      }, () => { naming = null; drawBar(on ? '.pnow .btn' : '.sub .btn'); });
      bar.replaceChildren(...[
        h('div.sub', {}, h('div', {}, h('b', '组合预设'), h('span', '一键切换调度、执行与审查分工')),
          h('button.btn.sm', { type: 'button', disabled: Boolean(naming), onclick: () => rename(null) }, '保存当前组合')),
        d.presets.length ? h('div.plist', { role: 'group', 'aria-label': '已保存的执行模式' }, d.presets.map((p) => h('button', { type: 'button', 'data-preset': p.id, 'aria-pressed': String(p === on), onclick: () => apply(p) },
          h('b.cut', p.name), h('span', {}, p.lead.agent, icon('arrow', 'sm'), p.worker.agent), h('small', {}, icon('search', 'sm'), p.review ? p.reviewer.agent : '自动审查关闭'))))
          : help('还没有预设；保存当前组合后，可在这里一键复用。'),
        name ? h('form.pnow', { onsubmit: (e) => { e.preventDefault(); name.settle(true); } }, name.input,
          h('button.btn.sm.pri', { type: 'submit' }, '保存'), h('button.btn.sm.quiet', { type: 'button', onclick: () => name.settle(false) }, '取消'))
          : on && h('div.pnow', {}, h(`span.grow.cut${off ? '.is-off' : ''}`, off ? `当前配置已偏离「${on.name}」` : `正在使用「${on.name}」`),
            off && h('button.btn.sm', { type: 'button', onclick: () => { Object.assign(on, snap()); drawBar('.pnow .btn'); } }, '用当前配置更新'),
            h('button.btn.sm.quiet', { type: 'button', onclick: () => rename(on) }, '重命名'),
            h('button.btn.sm.quiet.danger', { type: 'button', onclick: remove }, '删除')),
      ].filter(Boolean));
      if (focus) { const el = bar.querySelector(focus); el?.focus({ preventScroll: true }); el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); if (el?.matches('input')) el.select(); }
    }
    drawRows();
    if (mode === 'team') drawBar();
    return [head('谁来做', api), mode === 'team' && bar, rows];
  }

  ASH.homeOpts = {
    defaults: () => ({
      flow: 'free', preset: '', review: true, rounds: '3', gate: true,
      worktree: true, worktreeDefault: true, base: '', group: '', labels: [],
      who: { single: who('claude'), lead: who('claude'), worker: who('codex'), reviewer: who('codex'), voiceA: who('claude'), voiceB: who('codex') },
      presets: presets(), teamPreset: null,
    }),
    /* 入口上写什么：text 是看得见的字（照现状那颗键上的字），label / value 进提示和读屏（现状的 aria-label 就是「名字：当前值」） */
    face(d, mode) {
      const duet = mode === 'duet';
      const organization = [!duet && d.group && nameOf(groups, d.group), d.labels.length > 0 && `${d.labels.length} 个标签`].filter(Boolean).join(' · ');
      const dir = d.worktree ? '独立 worktree' : '项目目录';
      return {
        work: mode === 'single' ? { label: '工作方式', glyph: 'flow', text: d.flow === 'preset' ? '起手式' : '自由工作流' }
          : mode === 'team' ? { label: '如何交付', glyph: 'check', text: d.review ? '自动审查' : '按需审查' }
            : { label: '如何交付', glyph: 'check', text: '讨论规则', value: `${d.rounds ? `最多 ${d.rounds} 轮` : '不限轮数'} · ${d.gate ? '需要确认共识' : '自动结束'}` },
        where: duet ? null : { label: '工作目录', glyph: d.worktree ? 'fork' : 'folder', text: dir, value: `${dir}${d.worktree ? ` · ${d.base || AUTO_BASE}` : ''}` },
        org: { label: '组织与标签', glyph: 'tag', text: organization || (duet ? '标签' : '分组与标签'), value: organization || '无分组、无标签', set: Boolean(organization) },
        cast: mode === 'single' ? null : { label: '谁来做', glyph: duet ? 'chat' : 'team', text: duet ? '讨论者' : '团队配置', value: duet ? `${d.who.voiceA.agent} × ${d.who.voiceB.agent}` : `${d.who.lead.agent} 调度` },
        run: `${d.who.single.model ?? 'CLI 默认模型'} · ${d.who.single.level ?? 'CLI 默认档位'}`,
      };
    },
    /* 哪几张要宽的那一档（照现状：谁来做、选了起手式的工作方式） */
    wide: (kind, d, mode) => kind === 'cast' || (kind === 'work' && mode === 'single' && d.flow === 'preset'),
    sheet: (kind, d, mode, api) => ({ work, where, org, more, cast })[kind](d, mode, api),
  };
})();
