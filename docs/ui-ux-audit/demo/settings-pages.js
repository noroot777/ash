/* 设置里除执行器、起手式以外的各页（上半）：项目设置、分组、已归档、供应商。约定见 settings.js 头部。
   每页有哪几节、每一行叫什么、有哪些按钮和开关、默认值是什么，都照现在的产品（web/src/settings 下的同名组件）；
   不一样的只有全应用的尺子：标题下至多一句（清单 set-1）、下拉都是同一个 Select（set-2）、一套 17px 标题（set-3）、
   一页一层卡片没有彩条、字不小于 12px、多行输入框随内容长高、回不去的动作先问一句。
   内容是编的：路径、远端、供应商的名字和地址没有一个是真的。

   这九页共用的小件放在 ASH.setMore（下半那个文件也用），长相在 settings-pages.css：
     head(title, lead?, action?)   → 同 setKit.head，另把标题下那一句认领给 set-1
     form2(select)                 → 这一页第一颗表单档的 Select 认领 set-2
     rich(line) / hints(...lines)  → 说明文字：句子里的 `代码` 和 **加重** 变成 code / strong；hints 给设置行当说明用
     setHints(row, ...lines)       → 换掉一行设置的说明（说明跟着取值变的那几行）
     notes(...lines)               → 跟在控件后面的几句说明
     fill(el, ...kids)             → 换掉 el 里的全部内容；kids 里可以夹数组和 false / null（跟 h 的孩子一个规矩）
     check(label, on, onchange?, attrs?)   → 勾选框（button[role=checkbox]）；attrs.role = 'radio' 时是单选的圆点
     tag(text, tone?, icon?)       → 行里的状态小字；tone 是 '.ok' '.warn' '.bad'
     saveKey(label, onsave?)       → 主按钮：平时灰着，调它的 .touch() 才亮，点完又灰（管的不止输入框时用它）
     wait(ctx, label, busy, ms, done?, cls?, icon?)   → 点了要等一会儿的按钮，等的时候换成 busy 那几个字
     script(label, value?, placeholder?, rows?)       → 脚本框：一条「Shell · 自动换行」的抬头加一个等宽的多行输入框
     copyKey(value, label?)        → 复制的图标钮
     ibtn(icon, label, onclick, attrs?)    → 24px 的图标钮 */
(() => {
  const { h, $, $$, icon } = ASH;
  const K = ASH.setKit;
  const S = ASH.setData;
  const P = ASH.setPages;

  ASH.icons.pgPause ??= '<path d="M5.5 3.5v9M10.5 3.5v9"/>';
  ASH.icons.pgKey ??= '<circle cx="5" cy="11" r="2.5"/><path d="m7 9 6-6M10.5 5.5l2 2"/>';
  ASH.icons.pgCrown ??= '<path d="M2.5 5 5 8l3-4.5L11 8l2.5-3-1 7.5h-9z"/>';
  ASH.icons.pgFinger ??= '<path d="M4 6.5a4 4 0 0 1 8 0c0 2.5-.3 4.5-1 6M6 13c.6-1.6 1-3.6 1-6.5a1 1 0 0 1 2 0c0 2-.2 3.7-.6 5M4 9.5c0 1-.2 2-.6 3"/>';

  const rich = (line) => (typeof line === 'string' ? line.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map((t) => (t[0] === '`' ? h('code.sv-pg-code', t.slice(1, -1)) : t.startsWith('**') ? h('strong.sv-pg-b', t.slice(2, -2)) : t)) : line);
  const hints = (...lines) => lines.filter(Boolean).map(rich);
  const setHints = (row, ...lines) => {
    for (const el of $$(':scope > small', row.firstElementChild)) el.remove();
    row.firstElementChild.append(...hints(...lines).map((t) => h('small', t)));
  };
  const notes = (...lines) => h('div.sv-pg-notes', hints(...lines).map((t) => h('small', t)));
  const head = (title, lead, action) => { const el = K.head(title, lead, action); $('p', el)?.setAttribute('data-m', 'set-1'); return el; };
  const form2 = (sel) => { sel.setAttribute('data-m', 'set-2'); return sel; };
  const check = (label, on, onchange, attrs = {}) => {
    const el = h('button.sv-pg-check', { type: 'button', role: 'checkbox', 'aria-checked': String(!!on), ...attrs, onclick: () => {
      const next = attrs.role === 'radio' || el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', String(next));
      onchange?.(next);
    } }, h('i', icon('check')), label && h('span', label));
    return el;
  };
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((kid) => kid != null && kid !== false && kid !== ''));
  const tag = (text, tone = '', ico) => h(`span.sv-pg-tag${tone}`, ico && icon(ico, 'sm'), text);
  const ibtn = (ico, label, onclick, attrs = {}) => h('button.ico.sm', { type: 'button', 'aria-label': label, 'data-tip': label, onclick, ...attrs }, icon(ico));
  const saveKey = (label, onsave) => {
    const el = K.btn(label, () => { el.disabled = true; onsave?.(); }, '.pri');
    el.disabled = true;
    el.touch = () => { el.disabled = false; };
    return el;
  };
  const wait = (ctx, label, busy, ms, done, cls = '', ico) => {
    const word = h('span', label);
    const el = h(`button.btn${cls}`, { type: 'button', onclick: () => {
      el.disabled = true;
      ASH.swap(word, busy);
      ctx.timers.push(setTimeout(() => { el.disabled = false; ASH.swap(word, label); done?.(); }, ms));
    } }, ico && icon(ico), word);
    return el;
  };
  const copyKey = (value, label = '复制') => {
    const el = ibtn('copy', label, () => {
      try { navigator.clipboard?.writeText(value).catch(() => {}); } catch { /* 本地文件打开时可能没有剪贴板 */ }
      el.replaceChildren(icon('check'));
      setTimeout(() => el.replaceChildren(icon('copy')), 1200);
    });
    return el;
  };
  /* 「自动换行」是一份偏好：一页里所有脚本框一起变 */
  let wrapOn = false;
  const script = (label, value = '', placeholder = '', rows = 1) => {
    const field = K.area(label, value, placeholder, rows, { class: 'mono', wrap: wrapOn ? 'soft' : 'off' });
    return h('div.sv-pg-shell', h('div', icon('term', 'sm'), h('span.grow', 'Shell'), check('自动换行', wrapOn, (on) => {
      wrapOn = on;
      for (const el of $$('.sv-pg-shell textarea', field.closest('.sv-set-page'))) el.setAttribute('wrap', on ? 'soft' : 'off');
      for (const el of $$('.sv-pg-shell .sv-pg-check', field.closest('.sv-set-page'))) el.setAttribute('aria-checked', String(on));
    }, { 'aria-label': `${label} 自动换行` })), field);
  };
  ASH.setMore = { head, form2, rich, hints, setHints, notes, fill, check, tag, ibtn, saveKey, wait, script, copyKey };

  /* 一张要滚着看的说明：一张宽一点的对话框，层用全应用那一个（ASH.sheet）。Esc、点遮罩、「知道了」都能关，关掉后焦点回到触发处 */
  function sheet(anchor, title, lead, sections) {
    const ok = K.btn('知道了', () => close(), '.pri');
    const body = h('div.sv-pg-help', { tabindex: '0', role: 'region', 'aria-label': '配置说明内容' },
      sections.map(([name, ...lines]) => h('section', h('h3', name), lines.map((t) => (t.startsWith('$ ') ? h('pre', t.slice(2)) : h('p', rich(t)))))));
    const close = ASH.sheet(h('div.dlg.sv-pg-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', title), h('p', lead), body, h('div.dlg-acts', ok)),
      { onclose: () => anchor.setAttribute('aria-expanded', 'false') });
    anchor.setAttribute('aria-expanded', 'true');
    ok.focus();
  }

  /* ---------- 项目设置：照 ProjectSettingsPanel 和它带的几块（预览、常用命令、浏览器登录态、验收、Git） ---------- */
  const DIR = '/Users/me/code/harness';
  const HEALTHY = 'Git 仓库 · main · 工作区干净';
  const LAUNCH = [['command', '按项目启动命令'], ['frontend', '只启动前端'], ['full', '前后端全启动（独立新库）'], ['test', '前后端 + 测试库快照']];
  const PROXY = {
    off: ['当前使用直连：浏览器直接访问服务端口。远程访问时，服务需监听可访问的网卡地址，并开放相应端口。'],
    on: ['当前使用反代：浏览器复用 ash 入口，无需开放每个服务的端口。预览页面跑在独立沙箱里，与 ash 的登录态隔离，只有一个例外——被预览的仓库就是这台 ash 自己、而且启动命令自己声明了「我的 /api 打到这台 ash 上」（ash 自带的「只起前端」启动方式默认这么声明；多服务预览一律不算，脚本里用 ASH_PROXY 把前端指向自己的后端也会让它改口）时，/api 会由代理单独接回这台 ash 并替你带上当前这条会话，打开即登录态；否则你只会看到一个登录框，而在预览页里粘 key 比这危险得多（key 是长期凭证，会落到被预览的应用手上）。这条会话只出现在 /api 那一跳上，被预览的 dev server 一个字都收不到，页面本身也读不出来；代价是页面能借这条路以你的身份调 ash 的接口。你一登出它就失效，链接被别人拿去打开也不会继承。预览页面自己发出的请求所带的 Authorization（Bearer 等）会照常转发，从 ash 页面或命令行带进来的鉴权头不会（否则你的 ash key 会落到被预览的应用手上）；Basic/Digest 一律不转发，需要它们的应用请改用直连。localStorage、sessionStorage 和 document.cookie 由 ash 在页面内模拟——读写正常，但只活在当前这个页面：刷新或跳转即清空，页面写的 Cookie 也不会随请求发出，所以把登录态存在本地存储的应用每次刷新都要重新登录。IndexedDB、Service Worker 和站外接口在沙箱里用不了，依赖它们的应用请改用直连。',
      '服务需要配置资源前缀时，可读取 `$ASH_PREVIEW_BASE`。例如 Vite 可在启动参数中使用 `--base $ASH_PREVIEW_BASE`。'],
  };
  const GATE = {
    branch: ['分支快照', '门禁跑在任务分支自己的快照上；目标分支之后进来的改动不在被测范围内。'],
    contains_target: ['要求已含目标分支', '任务分支还没包含目标分支的最新提交时直接拒绝验收，先让任务把目标分支合进来；含了才在分支快照上跑门禁。'],
    merge_preview: ['合并预览', '先在测试快照里把最新的目标分支合进任务分支，再对这份合并结果跑门禁；预演有冲突就不跑，按冲突交回任务去解。'],
  };
  const HELP = [
    ['自动识别启动命令', '自定义脚本留空时，ash 会按各语言的惯例识别启动命令：Maven 的 `spring-boot:run`、Gradle 的 `bootRun`、Django 的 `runserver`、FastAPI 的 `uvicorn`、Flask、`go run`、`cargo run`、`dotnet run`、Laravel 的 `artisan`、Rails 的 `bin/rails`、Node 的 dev / start 脚本。',
      '**只有恰好识别出一个启动项时才会自动使用。**如果前后端并列，或 Maven 多个模块各有一个应用，可切到「选择服务」，点击「检测服务」后勾选需要启动的服务，也可以直接编辑脚本。'],
    ['AI 协助填写', '上面那套识别只读文件、按各语言惯例猜，认不出来的项目（自研脚手架、要先起依赖服务、端口写法特殊）可以点「AI 协助填写」：一个 CLI 智能体在项目目录里读文件判断启动方式，**再由 ash 借一个空闲端口把它给的脚本真跑一遍** —— 那个端口上真有服务响应才算数，随后进程会被停掉。',
      '起不来就把失败原因和日志甩回去重来，最多 3 轮；成功才把脚本填进输入框，**仍需你确认后点保存**。每一轮试过的脚本和日志都留在面板里，三轮都没成时它们也是你手写那条脚本的线索。智能体被要求不修改仓库里的任何文件、也不替你装依赖 —— 缺依赖会如实报出来。',
      '这台协助作业只活在 ash 的内存里：它跑着的时候 ash 重启，进度就没了，面板会说明「已随 ash 重启中断」，再点一次即可重来。'],
    ['命令在哪里执行', '命令在任务工作区（worktree）的根目录执行，使用服务端所在机器的 shell。支持 cd、`&&` 和后台任务；ash 会注入 `BROWSER=none`。'],
    ['预览端口与服务地址', 'ash 会为预览分配一组端口。`$PORT` 用于要在浏览器中查看的服务；辅助服务使用 `$PORT2`…`$PORT5`。', '辅助服务还提供对应的地址变量 `$URL2`…`$URL5`，例如 `$URL2` 就是 `http://localhost:$PORT2`。'],
    ['同时启动前后端', '使用「选择服务」时，可勾选多个服务并设置默认打开项。每条脚本使用自己的 `$PORT`；已选服务按列表顺序对应 `$URL1`、`$URL2` 等内部地址。', '自定义脚本中可将辅助服务放到后台，需要预览的服务放在最后。例如：',
      '$ (cd back && SERVER_PORT=$PORT2 mvn spring-boot:run &) ; cd front && VITE_APP_API_URL=$URL2 pnpm run dev -- --port $PORT', '前端连接后端的变量名取决于项目配置（Vite 项目通常使用 `VITE_*_URL`）。请按项目实际使用的名称填写，ash 只负责提供服务地址。'],
    ['把端口传给运行时', '不同运行时的端口配置方式不同。ash 会以常见的环境变量名称传入同一个端口：`PORT`（Node / Go / Rust）、`SERVER_PORT`（Spring Boot）、`ASPNETCORE_URLS`（ASP.NET Core）、`QUARKUS_HTTP_PORT`、`FLASK_RUN_PORT`。',
      'Vite、Angular、Django、Laravel、Rails 等需要通过命令行参数指定端口，请把 `$PORT` 写进命令。自动识别的命令已包含这些参数，手动填写时也需要保留。'],
    ['启动失败时排查', '打开任务底部的「预览日志」，可以查看实际执行的命令、注入的端口和命令输出。启动失败的日志也会保留。'],
  ];

  P.project = (page, ctx) => {
    /* 基本信息：名称和目录攒着一起存；目录一改就重新体检 */
    const name = K.text('项目名称', ASH.data.project);
    const dir = K.text('工作目录', DIR, { class: 'mono' });
    const health = h('div.sv-pg-health.is-ok', { role: 'status' }, h('i'), h('span', HEALTHY));
    let probing = 0;
    dir.addEventListener('input', () => {
      const path = dir.value.trim();
      const say = (cls, text) => { health.className = `sv-pg-health ${cls}`; health.lastChild.textContent = text; };
      clearTimeout(probing);
      if (!path) { say('', '填写目录后会检查是否存在、Git 状态和未提交修改'); return; }
      say('', '正在检查目录…');
      ctx.timers.push(probing = setTimeout(() => (path === DIR ? say('is-ok', HEALTHY) : say('is-bad', '目录不存在；Ash 不会自动创建它')), 500));
    });

    /* 预览：启动方式二选一，中间那一段跟着换；启动范围、反向代理、说明、保存两种方式共用 */
    const pvSave = saveKey('保存预览设置');
    const touch = pvSave.touch;
    const start = script('启动脚本', 'npm run dev -- --port $PORT', '例如：\ncd web\nnpm run dev -- --port $PORT', 9);
    const startField = $('textarea', start);
    /* AI 协助填写：让一个 CLI 判断怎么启动，ash 真跑一遍；成了就把脚本填进上面的框 */
    const aiWord = h('span', 'AI 协助填写');
    const aiSay = h('p.sv-pg-said', { role: 'status', hidden: true });
    let aiTimers = [];
    const aiEnd = (said) => {
      aiTimers.forEach(clearTimeout);
      ai.disabled = false;
      aiStop.hidden = true;
      ASH.swap(aiWord, 'AI 协助填写');
      aiSay.hidden = !said;
      aiSay.replaceChildren(said ?? '');
    };
    const aiStop = K.btn('停止', () => aiEnd(), '', 'stop');
    aiStop.hidden = true;
    const ai = h('button.btn.pri', { type: 'button', onclick: () => {
      const step = h('span.shim', 'AI 正在项目目录里读文件，判断怎么启动');
      ai.disabled = true;
      aiStop.hidden = false;
      ASH.swap(aiWord, 'AI 正在判断…');
      aiSay.hidden = false;
      aiSay.replaceChildren(step, h('b.num', '1/3'));
      aiTimers = [setTimeout(() => ASH.swap(step, '借了一个空闲端口，正在把它给的脚本真跑一遍'), 1300), setTimeout(() => {
        startField.value = 'cd web\nnpm run dev -- --port $PORT';
        startField.dispatchEvent(new Event('input', { bubbles: true }));
        aiEnd('脚本已填进上面的输入框；确认无误后点「保存预览设置」，任务里的「打开预览」就按它启动。');
      }, 2900)];
      ctx.timers.push(...aiTimers);
    } }, icon('bot'), aiWord);
    const byScript = [
      K.row('启动脚本', null, start),
      h('div.sv-set-line.sv-pg-bar', ai, aiStop, ASH.target({ follow: '默认执行器', label: '让谁来判断' }).el),
      notes('AI 在**项目目录**里读文件判断启动方式，ash 再借一个空闲端口把它给的脚本**真跑一遍**——端口上真有响应才算数，随后进程会被停掉，起不来就甩回去重来（最多 3 轮）。它被要求不改仓库里的任何文件、不替你装依赖。'),
      aiSay,
      notes('支持多行、缩进和完整脚本，也可以调用仓库里的脚本文件。留空延续原来的行为：只在恰好识别出一个服务时自动使用。',
        '脚本在任务工作区根目录执行。ash 每次开预览都借一个空闲端口，用 `$PORT` 传给你的命令。服务自己读 PORT 环境变量（Next、Nest、Express、Spring Boot、Go…）：不用写，npm run dev 就行；服务只认命令行参数（Vite、Angular、Astro、Django、Rails、Laravel…）：必须把 `$PORT` 写进命令，否则它照配置里写死的端口起 —— 同一个项目已经有一份在跑时必然撞车。',
        '脚本内的其它服务可使用 `$PORT2`～`$PORT5` 和对应的 `$URL2`～`$URL5`。'),
    ];
    /* 选择服务：检测出候选再勾，或者手动添加；勾上的里面有一个是「默认打开」 */
    const svcs = [];
    let front = null;
    let said = '';
    const byList = h('div');
    const drawSvcs = (focus) => {
      const on = svcs.filter((s) => s.on);
      if (!on.includes(front)) front = on.find((s) => s.kind === 'web') ?? on[0] ?? null;
      fill(byList,
        h('div.sv-set-line.sv-pg-bar', wait(ctx, '检测服务', '检测中…', 700, () => {
          for (const s of [{ name: 'web · dev', cmd: 'npm -w web run dev -- --port $PORT', kind: 'web' }, { name: 'server · dev', cmd: 'npm -w server run dev', kind: 'service' }]) if (!svcs.some((x) => x.cmd === s.cmd)) svcs.push({ ...s, on: false });
          said = '检测到 2 个候选。请勾选需要启动的服务；已有编辑和选择会保留。';
          drawSvcs();
        }, '', 'search'), K.btn('手动添加', () => { svcs.push({ name: '新服务', cmd: '', on: false, kind: 'web' }); drawSvcs(); touch(); }, '', 'plus'),
        h('span.sv-set-val', `已选 ${on.length} 个 · 最多同时启动 8 个`)),
        notes('检测读取已保存的项目目录中的常见启动配置，不运行命令。总启动脚本和子服务可能同时出现，请避免重复勾选。'),
        said && h('p.sv-pg-said', { role: 'status' }, said),
        !svcs.length && h('p.sv-pg-empty', '点击「检测服务」列出候选，也可以手动添加。'),
        svcs.map((s, i) => {
          const cmd = script(`${s.name} 启动脚本`, s.cmd, '启动命令，例如 npm run dev -- --port $PORT', 2);
          cmd.addEventListener('input', (e) => { s.cmd = e.target.value; });
          return h('div.sv-pg-svc', { role: 'group', 'aria-label': `预览服务 ${s.name}`, 'data-svc': i },
            h('div.sv-set-line', check(null, s.on, (v) => { s.on = v; drawSvcs(`[data-svc="${i}"] [role="checkbox"]`); touch(); }, { 'aria-label': `启动 ${s.name}`, disabled: !s.on && on.length >= 8 }),
              K.text(`服务名称 ${s.name}`, s.name, { class: 'grow', maxlength: '160', oninput: (e) => { s.name = e.target.value; } }),
              h('span.sv-set-val', '用途'), K.pick(`${s.name} 用途`, [['web', '网页'], ['service', '接口服务']], s.kind, (v) => { s.kind = v; touch(); }),
              check('默认打开', front === s, () => { front = s; drawSvcs(`[data-svc="${i}"] [role="radio"]`); touch(); }, { role: 'radio', disabled: !s.on }),
              ibtn('trash', `移除 ${s.name}`, () => { svcs.splice(i, 1); drawSvcs(); touch(); })),
            cmd);
        }),
        notes('每条脚本都从任务工作区根目录独立执行，使用自己的 `$PORT`。已选服务按列表顺序对应 `$URL1`、`$URL2`…，可传给前端开发服务器的接口代理配置。它们是服务端内部地址。'));
      if (focus) $(focus, byList)?.focus();
    };
    drawSvcs();
    const mid = h('div.sv-pg-mid', byScript);
    const proxyRow = K.row('通过 ash 反向代理访问', hints(...PROXY.off), K.pick('通过 ash 反向代理访问', [['auto', '跟随模式默认（单人模式：关闭）'], ['on', '开启'], ['off', '关闭']], 'auto', (v) => { setHints(proxyRow, ...PROXY[v === 'on' ? 'on' : 'off']); touch(); }));
    const helpKey = h('button.btn', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => sheet(helpKey, '预览命令说明', '了解自动识别、端口配置和多服务启动方式。', HELP) }, icon('help'), '配置说明与示例');
    const preview = K.card(
      K.row('启动方式', '在这里配置一次，任务里的「打开预览」按保存的方案启动。', K.seg('预览启动方式', [['script', '自定义脚本'], ['services', '选择服务']], 'script', (v) => { mid.replaceChildren(...(v === 'script' ? byScript : [byList])); touch(); })),
      mid,
      K.row('启动范围', hints('ash 把这个选择作为 `$ASH_PREVIEW_MODE` 递给上面的启动脚本，**起不起后端是脚本自己的事** —— 脚本不读这个变量时，四档没有区别（大多数项目都是这样，选哪个都行）。',
        '选「只启动前端」时，脚本通常会把 `/api` 打回正在跑的这台 ash：**你在预览里验的是主实例的后端，不是这个分支的**。要验后端改动，请选前后端全启动的那两档，或在脚本里自己起后端。'), K.pick('预览启动范围', LAUNCH, 'frontend', touch)),
      proxyRow,
      K.row(null, '查看自动识别、脚本示例和多服务配置说明。', helpKey),
      K.foot('保存后对下次打开的预览生效。运行状态和输出可在任务的预览日志里查看。', pvSave));
    preview.addEventListener('input', touch);

    /* 常用命令：一组启动 / 停止 / 重启，加一张自己添的命令表。脚本里写 {{名字}} 的，执行前会先问 */
    const asks = (box, action) => {
      const said = h('p.sv-pg-asks', { hidden: true });
      box.addEventListener('input', (e) => {
        const found = [...e.target.value.matchAll(/\{\{([^{}=]+)(?:=([^{}]*))?\}\}/g)];
        said.hidden = !found.length;
        said.replaceChildren(`点${action}时先问你：`, ...found.map(([, key, preset]) => h('code.sv-pg-code', key.trim(), preset != null && h('em', `默认 ${preset || '（空）'}`))));
      });
      return [box, said];
    };
    const cmds = [];
    const cmdBox = h('div');
    const cmdCount = h('span');
    const cmdSave = saveKey('保存');
    const cmdAdd = K.btn('添加命令', () => { cmds.push({ name: '', cmd: '' }); drawCmds(); $('.sv-pg-cmd:last-child input', cmdBox).focus(); cmdSave.touch(); }, '', 'plus');
    const drawCmds = () => {
      cmdBox.replaceChildren(...(cmds.length ? cmds.map((c, i) => h('div.sv-pg-cmd',
        K.text('命令名称', c.name, { placeholder: '名称（如 web dev）', oninput: (e) => { c.name = e.target.value; } }),
        h('div.grow', asks(script(`${c.name || '常用命令'}的命令`, c.cmd, '如 npm run test -- {{用例}}'), '执行')),
        ibtn('trash', `删除 ${c.name || '这条命令'}`, () => { cmds.splice(i, 1); drawCmds(); cmdSave.touch(); }))) : [h('p.sv-pg-empty', '还没有常用命令。')]));
      cmdCount.textContent = `${cmds.length} / 12 条`;
      cmdAdd.disabled = cmds.length >= 12;
    };
    cmdBox.addEventListener('input', (e) => { const c = cmds[[...cmdBox.children].indexOf(e.target.closest('.sv-pg-cmd'))]; if (c && e.target.matches('textarea')) c.cmd = e.target.value; });
    drawCmds();
    const commands = K.card(
      K.row(null, hints('命令都在项目目录（主仓当前检出的分支）执行，端口按项目自己的配置来 —— 要「借端口在任务分支上看效果」用预览，不用这里。',
        '脚本由你的登录 shell 执行（`shell -lc`），所以 PATH、nvm、别名这些跟你平时开终端一致。',
        '支持多行脚本。要执行时临时填参数就写占位符 `{{分支}}`，点执行前会弹框让你填；`{{分支=main}}` 带默认值（可留空不填），没写 `=` 的就是必填。取值原样替换进脚本，要当成一个整体参数请自己加引号：`git commit -m "{{说明}}"`。')),
      K.row('启动 / 停止 / 重启', hints('项目的 dev server：配置后，「常用命令」弹层顶部的按钮即可一键启停（G C 快速打开）；服务起着的时候，启动按钮就地变成停止。',
        '停止默认是杀掉启动命令起来的进程：先杀整个进程组，进程组空了就回到启动时打印过的本机端口（`http://127.0.0.1:8787` 这种）上找人——守护化的服务脚本跑完就退，只有端口还指得到它。两条都够不着时（`docker compose up -d` 这类服务连端口都未必在本机）才需要填一条停止命令。')),
      K.row('启动命令', null, asks(script('启动命令', 'npm -w web run dev', '如 npm -w web run dev'), '启动')),
      K.row('停止命令', null, script('停止命令', '', '留空 = 杀掉启动起来的进程（进程组 + 它打印的端口）')),
      K.row('重启命令', null, asks(script('重启命令', '', '留空 = 杀掉进程再跑一遍启动命令'), '重启')),
      K.row('命令列表', 'watch、tunnel、构建脚本这些常驻/常用的，在弹层里逐条启停；重启 = 杀掉进程再跑一遍。'),
      cmdBox,
      K.foot(cmdCount, cmdAdd, cmdSave));
    commands.addEventListener('input', cmdSave.touch);

    /* 浏览器登录态：一行一个域名，存的是归一之后的裸主机名；填的和存的不一样时当场说出来 */
    let allowed = [];
    const hostOf = (t) => { const x = t.replace(/^[a-z]+:\/\//i, '').split(/[/:?#]/)[0].toLowerCase(); return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x) && !/^[\d.]+$/.test(x) ? x : ''; };
    const sites = K.area('允许只读的站点', '', 'x.com\nweibo.com', 4, { class: 'mono' });
    const siteSay = h('span');
    const siteSave = K.btn('收回授权', () => { allowed = siteParsed(); sites.value = allowed.join('\n'); siteSync(); });
    const siteDrop = K.btn('放弃修改', () => { sites.value = allowed.join('\n'); siteSync(); sites.focus(); }, '.quiet');
    const siteParsed = () => [...new Set(sites.value.split(/[\s,，、]+/).filter(Boolean).map(hostOf).filter(Boolean))].slice(0, 20);
    const siteSync = () => {
      const tokens = sites.value.split(/[\s,，、]+/).filter(Boolean);
      const parsed = siteParsed();
      const bad = tokens.filter((t) => !hostOf(t)).length;
      const dirty = parsed.join('\n') !== allowed.join('\n');
      siteSave.firstChild.textContent = parsed.length ? '保存授权' : '收回授权';
      siteSave.disabled = !dirty;
      siteDrop.hidden = !dirty;
      siteSay.textContent = [dirty && parsed.length && `将保存为：${parsed.join('、')}`, bad && `有 ${bad} 条认不出域名形状，保存时会丢掉（单段主机名如 localhost、纯 IP 不收）。`,
        tokens.length - bad - parsed.length > 0 && `有 ${tokens.length - bad - parsed.length} 条重复或超出 20 条上限，保存时会合并。`, !dirty && allowed.length && `当前已授权：${allowed.join('、')}`].filter(Boolean).join(' ');
    };
    sites.addEventListener('input', siteSync);
    siteSync();

    /* 验收：两颗开关拨了就存；前置命令要敲一长串，攒着按钮存；门禁基准三选一 */
    const commitRow = K.row('验收合并后提交代码', null, K.sw(true, ['提交', '不提交'], (on) => commitSay(on)));
    const commitSay = (on) => setHints(commitRow, on ? '开着 = 老规矩：验收通过时把任务分支合进目标分支并落成提交。' : '关着 = 验收只把改动合进目标分支的工作区并暂存，不产生提交；目标分支的提交历史一动不动，提交或丢弃由你自己决定。',
      !on && '这一档要求目标分支此刻正检出在项目目录、且工作区干净（上次没提交的合并也算脏），任务分支一律保留，统一验收一次只合得了一个任务。', '每次验收都能在确认框里单独改这一次，不改这里的默认。');
    commitSay(true);
    const gate = K.text('验收前置命令', '', { class: 'mono', placeholder: '例如 ./scripts/test.sh full（留空 = 不设）' });
    const gateRow = K.row('门禁基准', null, K.seg('门禁基准', Object.entries(GATE).map(([id, [label]]) => [id, label]), 'branch', (v) => gateSay(v)));
    const gateSay = (v) => setHints(gateRow, GATE[v][1], '只对开了独立 worktree 的任务起作用；没设前置命令时三档都一样。');
    gateSay('branch');

    /* Git：身份写进仓库自己的配置，凭证只进 ash 的库、只写不读 */
    const who = K.text('提交用户名', '', { placeholder: '示例开发者' });
    const mail = K.text('提交邮箱', '', { placeholder: 'dev@example.com' });
    const sshKey = K.text('SSH 私钥', '', { class: 'mono', placeholder: '留空则用默认的 ssh 身份，例如 ~/.ssh/id_ed25519' });
    const credUser = K.text('用户名', '', { autocomplete: 'off' });
    const credPass = K.text('令牌 / 密码', '', { type: 'password', autocomplete: 'new-password', placeholder: 'GitHub / GitLab 的 access token' });
    const credRow = K.row('HTTPS 用户名与令牌', '未配置。这个项目走 HTTPS 拉取/推送时会用系统里的凭证');
    const credSave = K.saver('保存凭证', credUser, credPass);
    const credSet = (user) => {
      setHints(credRow, user ? `已配置：${user}（${new Date().toLocaleString('zh-CN')}）` : '未配置。这个项目走 HTTPS 拉取/推送时会用系统里的凭证');
      credPass.value = '';
      credPass.placeholder = user ? '留空则沿用已存的令牌' : 'GitHub / GitLab 的 access token';
      credUser.value = user;
      credClear.hidden = !user;
    };
    const credClear = K.btn('清除凭证', async () => {
      if (await ASH.confirm({ title: '清除 Git 凭证', body: '清除后这个项目的 HTTPS 拉取和推送会回到系统默认凭证。令牌无法恢复，需要重新填写。', ok: '清除凭证', danger: true })) credSet('');
    }, '.danger');
    credClear.hidden = true;
    credSave.addEventListener('click', () => credSet(credUser.value.trim()));
    for (const el of [credUser, credPass]) el.addEventListener('input', () => { credSave.disabled = !credUser.value.trim(); });

    page.append(head('项目设置', '项目目录是所有任务的默认运行位置，也是 worktree 与 diff 的根。'),
      K.sec('基本信息'), K.card(K.row('项目名称', null, name), K.row('工作目录', null, dir, K.stub('浏览…')), health, K.foot('修改目录不会移动磁盘文件，只会改变后续任务的 cwd。', K.saver('保存更改', name, dir))),
      K.sec('默认起手式'), K.card(K.row('这个项目的新任务默认走哪条线', '没设就跟着系统默认走；每张新任务仍可单独换，换了也只影响那一张', form2(K.flowPick('这个项目的默认起手式', '跟着系统默认走', 'frontend')))),
      K.sec('工作目录'), K.card(K.row('这个项目的新任务默认开独立 worktree', hints('开：每张任务拉一个 ash/<id8> 分支、跑在 .worktrees/<id>/ 里，互不打扰；关：所有任务直接在项目目录里跑。每张新任务仍可单独覆盖。', '按项目分开设，不跟随任何全局默认。'), K.sw(true, ['已开启', '已关闭']))),
      K.sec('预览'), preview,
      K.sec('常用命令'), commands,
      K.sec('浏览器登录态'), K.card(K.row('允许用我登录的 Chrome 只读这些站点', hints('一行一个域名（`x.com`），自动包含子域。留空 = 不授权，这是默认。最多 20 个。',
        '设了之后，本项目的任务遇到「必须登录才看得到」的内容时可以直接用你的登录态，不必每次在任务里点名 —— 定时抓取这类无人值守的活靠的就是它。',
        '**范围默认只读**：名单内也只允许新建后台标签读数据，禁止接管或导航你正在用的标签、禁止激活窗口，禁止一切写操作（发布、点赞、关注、改设置、发消息）。名单外的站点仍会停下来问你。',
        '这组限制是默认态而不是硬禁令：要让任务写（发帖、点赞、改设置）或接管你的标签，在任务里明确说出来就行 —— 放开的只有你点名的那一项，没点名的照旧禁止。'), sites), K.foot(siteSay, siteDrop, siteSave)),
      K.sec('验收'), K.card(
        K.row('验收前自动提交任务改动', '默认关闭。开启后，点击验收会先提交独立任务工作区内尚未提交的改动，再运行验收前置命令和合并；不会推送远端。共用项目目录的任务会跳过自动提交，需在源代码管理中按文件选择；存在冲突或仍有任务运行时不会提交。', K.sw(false, ['已开启', '已关闭'])),
        commitRow,
        K.row('验收前置命令', hints('点「验收通过」之后，先在**这个任务自己的工作区**里跑一遍它，rc=0 才会继续合并：绿了这次验收自动做完，不用再点；红了不合并、不清理，日志会交回那个任务去修。命令可能要跑十几分钟，跑的过程中目标分支一个字节都不会动，验收台上能看状态、看日志、也能收掉它。'), gate),
        K.foot('改了只影响之后的验收；已经跑过的记录不受影响。', K.saver('保存命令', gate)),
        gateRow),
      K.sec('Git 身份'), K.card(
        K.row('远端', 'URL 里内嵌的密码已隐去', h('span.sv-pg-remote', h('strong', 'origin'), h('code', 'git@github.com:example/harness.git'), h('em', 'SSH'))),
        K.row('提交用户名', '继承自全局：示例开发者', who), K.row('提交邮箱', '继承自全局：dev@example.com', mail), K.row('SSH 私钥', '推送 SSH 远端时只用这把 key', sshKey),
        K.foot('这三项写进仓库的 .git/config，agent 和你自己的终端看到的是同一份；所有任务 worktree 都跟着生效。清空输入框 = 回去跟着全局走。', K.saver('保存身份', who, mail, sshKey))),
      K.sec('Git 凭证'), K.card(credRow, K.row('用户名', null, credUser), K.row('令牌 / 密码', '存进去就取不回来，只能换一个', credPass),
        K.foot('当前远端都是 SSH，配了也不会被用到——SSH 走上面那把私钥。', credClear, credSave)),
      K.sec('危险操作'), K.card(K.row('删除项目', '删除项目记录，以及它下面的任务、分组和运行记录；不会删除仓库目录。',
        K.btn('删除项目', () => ASH.confirm({ title: '删除项目', body: `确定删除“${name.value.trim() || ASH.data.project}”？项目下的任务、分组和运行记录会一并删除，仓库目录不会被删除。`, ok: '删除项目', danger: true }), '.danger'))));
  };

  /* ---------- 分组：一组一行，名字就地改、运行方式下拉即存；最后一行新建。暂停着的组多一行「续跑队列」 ---------- */
  const MODES = [['parallel', '并行'], ['serial', '串行']];
  const MARK = { done: ['✓', '已完成'], hold: ['○', '暂停着'], todo: ['○', '还没跑'] };
  const turn = (g, from, to) => { g.tasks = g.tasks.map(([title, st]) => [title, st === from ? to : st]); };
  const GROUPS = [
    { name: '发版前检查', mode: 'serial', paused: true, tasks: [['跑一遍全量回归', 'done'], ['更新变更日志', 'hold'], ['打版本标签', 'todo'], ['发布', 'todo']] },
    { name: '文档整理', mode: 'parallel', paused: false, tasks: [['README 重排', 'run'], ['接口说明补例子', 'run'], ['旧截图换新', 'done']] },
  ];
  P.groups = (page) => {
    const list = h('div', { role: 'list' });
    const draw = (fresh, focus) => {
      list.replaceChildren(...(GROUPS.length ? GROUPS.map((g, i) => {
        const name = K.text('分组名称', g.name);
        name.addEventListener('blur', () => { const next = name.value.trim(); if (next) g.name = next; else name.value = g.name; });
        const held = g.tasks.some(([, st]) => st === 'hold');
        return h(`div.sv-pg-group${g === fresh ? '.enter' : ''}`, { role: 'listitem', 'data-group': i },
          h('div.sv-set-tr', h('div', name), h('div', K.pickSm(`${g.name} 的运行方式`, MODES, g.mode, (v) => { g.mode = v; })),
            h('div', h('span.sv-pg-cell', `${g.tasks.length} 个任务`)), h('div', g.paused && tag('已暂停', '.warn')),
            h('div.sv-set-end', K.btn(g.paused ? '继续' : '运行', () => { g.paused = false; turn(g, 'hold', 'run'); draw(null, `[data-group="${i}"] .pri`); }, '.pri.sm', 'play'),
              !g.paused && K.btn('暂停', () => { g.paused = true; turn(g, 'run', 'hold'); draw(null, `[data-group="${i}"] .pri`); }, '.sm', 'pgPause'),
              ibtn('trash', `删除 ${g.name}`, async () => {
                if (!(await ASH.confirm({ title: '删除分组', body: `确定删除“${g.name}”？组内 ${g.tasks.length} 个任务会保留并取消分组。`, ok: '删除', danger: true }))) return;
                GROUPS.splice(GROUPS.indexOf(g), 1);
                draw();
              }))),
          g.paused && held && h('div.sv-pg-queue', h('span', '续跑队列'), h('span.grow', g.tasks.map(([title, st]) => h(`i.is-${st}`, { 'data-tip': `${title} · ${MARK[st][1]}` }, MARK[st][0]))),
            h('span.num', `${g.tasks.filter(([, st]) => st === 'done').length}/${g.tasks.length}`)));
      }) : [h('p.sv-pg-empty', '还没有分组。团队内部自动创建的分组不会出现在这里。')]));
      if (focus) $(focus, list)?.focus();
    };
    let mode = 'parallel';
    const fresh = K.text('新分组名称', '', { placeholder: '新分组名称…' });
    const create = () => {
      if (!fresh.value.trim()) return;
      const g = { name: fresh.value.trim(), mode, paused: false, tasks: [] };
      GROUPS.push(g);
      fresh.value = '';
      add.disabled = true;
      draw(g);
    };
    const add = K.btn('新建', create, '.pri.sm', 'plus');
    add.disabled = true;
    fresh.addEventListener('input', () => { add.disabled = !fresh.value.trim(); });
    fresh.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    draw();
    page.append(head('分组', '把同类任务装进并行或串行容器，并在这里运行或暂停整组。'), K.sec('项目分组'),
      h('div.card.sv-pg-groups', h('div.sv-set-tbl', list, h('div.sv-set-tr.sv-pg-new', h('div', fresh), h('div', K.pickSm('新分组的运行方式', MODES, mode, (v) => { mode = v; })), h('div'), h('div'), h('div.sv-set-end', add)))),
      h('p.sv-set-tail', '运行分组会按服务端现有调度语义处理队列、暂停点和失败重试。'));
  };

  /* ---------- 已归档：归档时怎么收拾磁盘（整台机器一份），下面是这个项目归档了的任务，可以取回 ---------- */
  const CLEAN = {
    all: ['删 worktree 和任务分支', '删工作目录和任务分支，分支末端留作恢复点，取回后从它重建；有未提交改动的工作目录不删'],
    worktree: ['只删 worktree', '只删工作目录，分支一律保留（取回后重新运行会按分支重建工作区）'],
    none: ['都留着', '归档只是从列表里收起来，磁盘上原样不动'],
  };
  const SHELF = { clean: 'all', tasks: [
    { id: 'Kq3vT8mZr1Nc', title: '首页空状态换一句文案', kind: '任务', at: '2026/11/6 17:42:08' },
    { id: 'b7WdX2pLs9Ye', title: '比较三种拖拽排序的做法', kind: '讨论', at: '2026/11/3 10:15:31' },
    { id: 'Hn5cJ4uQa0Vf', title: '把设置页拆成按需加载', kind: '团队', at: '2026/10/29 21:07:55' },
  ] };
  P.archive = (page) => {
    const title = K.sec('');
    const list = h('div.card');
    const cleanRow = K.row('归档一并清理 worktree 和分支', CLEAN[SHELF.clean][1], form2(K.pick('归档清理方式', Object.entries(CLEAN).map(([id, [label]]) => [id, label]), SHELF.clean, (v) => { SHELF.clean = v; setHints(cleanRow, CLEAN[v][1]); })));
    const count = () => {
      title.textContent = `${SHELF.tasks.length} 个归档任务`;
      if (!SHELF.tasks.length) list.replaceChildren(h('p.none', '这里还没有归档任务。'));
    };
    list.append(...SHELF.tasks.map((t) => {
      const el = h('div.sv-pg-arch', icon('box'), h('div.grow', h('strong.cut', t.title), h('small', `${t.kind} · ${t.at} · `, h('code', t.id), copyKey(t.id, '复制任务 id'))),
        K.btn('取回', () => { SHELF.tasks.splice(SHELF.tasks.indexOf(t), 1); K.leave(el); setTimeout(count, 140); }, '', 'undo'));
      return el;
    }));
    count();
    page.append(head('已归档', '归档会结束任务在主工作区的生命周期；历史内容仍可查看并取回。'), K.sec('归档时怎么处理工作区'), K.card(cleanRow), title, list);
  };

  /* ---------- 供应商：一家一行，点「编辑」原地展开表单；「添加供应商」是这一页的页级动作，表单接在最后 ---------- */
  const PROTO = { anthropic: ['Anthropic 兼容', 'A', 'claude'], openai: ['OpenAI 兼容', 'O', 'codex · qwen'] };
  const modelsOf = (proto) => ASH.AGENTS[proto === 'anthropic' ? 'claude' : 'codex'].models;
  const whole = (p) => Object.assign(p, { key: p.key ?? true, conv: p.conv ?? false, from: p.from ?? 'api', pins: p.pins ?? [], big: p.big ?? [] });
  P.providers = (page, ctx) => {
    const list = h('div');
    const none = h('p.sv-pg-empty', '还没有供应商；现有 Profile 继续使用各 CLI 的官方登录账号。');
    const mountedBy = (p) => S.agents.flatMap((a) => a.profiles.filter((x) => x.prov === p.id));
    const count = () => { none.hidden = S.providers.length > 0 || !!adding; };

    /* 表单：新建和编辑是同一张。协议没选之前，模型那几块不出现 */
    const form = (p, shut) => {
      const d = p ? { ...p, pins: [...p.pins], big: [...p.big] } : whole({ name: '', proto: '', url: '', model: '', key: false });
      const name = K.text('名称', d.name, { placeholder: '例如 公司自建' });
      const url = K.text('Base URL', d.url, { class: 'mono', placeholder: 'https://provider.example.com（根地址，不含 /v1）' });
      const secret = K.text('API Key', '', { class: 'mono', type: 'password', autocomplete: 'new-password', placeholder: p?.key ? '留空保持现有 Key' : 'API Key' });
      const rest = h('div.sv-pg-mid');
      let probed = false;
      const ok = K.btn(p ? '保存供应商' : '添加供应商', () => {
        const next = { ...d, name: name.value.trim(), url: url.value.trim(), key: d.key || !!secret.value.trim() };
        if (p) Object.assign(p, next); else S.providers.push({ id: `p${Date.now()}`, ...next });
        shut(p ?? S.providers.at(-1));
      }, '.pri');
      const gate = () => { ok.disabled = !(d.proto && name.value.trim() && url.value.trim()); };
      const proto = h('div.sv-pg-choice', { role: 'radiogroup', 'aria-label': '协议' }, Object.entries(PROTO).map(([id, [label, , who]]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(d.proto === id), onclick: () => {
        if (d.proto !== id) Object.assign(d, { proto: id, model: '', big: [], conv: id === 'openai' && d.conv });
        for (const b of proto.children) b.setAttribute('aria-checked', String(b.textContent.startsWith(label)));
        more();
        gate();
      } }, h('strong', label), h('small', who))));
      const probe = (then) => wait(ctx, '探测模型', '探测中…', 800, () => { probed = true; then(); }, '', 'redo');
      function more() {
        const all = modelsOf(d.proto);
        const said = h('small');
        const modelRow = K.row('默认模型', said, K.pick('默认模型', [['', '不设置默认模型'], ...all.map((m) => [m, m])], d.model, (v) => { d.model = v; said.textContent = ''; drawBig(); }),
          probe(() => { said.textContent = `已返回 ${all.length} 个完整模型名`; drawPins(); drawBig(); }),
          wait(ctx, '测试模型', '测试中…', 900, () => { said.textContent = !url.value.trim() ? '先填写 Base URL' : !d.model ? '先填写要测试的模型' : `${url.value.trim().replace(/\/+$/, '')}${d.proto === 'anthropic' ? '/v1/messages' : '/v1/responses'} · 842 ms · 收到`; }, '', 'play'));
        /* 选择器里列什么：现调接口，或者只列钉下的那几个。切来切去不动已经钉的 */
        const pins = h('div.sv-pg-pins', { hidden: d.from !== 'pinned' });
        const fromRow = K.row('选择器里的模型列表', null, K.seg('模型列表来源', [['api', '每次调用 API'], ['pinned', '固定模型']], d.from, (v) => { d.from = v; pins.hidden = v !== 'pinned'; fromSay(); }));
        const fromSay = () => setHints(fromRow, d.from === 'api' ? '对话框每次弹出这家供应商时都现调 /models，列出最新的完整目录。' : '对话框只列下面固定的模型，不再调 /models —— 供应商没有目录接口或响应太慢时用它。');
        fromSay();
        function drawPins() {
          const left = all.filter((m) => !d.pins.includes(m));
          fill(pins,
            h('div.sv-set-line', K.pick('添加固定模型', [['', '添加模型'], ...left.map((m) => [m, m])], '', (v) => { if (v) d.pins.push(v); drawPins(); drawBig(); }), probe(() => { drawPins(); drawBig(); })),
            probed && h('small', `可从探测到的 ${all.length} 个模型里挑`),
            d.pins.length ? h('ul', d.pins.map((m) => {
              const out = h('small.grow.cut');
              return h('li', h('code', m), out, wait(ctx, '测试', '测试中', 800, () => { out.textContent = '612 ms · 收到'; }, '.quiet.sm', 'play'), ibtn('x', `移除模型 ${m}`, () => { d.pins.splice(d.pins.indexOf(m), 1); drawPins(); drawBig(); }));
            })) : h('small', '还没固定模型。选择器会退回这家供应商的默认模型，建议至少钉一个。'));
        }
        /* 1M 上下文：只有 Anthropic 这边有。勾上的模型经本地转发 */
        const bigSum = h('em');
        const bigList = h('div.sv-pg-big', { hidden: true });
        const bigFold = h('button.sv-set-fold.sv-pg-fold', { type: 'button', 'aria-expanded': 'false', onclick: () => {
          const on = bigFold.getAttribute('aria-expanded') !== 'true';
          bigFold.setAttribute('aria-expanded', String(on));
          bigList.hidden = !on;
        } }, h('span', h('strong', '1M 上下文模型'), h('small', '只有勾选的模型经过本地转发；其他模型保持直接连接。')), bigSum, icon('chev', 'sm'));
        let filter = '';
        function drawBig(focus) {
          const known = [...new Set([d.model, ...d.pins, ...(probed ? all : []), ...d.big].filter(Boolean))];
          const shown = known.filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase()));
          bigSum.textContent = d.big.length ? `已启用 ${d.big.length} 个` : '未启用';
          const find = K.text('筛选 1M 上下文模型', filter, { class: 'grow', placeholder: '筛选模型', oninput: (e) => { filter = e.target.value; drawBig(true); } });
          bigList.replaceChildren(h('div.sv-set-line', find, probe(() => drawBig())),
            shown.length ? h('ul', shown.map((m) => h('li', check(m, d.big.includes(m), (on) => { d.big = on ? [...d.big, m] : d.big.filter((x) => x !== m); drawBig(); }), h('small', d.big.includes(m) ? '1M · 经本地转发' : '标准 · 直接连接'))))
              : h('small', '先设置默认或固定模型，也可以点击“探测模型”获取完整目录。'));
          if (focus) { find.focus(); find.setSelectionRange(filter.length, filter.length); }
        }
        drawPins();
        drawBig();
        rest.replaceChildren(...[d.proto === 'openai' && K.row('Responses → Chat Completions', '供应商只支持 /chat/completions 时开启；Codex 的 /responses 请求与流式响应会自动转换。', K.sw(d.conv, ['协议转换已开启', '协议转换已关闭'], (on) => { d.conv = on; })),
          modelRow, fromRow, pins, d.proto === 'anthropic' && bigFold, d.proto === 'anthropic' && bigList].filter(Boolean));
      }
      for (const el of [name, url]) el.addEventListener('input', gate);
      if (d.proto) more();
      gate();
      return h('div.sv-pg-form.enter', K.row('协议', null, proto), K.row('名称', null, name), K.row('Base URL', null, url), K.row('API Key', null, secret), rest, K.foot(null, K.btn('取消', () => shut(p), '.quiet'), ok));
    };

    const item = (p) => {
      const by = mountedBy(whole(p));
      let open = null;
      const paint = () => el.replaceChildren(row(), ...(open ? [open] : []));
      const edit = () => {
        open = open ? null : form(p, () => { open = null; paint(); el.firstChild.classList.add('flash'); $('[aria-pressed]', el).focus(); });
        paint();
      };
      const row = () => h('div.sv-pg-prov', h('span.sv-pg-ava', { 'aria-hidden': 'true' }, PROTO[p.proto][1]),
        h('div.grow', h('strong.cut', p.name), h('small.cut', `${PROTO[p.proto][0]} · ${p.url}${p.conv ? ' · Responses→Chat 已开启' : ''}${p.from === 'pinned' ? ` · 固定 ${p.pins.length} 个模型` : ' · 选择器实时拉取模型'}${p.big.length ? ` · ${p.big.length} 个 1M` : ''}`)),
        tag(p.key ? 'Key 已保存' : '缺少 Key', p.key ? '.ok' : '', p.key && 'check'),
        by.length ? tag(`${by.length} 个执行器在用`, '.ok', 'check') : h('button.sv-pg-tag.warn', { type: 'button', 'aria-label': `${p.name} 还没有执行器挂它，任务里选不到它的模型；去执行器设置挂上`, onclick: () => ASH.go('#/settings/agents') }, '未挂到执行器'),
        h('span.sv-pg-model.cut', p.model || '未设默认模型'),
        ibtn('edit', open ? `收起 ${p.name} 的编辑表单` : `编辑 ${p.name}`, edit, { 'aria-pressed': String(!!open), 'data-tip': open ? '收起' : '编辑' }),
        ibtn('trash', `删除 ${p.name}`, async () => {
          const body = by.length ? `删除“${p.name}”后，挂着它的 ${by.map((x) => x.name).join('、')} 会退回 CLI 官方账号。` : `删除“${p.name}”。目前没有执行器挂着它。`;
          if (!(await ASH.confirm({ title: '删除供应商', body, ok: '删除', danger: true }))) return;
          S.providers.splice(S.providers.indexOf(p), 1);
          for (const x of by) Object.assign(x, { prov: '', model: '', level: '' });
          K.leave(el);
          count();
        }));
      const el = h('div.sv-pg-provbox');
      paint();
      return el;
    };

    let adding = null;
    const addKey = K.btn('添加供应商', () => {
      adding = form(null, (made) => { adding.remove(); adding = null; addKey.hidden = false; if (made) list.append(item(made)); count(); (made ? $('.sv-pg-provbox:last-child [aria-pressed]', list) : addKey).focus(); });
      addKey.hidden = true;
      card.append(adding);
      count();
      $('[role="radio"]', adding).focus();
    }, '.pri', 'plus');
    list.append(...S.providers.map(item));
    const card = K.card(K.row('Provider → Profile → 任务', 'Provider 保存协议、Base URL 与 Key；绑定后的 Profile 使用它的额度和完整模型目录。'), list, none);
    count();
    page.append(head('供应商', '管理模型协议、API 地址与密钥，再把供应商绑定到需要独立账号或模型目录的执行器。', addKey), K.sec('模型供应商'), card);
  };
})();
