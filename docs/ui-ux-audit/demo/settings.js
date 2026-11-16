/* 设置页（面 settings）：整面替换外壳，左边导航、右边一列内容。
   照真实设置页（web/src/settings）画：页的名字和次序、每页的节、每一行的名字和按钮都是现状；
   不一样的只有清单 set-1…set-4、set-keep 写明的那几处，和全应用的字号、颜色规则。
   这个文件：外壳与导航、各页共用的小件（ASH.setKit）、几页共用的数据（ASH.setData）、执行器页。
   起手式页在 settings-flow.js，其余各页在 settings-pages*.js，各自往 ASH.setPages 里登记：
     ASH.setPages.<页> = (page, ctx) => 卸载时要做的事（可没有）
       page 是 div.sv-set-page，往里 append 就行；ctx.timers 里的定时器切页时会清掉。
   路由 #/settings/<页>，页名：project groups archive providers agents modes workflow reviewers feishu config defaults。

   ASH.setKit —— 一行一个；长相都在 settings.css，各页不用再写：
     head(title, lead?, action?)   → header。17px 页标题；lead = 标题下至多一句说明；action = 这一页唯一的页级动作（一颗按钮）
     sec(title)                    → h2.sec。分节小标题，后面跟一张 card
     card(...kids)                 → div.card。一节一张，里面放 row / foot / 表格
     row(name, hint, ...ctl)       → 设置行。左边名字（可 null）和说明（一句、几句的数组或 null），右边控件；控件是多行输入框时自动上下排
     foot(note, ...ctl)            → 卡脚。左边一句话，右边按钮
     pick(label, pairs, value, onchange?)   → Select，pairs = [[值, 名字], …]，onchange(值)。表单里用，和输入框同高同框
     pickSm(…同上)                          → 同一个 Select 的紧凑档（无框、24 高），表格行和键值行里用
     flowPick(label, inherit, value?)       → 选起手式的 Select；inherit 是第一项「跟着上一级走」写什么
     seg(label, pairs, value, onchange?)    → 分段单选，pairs 同上。两三项、名字短的时候用它，不用 Select
     sw(on, [开着写什么, 关着写什么], onchange?)   → label.sv-set-sw：开关加旁边跟着换的字；里面第一个孩子是 button.switch，onchange(开没开)
     text(label, value?, attrs?)   → 单行输入框。attrs 直接落到 input 上；attrs.class 可给 mono（等宽）、sv-set-num（短数字）、grow（占满剩下的宽）
     area(label, value?, placeholder?, rows?, attrs?)   → 多行输入框，随内容长高，rows = 最少几行；attrs 同上
     btn(label, onclick, cls?, icon?)   → 按钮。cls 是 '.pri' '.quiet' '.danger' '.sm'，可连写（'.quiet.sm'）；icon 是 ASH.icons 里的名字
     stub(label, cls?, icon?)      → 入口在、名字对、样机没画下文的按钮：点了在样机自己那条栏里说一句
     saver(label, ...inputs)       → 主按钮：平时灰着，动过它管的输入框才亮，点完又灰回去
     leave(el)                     → 淡出后删掉
     replay(el)                    → 让它重新进场一次（换了内容时用）
   「选谁干活」不在这里：一律用 ASH.target（三段胶囊）。回不去的动作走 ASH.confirm。 */
(() => {
  const { h, $, $$, icon } = ASH;
  const P = (ASH.setPages ??= {});

  ASH.icons.setBack ??= '<path d="M13 8H3M7 4 3 8l4 4"/>';
  ASH.icons.setLayers ??= '<path d="m8 2.5 5.5 3-5.5 3-5.5-3z"/><path d="m2.5 9 5.5 3 5.5-3"/>';
  ASH.icons.setPlug ??= '<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7V8a3.5 3.5 0 0 1-7 0zM8 11.5v2"/>';
  ASH.icons.setSwap ??= '<path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13"/>';
  ASH.icons.setBan ??= '<circle cx="8" cy="8" r="5.5"/><path d="m4.2 4.2 7.6 7.6"/>';
  ASH.icons.setTurn ??= '<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7"/>';

  /* 导航：项目一组、系统一组，名字和次序同 web/src/settings/sections.ts（多人模式才有的那几节不画） */
  const NAV = [
    [ASH.data.project, [['project', '项目设置', 'folder'], ['groups', '分组', 'setLayers'], ['archive', '已归档', 'box']]],
    ['系统设置', [['providers', '供应商', 'setPlug'], ['agents', '执行器', 'bot'], ['modes', '执行模式', 'team'], ['workflow', '起手式', 'flow'],
      ['reviewers', '审查者', 'search'], ['feishu', '飞书', 'chat'], ['config', '配置搬家', 'setSwap'], ['defaults', '默认规则', 'sliders']]],
  ];
  const WIDE = ['workflow'];   /* 横着长的那一页（站点线）用宽栏，其余同宽，和现在一样 */

  /* ---------- 几页共用的数据：供应商、执行器、起手式。改动留在这里，切页再回来还在 ----------
     S.providers  [{ id, name, proto: 'anthropic' | 'openai', url, model }]
     S.agents     [{ id, cli, ver, profiles: [{ name, prov, model, level, speed, cfg, def, args }] }]；profiles 为空 = 装了但还没注册
     S.flows      [{ key, name, desc, iso, stops: [{ kind, p, fail }], builtin, off, modified }]；S.flow = 起手式页正看着哪一条
     S.SHORT      站的短名 { run: '干活', … }；S.stop(kind, 参数?, 打回轮数?) 造一站；S.builtinFlow(key) 造一条系统自带的线 */
  const SHORT = { run: '干活', verify: '验证', preview: '预览', human: '等我点头', command: '命令', accept: '合并' };
  const PARAMS = {
    run: () => ({ instruction: '', who: null }),
    verify: () => ({ who: null, checks: ['build'] }),
    preview: () => ({ cmd: 'npm run dev', mode: 'test', ready: 'port+log', life: 'gate' }),
    human: () => ({ show: ['diff', 'report'], notify: ['inbox', 'push'] }),
    command: () => ({ cmd: 'npm run lint', where: 'workspace' }),
    accept: () => ({ strategy: 'safe', clean: 'all' }),
  };
  /* 一站：种类、参数、失败了怎么办（预览和等我点头没有这一项）。back = 打回给 AI 重做的轮数 */
  const stop = (kind, p = {}, back = 0) => ({ kind, p: { ...PARAMS[kind](), ...p }, fail: kind === 'preview' || kind === 'human' ? null : { mode: back ? 'back' : 'stop', max: back || 2 } });
  const BUILTIN = {
    blank: ['空白', '从一步开始，自己搭', true, () => [stop('run')]],
    fast: ['极速原型', '干完就算完', false, () => [stop('run')]],
    standard: ['标准交付', '验证 → 人工点头 → 合并', true, () => [stop('run'), stop('verify', { checks: ['build', 'tests'] }, 2), stop('human'), stop('accept')]],
    frontend: ['前端真实验收', '验证 → 起预览 → 人工点头 → 合并', true,
      () => [stop('run'), stop('verify', { checks: ['build', 'browser'] }, 2), stop('preview'), stop('human', { show: ['diff', 'report', 'shots'] }), stop('accept')]],
    release: ['发布流水', '验证 → 人工点头 → 合并 → 跑发布脚本', true,
      () => [stop('run'), stop('verify', { checks: ['build', 'tests', 'lint'] }, 2), stop('human'), stop('accept'), stop('command', { cmd: './scripts/release.sh', where: 'repo' })]],
  };
  const builtinFlow = (key) => { const [name, desc, iso, stops] = BUILTIN[key]; return { key, name, desc, iso, stops: stops(), builtin: true, off: false, modified: false }; };
  const profile = (name, more = {}) => ({ name, prov: '', model: '', level: '', speed: 'standard', cfg: '', def: false, args: [], ...more });

  const S = (ASH.setData = {
    SHORT, stop, builtinFlow,
    providers: [
      { id: 'gw', name: '示例网关', proto: 'anthropic', url: 'https://api.example.com', model: 'opus-5-5' },
      { id: 'gw2', name: '备用网关', proto: 'openai', url: 'https://api.example.com/v1', model: '' },
    ],
    /* 本机装着的 CLI。模型和档位取 ASH.AGENTS，那里没有的自己带 */
    agents: [
      { id: 'claude', cli: 'Claude Code', ver: '2.4.1', profiles: [
        profile('claude@local', { model: 'opus-5-5', level: 'high', cfg: '400k · 80%', def: true }),
        profile('claude@local·1', { prov: 'gw', model: 'sonnet-5' })] },
      { id: 'codex', cli: 'Codex CLI', ver: '0.63.0', profiles: [
        profile('codex@local', { model: 'gpt-5.6-sol', level: 'xhigh', speed: 'fast', def: true }),
        profile('codex@local·1', { prov: 'gw2', model: 'gpt-5.5', level: 'high' })] },
      { id: 'gemini', cli: 'Gemini CLI', ver: '0.21.0', profiles: [profile('gemini@local', { def: true })] },
      { id: 'qwen', cli: 'Qwen Code', ver: '0.5.2', models: ['qwen3-coder-plus', 'qwen3-coder-flash'], levels: ['low', 'medium', 'high'], profiles: [] },
    ],
    flows: Object.keys(BUILTIN).map(builtinFlow),
    flow: 'frontend',
    made: 0,
  });

  /* ---------- 各页共用的小件（用法见文件头） ---------- */
  const opt = (pairs) => pairs.map(([value, label]) => ({ value, label }));
  const pick = (label, pairs, value, onchange) => ASH.select({ value, options: opt(pairs), label, onchange });
  const pickSm = (label, pairs, value, onchange) => ASH.select({ value, options: opt(pairs), label, onchange, compact: true });
  const btn = (label, onclick, cls = '', ico) => h(`button.btn${cls}`, { type: 'button', onclick }, ico && icon(ico), label);
  const stub = (label, cls = '', ico) => btn(label, () => ASH.todo(label.replace(/…$/, '')), cls, ico);
  /* 输入框：调用方给的 class 接在 field 后面，不顶掉它 */
  const input = (tag, label, { class: cls = '', ...attrs }, ...kids) => h(tag, { class: `field ${cls}`.trim(), 'aria-label': label, spellcheck: 'false', ...attrs }, kids);
  const text = (label, value = '', attrs = {}) => input('input', label, { type: 'text', value, ...attrs });
  const area = (label, value = '', placeholder = '', rows = 3, { class: cls = '', ...attrs } = {}) =>
    input('textarea', label, { class: `sv-set-area ${cls}`, rows, placeholder, style: `--rows: ${rows}`, ...attrs }, value);
  const card = (...kids) => h('div.card', kids);
  const sec = (title) => h('h2.sec', title);
  const row = (name, hint, ...ctl) => h('div.sv-set-row', h('div', name && h('b', name), [hint].flat().filter(Boolean).map((t) => h('small', t))), ctl);
  const foot = (note, ...ctl) => h('div.sv-set-foot', h('span.grow', note), ctl);
  const head = (title, lead, action) => h('header.sv-set-head', h('div.grow', h('h1', { 'data-m': 'set-3' }, title), lead && h('p', lead)), action);
  /* 开关：旁边那几个字跟着开合换，和现在一样。字包在 label 里，点字也能拨 */
  const sw = (on, words, onchange) => {
    const word = h('span', words[on ? 0 : 1]);
    const key = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(!!on), onclick: () => {
      const next = key.getAttribute('aria-checked') !== 'true';
      key.setAttribute('aria-checked', String(next));
      ASH.swap(word, words[next ? 0 : 1]);
      onchange?.(next);
    } });
    return h('label.sv-set-sw', key, word);
  };
  const seg = (label, pairs, value, onchange) => {
    const box = h('div.seg', { role: 'group', 'aria-label': label }, pairs.map(([v, name]) => h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: (e) => {
      for (const b of box.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      onchange?.(v);
    } }, name)));
    return box;
  };
  const saver = (label, ...inputs) => {
    const b = btn(label, () => { b.disabled = true; }, '.pri');
    b.disabled = true;
    for (const el of inputs) el.addEventListener('input', () => { b.disabled = false; });
    return b;
  };
  const leave = (el) => { el.classList.remove('enter'); el.classList.add('is-leaving'); setTimeout(() => el.remove(), 130); };
  const replay = (el) => { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); };
  /* 选起手式的下拉：第一项是「跟着上一级走」，其余写「名字 · 干活 → 验证 → …」 */
  const flowPick = (label, inherit, value = '') => pick(label, [['', inherit], ...S.flows.filter((f) => !f.off).map((f) => [f.key, `${f.name} · ${f.stops.map((s) => SHORT[s.kind]).join(' → ')}`])], value);
  ASH.setKit = { pick, pickSm, btn, stub, text, area, card, sec, row, foot, head, sw, seg, saver, leave, replay, flowPick };

  /* ---------- 执行器页（清单 set-1、set-2、set-4）：一种 CLI 一张卡，卡里一个 Profile 一行，列和现在一样多。
     卡头的「新增」「删除全部」、行里点名字改名、供应商 / 模型 / 智能水平 / 速度 / CLI 配置都照现状；
     行尾的三个动作（额外 CLI 参数、设为默认执行器、删除）收进常驻的一颗「更多」。 ---------- */
  const AVATAR = { claude: 'C', codex: 'X', antigravity: 'A' };
  const specOf = (a) => ASH.AGENTS[a.id] ?? a;

  /* 「更多 → 额外 CLI 参数」：一项一个 token，存了才算数 */
  function argsPop(anchor, pf) {
    const draft = [...pf.args];
    const list = h('div.sv-set-tokens');
    const state = h('span.grow');
    const field = text('要添加的参数', '', { class: 'mono grow' });
    const paint = () => {
      field.placeholder = draft.length ? '继续添加' : '例如 --dangerously-skip-permissions';
      list.replaceChildren(...draft.map((token, i) => h('span', h('code', token), h('button.ico.sm', { type: 'button', 'aria-label': `删除参数 ${token}`, onclick: () => { draft.splice(i, 1); paint(); field.focus(); } }, icon('x')))));
      state.textContent = draft.join('\n') === pf.args.join('\n') ? `${draft.length} 项参数` : '有未保存更改';
    };
    const add = () => { const token = field.value.trim(); if (!token) return; draft.push(token); field.value = ''; paint(); field.focus(); };
    const shut = () => { ASH.closePop(); anchor.focus(); };
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    paint();
    const open = ASH.pop(anchor, h('div.sv-set-args', { role: 'dialog', 'aria-label': `${pf.name} 的额外 CLI 参数` },
      h('div', h('b', '额外 CLI 参数'), h('small', `${pf.name} · 每项按单个 token 传递`)), list,
      h('div.sv-set-line', field, btn('添加', add, '.quiet.sm', 'plus')),
      h('div.sv-set-line', state, btn('取消', shut, '.quiet.sm'), btn('保存参数', () => { pf.args = draft; shut(); }, '.sm'))), { place: 'bottom-end' });
    if (open) field.focus();
  }

  P.agents = (page, ctx) => {
    const cards = h('div.sv-set-stack');
    const none = h('p.none', '还没有 Profile；检测本地智能体并注册。');
    const els = new Map();
    let found = null;
    /* 清单的三颗圆圈落在第一张卡上：卡本身、「智能水平」列头、第一颗模型下拉 */
    const mark = () => {
      for (const el of $$('[data-m]', cards)) el.removeAttribute('data-m');
      const first = $('.sv-set-agent:not(.is-leaving)', cards);
      first?.setAttribute('data-m', 'set-1');
      first?.querySelector('[data-col="level"]')?.setAttribute('data-m', 'set-4');
      first?.querySelector('.sv-set-tr [data-col="model"]')?.setAttribute('data-m', 'set-2');
      none.hidden = !!first;
    };

    const draw = (a, fresh) => {
      const hasCfg = a.id === 'claude';   /* 只有声明过可覆盖项的 CLI 才有「CLI 配置」这一列，目前只有 claude */
      const count = h('small');
      const defName = h('small.cut');
      const list = h('div', { role: 'rowgroup' });
      const meta = () => {
        count.textContent = `${a.profiles.length} 个 Profile`;
        defName.textContent = `默认 · ${a.profiles.find((x) => x.def)?.name ?? '内置本地执行器'}`;
      };
      const rows = () => { meta(); list.replaceChildren(...a.profiles.map(line)); mark(); };
      const drop = () => { els.delete(a); leave(el); mark(); if (found) showFound(); };

      const line = (pf) => {
        const who = h('div', { role: 'cell' });
        const rename = () => {
          const field = text(`${pf.name} 的 Profile 名称`, pf.name);
          let cancelled = false;
          field.addEventListener('blur', () => { const name = field.value.trim(); if (!cancelled && name) pf.name = name; showName(); meta(); });
          field.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') field.blur();
            if (e.key === 'Escape') { e.stopPropagation(); cancelled = true; field.blur(); }
          });
          who.replaceChildren(field);
          field.focus();
          field.select();
        };
        const showName = () => who.replaceChildren(h('button.sv-set-name.cut', { type: 'button', 'data-tip': '点击编辑名称', onclick: rename }, pf.name));
        showName();

        const provs = [['', 'CLI 官方账号'], ...S.providers.filter((p) => (p.proto === 'anthropic') === (a.id === 'claude')).map((p) => [p.id, p.name])];
        const refocus = (col) => list.children[a.profiles.indexOf(pf)]?.querySelector(`[data-col="${col}"]`)?.focus();
        /* 换供应商时模型和智能水平回到「跟随」，和现在一样 */
        const prov = pickSm(`${pf.name} 的供应商`, provs, pf.prov, (v) => { pf.prov = v; pf.model = ''; pf.level = ''; rows(); refocus('prov'); });
        const model = pickSm(`${pf.name} 的模型`, [['', pf.prov ? '跟随供应商默认' : '跟随 CLI'], ...specOf(a).models.map((m) => [m, m])], pf.model, (v) => { pf.model = v; });
        /* 档位照原值写（low / medium / high…）；没指定时格子里只写「跟随」，菜单里那一行是「跟随 CLI」 */
        const level = pickSm(`${pf.name} 的智能水平`, [['', '跟随 CLI'], ...specOf(a).levels.map((l) => [l, l])], pf.level, (v) => { pf.level = v; level.firstChild.textContent = v || '跟随'; });
        if (!pf.level) level.firstChild.textContent = '跟随';
        const speed = pickSm(`${pf.name} 的速度`, [['standard', '标准'], ['fast', '1.5x']], pf.speed, (v) => { pf.speed = v; });
        for (const [col, sel] of [['prov', prov], ['model', model], ['level', level], ['speed', speed]]) sel.setAttribute('data-col', col);

        const remove = async () => {
          if (!(await ASH.confirm({ title: '删除执行器', body: `确定删除“${pf.name}”？已有任务会按类型默认执行器降级。`, ok: '删除', danger: true }))) return;
          a.profiles = a.profiles.filter((x) => x !== pf);
          if (a.profiles.length) rows(); else drop();
        };
        const more = h('button.ico.sm', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': `${pf.name} 的更多操作`, 'data-tip': '更多', 'data-col': 'more', onclick: () => ASH.menu(more, [
          { label: '额外 CLI 参数', icon: 'sliders', onpick: () => argsPop(more, pf) },
          { label: '设为默认执行器', icon: 'star', disabled: pf.def, onpick: () => { for (const x of a.profiles) x.def = x === pf; rows(); refocus('more'); } },
          '-',
          { label: '删除', icon: 'trash', onpick: remove },
        ], { place: 'bottom-end' }) }, icon('more'));

        return h('div.sv-set-tr', { role: 'row' }, who, cell(prov), cell(model), cell(level), cell(speed),
          hasCfg && cell(h(`button.sv-set-cfg${pf.cfg ? '.is-set' : ''}`, { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': pf.cfg ? `${pf.name} 覆盖了 CLI 配置：${pf.cfg}` : `编辑 ${pf.name} 对 CLI 配置的覆盖`, onclick: () => ASH.todo('覆盖 CLI 配置的浮层') },
            icon('sliders', 'sm'), h('span.cut', pf.cfg || '未覆盖'))),
          h('div.sv-set-end', { role: 'cell' }, pf.def && h('span.sv-set-def', icon('star', 'sm fill'), '默认'), more));
      };

      const addOne = () => {
        let n = 1;
        while (S.agents.some((x) => x.profiles.some((y) => y.name === `${a.id}@local·${n}`))) n += 1;
        a.profiles.push(profile(`${a.id}@local·${n}`, { def: !a.profiles.length }));
        rows();
      };
      const removeAll = async () => {
        if (!(await ASH.confirm({ title: `删除全部 ${a.id} 执行器`, body: `确定删除该类型的全部 ${a.profiles.length} 个 Profile？已有任务会按类型内置默认降级。`, ok: '全部删除', danger: true }))) return;
        a.profiles = [];
        drop();
      };
      /* 模型目录（现在是组里常驻的一大块）收成卡底一行，点开再看；里面的项照现状 */
      const dir = hasCfg && h('div', { hidden: true },
        row(null, ['选 opus 等别名时由 CLI 决定具体版本；选完整 ID 时传入指定版本。', 'Anthropic 文档模型 ID + CLI 别名 · 26 个 · 10:53 更新（账号可用性以实际运行为准）']),
        row('自动获取间隔', null, text('Claude 模型目录自动获取间隔（小时）', '6', { inputmode: 'numeric', class: 'sv-set-num' }), h('span.sv-set-val', '小时'), stub('立即从官方获取')),
        row('自己添加完整 ID（每行一个，也可用逗号分隔）', null, area('自己添加完整 ID', '', 'claude-opus-4-6\nclaude-sonnet-4-6', 3, { class: 'mono' })),
        foot('官方目录仅提供候选；账号能否使用以实际请求为准。', stub('保存目录设置')));
      const fold = hasCfg && h('button.sv-set-fold', { type: 'button', 'aria-expanded': 'false', onclick: () => {
        const on = fold.getAttribute('aria-expanded') !== 'true';
        fold.setAttribute('aria-expanded', String(on));
        dir.hidden = !on;
      } }, h('span', 'Claude 官方账号 · 模型目录'), icon('chev', 'sm'));

      const cols = [['Profile / 位置'], ['供应商'], ['模型'], ['智能水平', 'level'], ['速度'], hasCfg && ['CLI 配置'], ['操作', 'end']].filter(Boolean);
      const el = h(`div.card.sv-set-agent${fresh ? '.enter' : ''}`, { role: 'table', 'aria-label': `${a.id} 执行器` },
        h('div.sv-set-ch', h('span.sv-set-ava', { 'aria-hidden': 'true' }, AVATAR[a.id] ?? a.id[0].toUpperCase()), h('b.mono', a.id), count, h('span.grow'), defName,
          btn('新增', addOne, '.quiet.sm', 'plus'),
          h('button.ico.sm', { type: 'button', 'aria-label': `删除全部 ${a.id} 执行器`, 'data-tip': `删除全部 ${a.id} 执行器`, onclick: removeAll }, icon('trash'))),
        h(`div.sv-set-tbl${hasCfg ? '.has-cfg' : ''}`,
          h('div.sv-set-th', { role: 'row' }, cols.map(([name, col]) => h(`span${col === 'end' ? '.sv-set-end' : ''}`, { role: 'columnheader', 'data-col': col }, name))),
          list),
        fold, dir);
      els.set(a, el);
      /* 卡片按 CLI 的固定次序排，后注册的也插回它该在的位置 */
      const next = S.agents.slice(S.agents.indexOf(a) + 1).map((x) => els.get(x)).find((x) => x?.isConnected && !x.classList.contains('is-leaving'));
      cards.insertBefore(el, next ?? null);
      rows();
    };
    const cell = (kid) => h('div', { role: 'cell' }, kid);

    /* 检测本机：列出装着的 CLI，没注册的给一颗「注册」（注册出来的 Profile 叫 <类型>@local） */
    function showFound(fresh) {
      const item = (a) => h('div.sv-set-cli', icon('check', 'sm'), h('div.grow', h('b', a.cli), h('small', a.ver)),
        a.profiles.length ? h('span.sv-set-def', icon('check', 'sm'), '已注册')
          : btn('注册', () => { a.profiles.push(profile(`${a.id}@local`, { def: true })); draw(a, true); showFound(); }, '.sm'));
      const el = h(`div.card${fresh ? '.enter' : ''}`, h('div.sv-set-ch', h('b', '本地已安装'), h('small', `${S.agents.length} 个 CLI`)), h('div.sv-set-clis', S.agents.map(item)));
      if (found) found.replaceWith(el); else cards.prepend(el);
      found = el;
    }
    const detText = h('span', '检测本地智能体');
    const det = h('button.btn', { type: 'button', onclick: () => {
      det.disabled = true;
      ASH.swap(detText, '检测中…');
      ctx.timers.push(setTimeout(() => { det.disabled = false; ASH.swap(detText, '检测本地智能体'); showFound(!found); }, 900));
    } }, icon('search'), detText);

    /* 说明只剩页尾这一句（原来卡脚上的那句，原话） */
    page.append(head('执行器', null, det), sec('执行器 Profile'), none, cards, h('p.sv-set-tail', '供应商决定账号与模型目录；任务仍可逐个覆盖执行器、模型和智能水平。'));
    for (const a of S.agents) if (a.profiles.length) draw(a);
    mark();
  };

  ASH.surface('settings', {
    chrome: 'full',
    mount(main, route) {
      const known = NAV.flatMap(([, items]) => items).find(([id]) => id === route.sub);
      const sub = known ? route.sub : 'agents';
      const ctx = { timers: [] };
      const page = h(`div.sv-set-page.enter${WIDE.includes(sub) ? '.is-wide' : ''}`);
      const nav = h('aside.sv-set-nav', { 'aria-label': '设置' },
        h('button.sv-set-back', { type: 'button', onclick: () => ASH.go('#/task') }, icon('setBack'), '返回应用'),
        h('nav', { 'aria-label': '设置导航' }, NAV.map(([label, items]) => h('div.sv-set-group', h('small.cut', label),
          items.map(([id, name, ico]) => h('button', { type: 'button', 'aria-current': id === sub ? 'page' : null, onclick: () => ASH.go(`#/settings/${id}`) }, icon(ico), name))))));
      main.append(h('div.sv-set', nav, h('div.sv-set-main', page)));
      /* 还没人登记的页只有标题 */
      const off = P[sub] ? P[sub](page, ctx) : void page.append(head(known[1]));
      if (sub === 'project') $('.card', page)?.setAttribute('data-m', 'a11y-5');   /* 字重那一条认领在行标题最多的这一页上 */
      return () => { ctx.timers.forEach(clearTimeout); off?.(); };
    },
  });

  /* 对照清单：条目不在眼前这一页就先切过去。要点开浮层的两条，先把那一处挪到主区正中再点——
     定位时页面会把它滚到正中，浮层是按点开那一刻的位置摆的，先滚后开才不会错位 */
  const claim = (id, sub, then) => {
    ASH.prep[id] = () => {
      const el = $(`[data-m~="${id}"]`);
      if (el) then?.(el); else ASH.go(`#/settings/${sub}?m=${id}`);
    };
  };
  const openAt = (el, key = el) => {
    if (key.getAttribute('aria-expanded') === 'true') return;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    key.click();
  };
  claim('set-1', 'agents');
  claim('set-3', 'agents');
  claim('set-keep', 'workflow');
  claim('a11y-5', 'project');
  claim('set-2', 'agents', (el) => openAt(el));                                                      /* 第一颗模型下拉：选中项打勾 */
  claim('set-4', 'agents', (el) => openAt(el, el.closest('.card').querySelector('[data-col="more"]')));   /* 第一行的「更多」：里面还是那三样 */
})();
