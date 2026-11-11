/* 设置里除执行器、起手式以外的各页（下半）：执行模式、审查者、飞书、配置搬家、默认规则。
   规矩同上半（settings-pages.js 文件头），共用的小件取 ASH.setMore。
   和现在不一样的只有全应用的尺子：执行模式、审查者那张卡里不再卡套卡，选中的那一项不带彩条；
   配置搬家用回和别页一样的页标题；下拉都是同一个 Select；选谁干活都是三段胶囊。内容是编的。 */
(() => {
  const { h, $, icon } = ASH;
  const K = ASH.setKit;
  const S = ASH.setData;
  const P = ASH.setPages;
  const M = ASH.setMore;

  const URL_OK = /^https?:\/\/\S+$/;
  const PROJECTS = [ASH.data.project, 'docs-site', 'mobile-app'].map((name) => [name, name]);
  const who = (agent, model = null, level = null) => ({ agent, model, level });
  const copyOf = (x) => JSON.parse(JSON.stringify(x));
  /* 文案里的「设置 → …」是能点的 */
  const pathText = (text, go) => text.split(/(「设置\s*→[^」]*」)/).filter(Boolean).map((t) => (t.startsWith('「设置') ? h('button.link', { type: 'button', onclick: go }, t) : t));
  /* 折叠行加它展开的那一块；mid = 不在卡片最底下 */
  const fold = (label, body, open = false, mid = false) => {
    const key = h(`button.sv-set-fold${mid ? '.sv-pg-fold' : ''}`, { type: 'button', 'aria-expanded': String(open), onclick: () => {
      const on = key.getAttribute('aria-expanded') !== 'true';
      key.setAttribute('aria-expanded', String(on));
      body.hidden = !on;
    } }, h('span', label), icon('chev', 'sm'));
    body.hidden = !open;
    return [key, body];
  };
  /* 一格要打完再存的字：名字和一句说明（填错了换成红字）、输入框、一颗动过才亮的「保存」 */
  const typed = (name, input, hint, wrong, onsave) => {
    const said = h('small', hint);
    const save = K.btn('保存', () => { save.disabled = true; onsave(input.value.trim()); });
    save.disabled = true;
    input.addEventListener('input', () => {
      const bad = wrong(input.value.trim());
      said.textContent = bad || hint;
      said.classList.toggle('is-bad', !!bad);
      input.setAttribute('aria-invalid', String(!!bad));
      save.disabled = !!bad;
    });
    return h('div.sv-set-row', h('div', h('b', name), said), input, save);
  };

  /* ---------- 左边一列存好的、右边改其中一个：执行模式、审查者两页是同一个排法 ----------
     o = { store, noun, listName, counted, none, blank(), lines(项) → 名字下面那几行, fields(草稿, sync) → 右边的几行,
           verdict(原件, 草稿, 改过没有) → { text, save, ok }, ask(项) → 删除前问的那句 } */
  const roster = (o) => {
    const list = h('div.sv-pg-items');
    const pane = h('div.sv-pg-pane');
    const count = o.counted && h('em.num');
    const add = h('button.btn.quiet.sm', { type: 'button', onclick: () => open(null, 'input') }, icon('plus'), '新建');
    function open(cur, focus) {
      const draft = cur ? copyOf(cur) : o.blank();
      const state = h('small');
      const save = K.btn('', () => {
        const kept = cur ? Object.assign(cur, copyOf(draft)) : copyOf(draft);
        if (!cur) o.store.unshift(kept);
        open(kept, '[aria-current]');
      }, '.pri');
      const sync = () => {
        const v = o.verdict(cur, draft, !!cur && JSON.stringify(cur) !== JSON.stringify(draft));
        state.textContent = v.text;
        save.textContent = v.save;
        save.disabled = !v.ok;
      };
      const del = cur && K.btn('删除', async () => {
        if (!(await ASH.confirm({ ...o.ask(cur), ok: '删除', danger: true }))) return;
        o.store.splice(o.store.indexOf(cur), 1);
        open(o.store[0] ?? null, o.store.length ? '[aria-current]' : 'input');
      }, '.danger', 'trash');
      add.setAttribute('aria-pressed', String(!cur));
      if (count) count.textContent = o.store.length;
      list.replaceChildren(...(o.store.length ? o.store.map((it) => h('button', { type: 'button', 'aria-current': it === cur ? 'true' : null, onclick: () => open(it) }, h('b.cut', it.name), o.lines(it)))
        : [h('p.sv-pg-empty', o.none)]));
      pane.replaceChildren(h('div.sv-pg-edhead', h('div.grow', h('b', `${cur ? '编辑' : '新建'}${o.noun}`), state), del, save), ...[o.fields(draft, sync)].flat(Infinity).filter(Boolean));
      sync();
      if (focus) $(focus, focus === 'input' ? pane : list)?.focus();
    }
    open(o.store[0] ?? null);
    return h('div.card.sv-pg-roster', h('div.sv-pg-side', h('div.sv-pg-sidehead', h('b', o.listName), count, h('span.grow'), add), list), pane);
  };

  /* ---------- 执行模式：一套团队分工 = 名字、要不要自动审查、调度者 / 执行者 / 审查者各是谁（三段胶囊） ---------- */
  const ROLES = [['lead', '调度者', '维持团队会话并分派工作', 'pgCrown'], ['worker', '执行者', '接收调度并完成具体任务', 'bot'], ['reviewer', '审查者', '在执行完成后独立验收', 'search']];
  const RESIDENT = ['claude', 'codex'];   /* 开得了常驻会话的才当得了调度者 */
  const TEAMS = [
    { name: 'Codex 调度 · Claude 执行', review: true, roles: { lead: who('codex'), worker: who('claude', 'opus-5-5', 'high'), reviewer: who('codex', 'gpt-5.5', 'high') } },
    { name: '全 Claude · 不审', review: false, roles: { lead: who('claude', 'opus-5-5'), worker: who('claude', 'sonnet-5'), reviewer: who('claude') } },
  ];
  P.modes = (page) => {
    page.append(M.head('执行模式', '保存团队的调度、执行和审查分工，创建团队任务时可一键套用。'), K.sec('团队模式'), roster({
      store: TEAMS, noun: '执行模式', listName: '已保存', counted: true, none: '还没有执行模式',
      blank: () => ({ name: '', review: true, roles: { lead: who('claude'), worker: who('codex'), reviewer: who('codex') } }),
      lines: (t) => ROLES.map(([role, label, , ico]) => {
        const off = role === 'reviewer' && !t.review;
        const text = off ? '自动审查关闭' : `默认 ${t.roles[role].agent}${t.roles[role].model ? ` · ${t.roles[role].model}` : ''}`;
        return h(`span${off ? '.is-off' : ''}`, { role: 'group', 'aria-label': `${label}：${text}` }, icon(ico, 'sm'), h('span.cut', text));
      }),
      verdict: (cur, d, dirty) => {
        const ok = !!d.name.trim() && RESIDENT.includes(d.roles.lead.agent);
        return cur ? { text: dirty ? '有未保存更改' : '所有更改已保存', save: '保存更改', ok: ok && dirty }
          : { text: d.name.trim() ? '尚未创建' : '填写名称后即可创建', save: '创建模式', ok };
      },
      ask: (t) => ({ title: '删除执行模式', body: `确定删除「${t.name}」？已经用它创建的团队不会受影响。` }),
      fields: (d, sync) => {
        const warn = h('p.sv-pg-warn', { role: 'alert', hidden: true });
        return [
          K.row('模式名称', null, K.text('模式名称', d.name, { maxlength: '80', placeholder: '如：Codex 调度 · Claude 执行', oninput: (e) => { d.name = e.target.value; sync(); } })),
          K.row('自动审查', '执行结束后自动启动审查者验证结果', K.sw(d.review, ['已开启', '已关闭'], (on) => { d.review = on; sync(); })),
          ROLES.map(([key, label, hint, ico]) => [h('div.sv-set-row.sv-pg-role', h('div', h('b', icon(ico, 'sm'), label), h('small', hint)), ASH.target({ value: d.roles[key], label: `${label} 的智能体与模型`, onchange: (v) => {
            d.roles[key] = v;
            if (key === 'lead') {
              warn.hidden = RESIDENT.includes(v.agent);
              warn.textContent = `${v.agent} 不支持常驻会话，当不了调度者；用这个预设建团队时会被拦下。请在执行器胶囊里改选其它类型。`;
            }
            sync();
          } }).el), key === 'lead' && warn]),
        ];
      },
    }));
  };

  /* ---------- 审查者：一套「谁来审」= 名字加一颗三段胶囊 ---------- */
  const JUDGES = [{ name: '逻辑从严', who: who('codex', 'gpt-5.5', 'xhigh') }, { name: '前端走查', who: who('claude', 'opus-5-5', 'high') }];
  P.reviewers = (page) => {
    const parts = (r) => [`${r.who.agent}@local`, r.who.model ?? '跟随 CLI', r.who.level ?? '跟随 CLI'];
    page.append(M.head('审查者', '保存多套智能体、模型与智能水平组合，供自由工作流按需派审。'), K.sec('已保存的审查者'), roster({
      store: JUDGES, noun: '审查者', listName: '审查者', none: '还没有审查者',
      blank: () => ({ name: '', who: who('codex') }),
      lines: (r) => h('span', { role: 'group', 'aria-label': `智能体：${parts(r)[0]}；模型：${parts(r)[1]}；智能水平：${parts(r)[2]}` }, h('span.cut', parts(r).join(' · '))),
      verdict: (cur, d) => ({ text: '一套配置可在任意自由任务中重复使用。', save: '保存', ok: !!d.name.trim() }),
      ask: (r) => ({ title: '删除审查者', body: `确定删除“${r.name}”？这份配置会从所有任务的审查者列表里消失；历史审查记录仍保留当时的配置快照。任何任务上已排好、还没开跑的审查预约会被取消；已经在跑的自动复审用的是开跑那一刻的配置快照，删掉配置也会继续跑完。` }),
      fields: (d, sync) => [
        K.row('审查者名称', null, K.text('审查者名称', d.name, { placeholder: '例如：Codex 严格逻辑审查', oninput: (e) => { d.name = e.target.value; sync(); } })),
        K.row('智能体 · 模型 · 智能水平', null, ASH.target({ value: d.who, label: '智能体 · 模型 · 智能水平', onchange: (v) => { d.who = v; } }).el)],
    }));
  };

  /* ---------- 飞书：连接、凭证、推送、绑定、群，五节的次序和每一节里的行都照现在。画的是「连着、绑好了」的样子，
     清掉凭证、关掉通道、解绑之后各自的样子也都能点出来 ---------- */
  const LINK = {
    unconfigured: ['queue', '未配置', '还没填 App ID 和 App Secret，机器人不在线。照下面的开通顺序来。'],
    disabled: ['queue', '已关闭', '推送总开关关着：长连接已断开，机器人下线，飞书里发消息也没人接。'],
    connecting: ['wait', '连接中', '正在和飞书建立长连接。'],
    connected: ['new', '已连接', '长连接正常，飞书里的消息和卡片按钮都会送到这台机器。'],
  };
  const TIERS = [[0, '照常', '70% 以下', '该推的都推。'], [70, '省着用', '满 70%', '收到你的消息后不再加「已收到」表情。'],
    [90, '只推要紧的', '满 90%', '只发要你拍板的卡（提问、待验收、失败、驳回、闸口）和对话回复；完成通知不发，在别处处理掉的旧卡片也不再改成「已处理」。'],
    [99, '见底', '满 99%', '除了把你刚点的按钮结果写回那张卡，什么都不发。']];
  const CALLS = [['发消息 / 发卡片', 812], ['改卡片', 301], ['加表情回执', 96], ['查询机器人与群信息', 54], ['下载图片 / 文件', 9], ['换取访问令牌', 12]];
  const SCOPES = [['im:message.p2p_msg:readonly', '收你发给机器人的单聊消息'], ['im:message:send_as_bot', '以机器人身份发消息、发卡片、改卡片'],
    ['im:message.group_at_msg:readonly', '收群里 @ 机器人的消息', '要用群功能才开'], ['im:resource', '收你发来的图片和文件', '可选']];
  const BOUNDS = ['能给机器人下指令就能让这台机器上的 agent 干活，而 agent 手里有 shell——**飞书账号从此等于这台机器的 shell 凭据**。公司租户的企业管理员和应用协作者能改应用配置、轮换密钥。',
    '凭证存在库文件旁边的 `<库文件>.feishu.json`（权限 0600），不进设置、不进环境变量。但本机 agent 和 ash 服务是同一个系统用户，**它们读得到这个文件**，可以冒充机器人发消息。',
    'Windows 上 0600 这个权限位不生效，文件能被谁读取取决于它所在目录的权限设置。',
    '一个飞书应用只能连一个 ash 实例：飞书会把事件随机分给连着的客户端之一，两台机器连同一个应用就会各丢一半消息。每台机器各建一个应用；上面的「本机实例指纹」可以用来核对连着的是哪一台。'];
  const FS = { conn: 'connected', appId: 'cli_a0b1c2d3e4f5a6b7', domain: 'feishu', saved: '2026/11/2 09:12:26', since: '2026/11/11 08:02:15', on: true, done: false, url: 'https://ash.example.com:4317',
    quota: 10000, quiet: [], bound: 'bound', at: '2026/11/2 09:15:40', groups: [{ name: '前端小队', project: ASH.data.project, cards: true, at: '2026/11/4 14:20:11' }], claims: [] };
  const scope = (v) => h('span.sv-pg-scope', h('code.sv-pg-code', v), M.copyKey(v, `复制 ${v}`));
  const guide = () => h('div.sv-pg-guide',
    h('ol', h('li', M.rich('**建应用。**在飞书开放平台（Lark 国际版同理）建一个「企业自建应用」，在「添加应用能力」里开启**机器人**。个人自用建议建在自己当管理员的团队或测试企业下。')),
      h('li', M.rich('**只开这几项权限：**'), h('ul', SCOPES.map(([v, why, when]) => h('li', scope(v), h('span', why, when && `（${when}）`)))),
        h('small', M.rich('不要开 `im:message.group_msg`（会读到群里的全部对话），也不要开通讯录。权限压到最小，密钥万一泄露，影响也只到「冒充机器人收发消息」为止。'))),
      h('li', M.rich('**在这里填凭证。**把应用的 App ID、App Secret 填进下面的「凭证」卡保存，等上面的状态变成「已连接」。')),
      h('li', M.rich('**订阅事件。**回开发者后台「事件与回调」，订阅方式选「使用长连接接收」，事件订阅加 '), scope('im.message.receive_v1'), '，回调订阅加 ', scope('card.action.trigger'), '。这一步要求 ash 已经连着，所以必须排在第 3 步之后。'),
      h('li', M.rich('**发布版本。**权限和订阅每改一次都要发一次版才生效；部分权限要企业管理员审核。'))),
    h('b', '接进来之前要知道的'), h('ul', BOUNDS.map((t) => h('li', M.rich(t)))));

  P.feishu = (page, ctx) => {
    const later = (fn, ms) => ctx.timers.push(setTimeout(fn, ms));
    const clock = () => new Date().toLocaleString('zh-CN');
    const code = () => [0, 0].map(() => Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '7')).join('-');
    /* 码的倒计时：一秒跳一下，离开页面或这一行被换掉就停 */
    const expiry = (until) => {
      const el = h('span.sv-set-val.num');
      const paint = () => { const s = Math.max(0, Math.ceil((until - Date.now()) / 1000)); el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} 后过期`; };
      const id = setInterval(() => (el.isConnected ? paint() : clearInterval(id)), 1000);
      ctx.timers.push(id);
      paint();
      return el;
    };

    /* 连接：在不在线、为什么不在线、这个月的额度用了多少 */
    const dot = h('i');
    const word = h('span');
    const detail = h('small');
    const facts = h('dl.kv.sv-pg-facts');
    const figure = h('span.sv-pg-figure');
    const bar = h('i');
    const meter = h('div.sv-pg-meter', { role: 'meter', 'aria-label': '本月调用额度用量', 'aria-valuemin': '0' }, bar);
    const levels = h('div.sv-pg-levels', { role: 'group', 'aria-label': '额度水位' });
    const again = M.wait(ctx, '重新连接', '连接中…', 900, () => link('connected'), '', 'redo');
    function link(state) {
      const [tone, label, text] = LINK[state];
      const live = state === 'connected';
      if (live && FS.conn !== 'connected') FS.since = clock();
      FS.conn = state;
      dot.className = `dot ${tone}`;
      word.textContent = label;
      detail.textContent = text;
      again.hidden = state === 'unconfigured' || state === 'disabled';
      facts.replaceChildren(...[live && ['处于这个状态自', FS.since], live && ['本次连上于', FS.since], state !== 'unconfigured' && ['最近一次收到事件', '3 分钟前（2026/11/11 10:42:07）'], live && ['机器人', 'ash 值班'],
        ['本机实例指纹', [h('code.sv-pg-code', 'k7q2'), h('small', '每次连上，机器人会在单聊里发一句「实例 k7q2 已上线」；看到别的指纹，说明另一台机器连着同一个应用。')]]]
        .filter(Boolean).flatMap(([k, v]) => [h('dt', k), h('dd', v)]));
      drawBind();
    }
    function usage() {
      const calls = CALLS.reduce((sum, [, n]) => sum + n, 0);
      const pct = Math.min(100, Math.round((calls / FS.quota) * 1000) / 10);
      const now = TIERS.findLast(([from]) => pct >= from);
      figure.replaceChildren(h('strong.num', calls.toLocaleString('zh-CN')), ` / ${FS.quota.toLocaleString('zh-CN')}`, h('em', `（${pct}%）`));
      bar.style.transform = `scaleX(${pct / 100})`;
      bar.className = pct >= 90 ? 'is-bad' : pct >= 70 ? 'is-warn' : '';
      meter.setAttribute('aria-valuemax', FS.quota);
      meter.setAttribute('aria-valuenow', calls);
      levels.replaceChildren(...TIERS.map((t) => h(`div${t === now ? '.is-now' : ''}`, h('b', t[1], h('em', t[2]), t === now && h('strong', '当前')), h('span', t[3]))));
    }
    const linkCard = K.card(h('div.sv-set-row', h('div', h('b.sv-pg-state', dot, word), detail), again), facts,
      K.row('本月调用额度（2026-11）', '按自然月（北京时间）计。飞书开放平台没有查询额度的接口，这里是 ash 自己记的次数，上限照「推送」卡里填的月额度；以开发者后台的用量页为准。', figure), meter, levels,
      fold('按调用种类看明细', h('div.sv-pg-kinds', h('dl.kv.sv-pg-facts', CALLS.flatMap(([k, n]) => [h('dt', k), h('dd.num', n.toLocaleString('zh-CN'))])), h('small', '额度吃紧时按「表情回执 → 改卡片 → 查询信息 → 发消息」的顺序先砍不要紧的。')), false, true),
      K.row('发件积压', '要推的卡片先进发件表，再按飞书的限流一条条发出去；发不出去的会重试。', h('span.sv-set-val', '待发 0 条 · 已放弃 0 条')),
      fold('开通顺序与安全边界', guide(), FS.conn !== 'connected'));

    /* 凭证：App Secret 只写不读，平时收成「已配置（不回显）」；留空 = 沿用已存的那一把 */
    const cred = h('div.card');
    function drawCred(focus) {
      const has = FS.conn !== 'unconfigured';
      let domain = FS.domain;
      const appId = K.text('App ID', has ? FS.appId : '', { class: 'mono', autocomplete: 'off', placeholder: 'cli_…' });
      const secret = K.text('App Secret', '', { type: 'password', autocomplete: 'new-password', placeholder: has ? '留空则沿用已存的 Secret' : '在开发者后台「凭证与基础信息」里复制' });
      const save = M.saveKey('保存凭证', () => {
        Object.assign(FS, { appId: appId.value.trim(), domain, saved: clock() });
        link('connecting');
        later(() => FS.conn === 'connecting' && link(FS.on ? 'connected' : 'disabled'), 1100);
        drawCred('input');
      });
      const gate = () => { save.disabled = !(appId.value.trim() && (has ? appId.value.trim() !== FS.appId || domain !== FS.domain || secret.value : secret.value)); };
      const clear = async () => {
        if (!(await ASH.confirm({ title: '清除飞书凭证', body: '清除后机器人立刻下线，已发出的卡片按钮全部失效。App Secret 取不回来，以后要用得重新填。', ok: '清除凭证', danger: true }))) return;
        link('unconfigured');
        drawCred('input');
      };
      const secretRow = h('div.sv-set-row');
      const drawSecret = (typing) => secretRow.replaceChildren(h('div', h('b', 'App Secret'), !typing && h('small', '已配置（不回显）')), ...(typing
        ? [secret, has && K.btn('取消', () => { secret.value = ''; drawSecret(false); gate(); $('button', secretRow).focus(); }, '.quiet')]
        : [K.btn('换一把', () => { drawSecret(true); secret.focus(); }, '.quiet'), K.btn('清除', clear, '.quiet')]).filter(Boolean));
      drawSecret(!has);
      cred.replaceChildren(K.row('App ID', null, appId), secretRow, K.row('域名', null, K.seg('飞书域名', [['feishu', '飞书'], ['lark', 'Lark（国际版）']], domain, (v) => { domain = v; gate(); })),
        K.foot(has ? `上次保存：${FS.saved}。Secret 存进去就取不回来，只能换一把；保存后会立刻断开重连。` : 'Secret 存进去就取不回来，只能换一把。保存后 ash 立刻去连飞书，等上面的状态变成「已连接」再去后台订阅事件。', save));
      cred.oninput = gate;
      if (focus) $(focus, cred)?.focus();
    }

    /* 推送：两颗开关拨了就存；地址和额度要打完再存 */
    const quietRow = K.row('只推标题和链接的项目', null, h('div.sv-pg-checks', { role: 'group', 'aria-label': '只推标题和链接的项目' },
      PROJECTS.map(([name]) => M.check(name, FS.quiet.includes(name), (on) => { FS.quiet = on ? [...FS.quiet, name] : FS.quiet.filter((x) => x !== name); }))));
    const quietSay = () => M.setHints(quietRow, `勾上的项目，卡片里只有任务标题和链接，不带提问正文、失败原因这些可能含代码或命令输出的内容。${FS.url ? '' : '现在没填深链地址，这些卡片就只剩标题了。'}`);
    const push = K.card(
      K.row('飞书通道', '关掉就断开长连接、机器人下线：什么都不推，飞书里发消息也没人接。凭证不会被清掉。', K.sw(FS.on, ['已开启', '已关闭'], (on) => {
        FS.on = on;
        if (FS.conn === 'unconfigured') return;
        link(on ? 'connecting' : 'disabled');
        if (on) later(() => FS.conn === 'connecting' && link('connected'), 900);
      })),
      K.row('完成也推', '任务完成、验收合并、门禁出结果时各推一条通知。要你拍板的卡（提问、待验收、失败）不受这个开关影响，总会推。', K.sw(FS.done, ['已开启', '已关闭'], (on) => { FS.done = on; })),
      typed('卡片深链地址', K.text('卡片深链地址', FS.url, { class: 'mono', placeholder: 'https://my-mac.tailnet.ts.net:4317' }), '卡片上「在 ash 中打开」的地址前缀。填 Tailscale 等手机能打开的地址；为空则卡片不带链接。',
        (v) => (v && !URL_OK.test(v) ? '要以 http:// 或 https:// 开头，中间不能有空格' : ''), (v) => { FS.url = v.replace(/\/+$/, ''); quietSay(); }),
      typed('月调用额度', K.text('月调用额度', String(FS.quota), { class: 'mono sv-set-num', inputmode: 'numeric' }), '飞书开放平台给这个应用的月调用次数上限，从开发者后台的用量页抄过来（默认 10,000）。ash 按它算水位，接近上限时先少推不要紧的。',
        (v) => (/^[1-9]\d*$/.test(v) ? '' : '填一个正整数'), (v) => { FS.quota = Number(v); usage(); }),
      quietRow);

    /* 绑定：网页发起、网页确认。没绑 → 给一串码 → 飞书里有人发来了，问是不是你 → 绑好。样机里码发出去几秒后自己走到下一步 */
    const bind = h('div');
    function drawBind() {
      const had = bind.contains(document.activeElement);
      const live = FS.conn === 'connected';
      const off = !live && `机器人现在不在线（${LINK[FS.conn][1]}），码发过去没人收，先把上面的连接弄好。`;
      const step = (state) => { FS.bound = state; FS.at = clock(); drawBind(); drawGroups(); };
      const make = () => {
        Object.assign(FS, { code: code(), until: Date.now() + 600000 });
        step('code');
        if (live) later(() => FS.bound === 'code' && step('pending'), 4000);
      };
      const test = K.row('发一张测试卡', null, M.wait(ctx, '发一张测试卡', '发送中…', 800, () => testSay(live ? '测试卡已发出，去飞书单聊里看看' : `机器人现在不在线（${LINK[FS.conn][1]}），测试卡没发出去`)));
      const testSay = (result) => M.setHints(test, '验证机器人能不能给你发消息——权限、发版、连接任何一环没通，这里会报出来。', result);
      testSay();
      bind.replaceChildren(...{
        none: () => [K.row('还没绑定飞书', ['绑定后，提问、待验收、失败这些要你拍板的事会推成卡片，发到你和机器人的单聊里。', off], K.btn('绑定飞书', make, '.pri'))],
        code: () => [K.row('在飞书里给机器人单聊发这串码', [h('span.sv-pg-codeline', h('code', { 'aria-label': '绑定码' }, FS.code), M.copyKey(FS.code), expiry(FS.until)), '发过去之后这里会显示是谁发的，由你确认。码只显示这一次，刷新页面就看不到了。', off], K.btn('重新生成', make))],
        pending: () => [K.row(`飞书用户 …a41c 在 ${FS.at} 发来了这串码，是你吗？`, '没开通讯录权限，ash 拿不到飞书里的名字，只能显示 open_id 的末几位。不是你发的就点「不是我」——说明码落到了别人手里。10 分钟内有效。',
          K.btn('不是我', () => step('none')), K.btn('确认绑定', () => step('bound'), '.pri'))],
        bound: () => [K.row('已绑定飞书用户 …a41c', `绑定于 ${FS.at}。只显示 open_id 的末几位：没开通讯录权限，ash 拿不到飞书里的名字。`, K.btn('解除绑定', async () => {
          if (await ASH.confirm({ title: '解除飞书绑定', body: '解除后卡片不再推给你，你在飞书里发给机器人的消息也不再被认作你；已发出的卡片按钮随之失效。以后要用得重新绑定。', ok: '解除绑定', danger: true })) step('none');
        }, '.danger')), test],
      }[FS.bound]());
      if (had) $('button', bind)?.focus();
    }

    /* 群：把一个飞书群绑到一个项目，方向和个人绑定一样 */
    const groups = h('div');
    function drawGroups() {
      const had = groups.contains(document.activeElement);
      let target = PROJECTS[0][0];
      const settle = (c, name) => {
        FS.claims.splice(FS.claims.indexOf(c), 1);
        if (name) FS.groups.push({ name, project: c.project, cards: false, at: clock() });
        drawGroups();
      };
      const make = () => {
        const c = { project: target, code: code(), until: Date.now() + 600000 };
        FS.claims.push(c);
        drawGroups();
        later(() => { if (FS.claims.includes(c) && !c.from) { Object.assign(c, { from: '设计评审', at: clock() }); drawGroups(); } }, 4000);
      };
      groups.replaceChildren(
        ...FS.groups.map((g) => K.row(g.name, `绑定于 ${g.at} · 由 我 绑定`, K.pick(`${g.name} 绑定的项目`, PROJECTS, g.project, (v) => { g.project = v; }), K.sw(g.cards, ['卡片发到群里', '卡片发单聊'], (on) => { g.cards = on; }),
          K.btn('解绑', async () => {
            if (!(await ASH.confirm({ title: '解绑飞书群', body: `解绑后，群「${g.name}」里 @ 机器人不再进项目「${g.project}」，这个项目的卡片也改回发到各人的单聊。`, ok: '解绑', danger: true }))) return;
            FS.groups.splice(FS.groups.indexOf(g), 1);
            drawGroups();
          }, '.quiet'))),
        ...FS.claims.map((c) => (c.from
          ? K.row(`群「${c.from}」在 ${c.at} 发来了绑定码，要把它绑到项目「${c.project}」吗？`, '不认识这个群就拒绝。10 分钟内有效。', K.btn('拒绝', () => settle(c)), K.btn('确认绑定群', () => settle(c, c.from), '.pri'))
          : K.row(`给项目「${c.project}」的群绑定码`, [h('span.sv-pg-codeline', h('code', { 'aria-label': '群绑定码' }, c.code), M.copyKey(c.code), expiry(c.until)), '把机器人拉进群，在群里 @机器人 发这串码。码只显示这一次，刷新页面就看不到了。']))),
        K.row('绑定一个群', FS.bound === 'bound' ? '选好项目生成码，再把机器人拉进群、在群里 @机器人 发这串码。'
          : [pathText('群里 @ 机器人发码的人要是已经绑定了飞书的人，所以先在「设置 → 飞书 → 绑定」绑好你自己的。', () => { bind.scrollIntoView({ block: 'center' }); $('button', bind)?.focus(); })],
        M.form2(K.pick('要绑群的项目', PROJECTS, target, (v) => { target = v; })), K.btn('生成群绑定码', make)));
      if (had) $('button', groups)?.focus();
    }

    page.append(M.head('飞书', '把要你拍板的事（提问、待验收、失败）推成飞书卡片，在手机上点一下就处理；长会话、diff 和预览仍回网页看。'),
      K.sec('连接'), linkCard, K.sec('凭证'), cred, K.sec('推送'), push,
      K.sec('绑定'), K.card(bind, K.foot('绑定只能从网页发起、在网页确认：码在这里生成，在飞书里发给机器人，再回到这里点确认。')),
      K.sec('群'), K.card(groups, K.foot(M.rich('群里的 @ 消息进这个项目的群聊房间，用发言人自己的 ash 身份执行；没绑定飞书的人 @ 机器人不会有反应。打开「卡片发到群里」后，这个项目的任务卡片改发到群里、不再发单聊，在群话题里回复提问卡就是答复，回复别的卡以 /reply 开头才会发给那个任务。群功能要在应用权限里开 `im:message.group_at_msg:readonly` 并重新发版。'))));
    link(FS.conn);
    usage();
    drawCred();
    quietSay();
    drawGroups();
  };

  /* ---------- 配置搬家：导出勾哪几类、导入先看一眼文件里有什么再并入。样机里不真的读写文件 ---------- */
  const KINDS = { providers: '供应商(不含 API key)', executors: '执行器', workflows: '起手式', reviewers: '审查者', teamPresets: '模式预设', cliEnv: '个人 CLI 环境(技能 + 全局指令)' };
  P.config = (page, ctx) => {
    const picked = new Set(Object.keys(KINDS));
    const said = h('span', { role: 'status' });
    const out = M.wait(ctx, '导出为文件', '正在导出…', 500, () => { said.textContent = '已导出 ash-config-2026-11-11.json'; out.disabled = !picked.size; }, '.pri');
    const stage = h('div');
    const done = () => stage.replaceChildren(h('div.sv-pg-staged.enter', { role: 'status' }, h('p', h('b', '导入完成。'), '执行器 2 条、起手式 1 条、审查者 1 条'), h('small', '同名跳过：claude@local、标准交付、示例网关')));
    const choose = K.btn('选择配置文件…', () => {
      stage.replaceChildren(h('div.sv-pg-staged.enter', h('p', h('code.sv-pg-code', 'ash-config-2026-11-08.json'), '（导出于 2026/11/8 20:31:44）'),
        h('ul', [['providers', 1], ['executors', 3], ['workflows', 2], ['reviewers', 1]].map(([kind, n]) => h('li', `${KINDS[kind]}：${n} 条`))),
        h('div.sv-set-line', h('span.grow'), K.btn('取消', () => { stage.replaceChildren(); choose.focus(); }, '.quiet'), M.wait(ctx, '导入', '正在导入…', 700, () => { done(); choose.focus(); }, '.pri'))));
      $('.pri', stage).focus();
    });
    page.append(M.head('配置搬家', '把你自己那套执行器、模式预设、起手式、审查者和个人 CLI 环境打包成一个文件，换机器或者给同事复制时导入。'),
      h('p.note.warn', icon('warn'), h('span', M.rich('导出文件**不含任何 API key** —— 这种文件多半会走聊天工具传，带 key 等于把凭据递出去。供应商只带地址和协议，导入方自己补 key。'))),
      K.sec('导出'), K.card(h('div.sv-pg-checks.sv-set-pad', { role: 'group', 'aria-label': '要导出的内容' }, Object.entries(KINDS).map(([kind, label]) => M.check(label, true, (on) => {
        if (on) picked.add(kind); else picked.delete(kind);
        out.disabled = !picked.size;
        said.textContent = '';
      }))), K.foot(said, out)),
      K.sec('导入'), K.card(K.row(null, M.hints('导入是**并入**：同名的执行器 / 预设 / 起手式一律跳过，不会改掉你已有的。执行器按**名字**找供应商 —— 对面没有同名供应商时，那个执行器会先落成「没挂供应商」，你补上就能跑。'), choose), stage));
  };

  /* ---------- 默认规则：任务默认值、输入框、外观、任务接力、技能扫描、实例模式，六节照现在。
     发送键和深浅色是真的：改了回去看回复框、看整页 ---------- */
  const PEER = { name: '办公室的台式机', fp: '8F21-0C7D-6A93-E4B5-12D0', url: 'http://10.0.0.20:4317' };
  const TARGETS = [{ name: PEER.name, url: PEER.url, fp: PEER.fp, key: false, state: '' }];
  const INBOUND = [{ name: '客厅的笔记本', fp: 'C4D9-17A0-3E6B-9F52-08B1', from: '10.0.0.31', at: '2026/11/10 21:14:03', status: 'pending' }];
  const SKILLS = { claude: [14, '个人 5 · 插件 9', '/review /commit /release-notes /simplify /write-tests', 9], codex: [6, '个人 6', '/review /fix-ci /changelog', 3], qwen: [0] };
  const finger = (fp, attrs) => h(attrs ? 'button.sv-pg-finger' : 'span.sv-pg-finger', attrs ?? {}, icon('pgFinger', 'sm'), fp);

  P.defaults = (page, ctx) => {
    const root = document.documentElement;
    const mod = () => /^mod/.test(ASH.data.sendKey ?? '');
    const sendRow = K.row('按哪一下算发送', null, K.pick('输入框发送键', [['enter', '回车直接发送（Shift + 回车换行）'], ['mod-enter', '⌘ / Ctrl + 回车发送（回车换行）']], mod() ? 'mod-enter' : 'enter', (v) => { ASH.data.sendKey = v; sendSay(); }));
    const sendSay = () => M.setHints(sendRow, '对全站的消息输入框生效：任务回复、新建任务、答复提问、团队插话、群聊、侧聊、ash 助手、讨论关口、派审附言。改完立刻生效，不用刷新页面。',
      mod() ? '当前：⌘ / Ctrl + Enter 发送，Enter 换行' : '当前：Enter 发送，Shift Enter 换行（⌘ / Ctrl + 回车也照旧发送）');
    sendSay();
    /* 深浅色和样机栏那颗「深色」是同一个开关 */
    const theme = K.seg('配色', [['system', [icon('monitor', 'sm'), '跟随系统']], ['light', [icon('sun', 'sm'), '浅色']], ['dark', [icon('moon', 'sm'), '深色']]], root.dataset.theme === 'dark' ? 'dark' : 'light', (v) => {
      const want = v === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : v === 'dark';
      if ((root.dataset.theme === 'dark') === want) return;
      const key = $('#themeBtn');
      if (key) key.click(); else root.dataset.theme = want ? 'dark' : 'light';
    });
    theme.classList.add('sv-pg-theme');

    /* 任务接力 · 来源机器地址：来源机换了地址，在这里改，核对指纹后保存 */
    const src = K.text(`${PEER.name}的 ash 地址`, PEER.url, { class: 'mono', placeholder: 'http://192.168.1.50:4317' });
    const srcSaid = h('p.sv-pg-said', { role: 'status', hidden: true }, '地址已保存，来源机指纹一致。回到任务点击“重新检查”即可。');
    const srcSave = M.wait(ctx, '核对并保存', '正在核对…', 800, () => { srcSaid.hidden = false; }, '.quiet');
    src.addEventListener('input', () => { srcSave.disabled = !URL_OK.test(src.value.trim()); srcSaid.hidden = true; });

    /* 任务接力 · 接力目标机器：一台两行——名字、地址、申请和记住的指纹；下面是「我在那台机器上的账号 key」 */
    const targets = h('div');
    const drawTargets = (focus) => {
      targets.replaceChildren(...TARGETS.map((t, i) => {
        const ready = () => !!t.name.trim() && URL_OK.test(t.url.trim());
        const state = h('span');
        const drawState = () => state.replaceChildren(t.state ? M.tag(t.state, t.state === '对方已接受' ? '.ok' : '.warn')
          : t.fp ? finger(t.fp, { type: 'button', 'aria-label': `忘记「${t.name || t.url}」记住的身份指纹`, 'data-tip': '忘记这串指纹', onclick: async () => {
            if (!(await ASH.confirm({ title: '忘记记住的对端身份', body: `清除后，下一次接力到「${t.name || t.url}」会按首次配对处理：那个地址背后换成了别的机器也不会被拦住。只有在你确认那台机器重装过、或者换了新机器时才这么做。`, ok: '清除并重新配对', danger: true }))) return;
            t.fp = '';
            drawTargets(`[data-target="${i}"] .btn`);
          } }) : h('span.sv-set-val', '申请后核对身份'));
        const ask = M.wait(ctx, t.state || t.fp ? '检查状态' : '申请', '申请中…', 800, () => {
          Object.assign(t, { state: t.state ? '对方已接受' : '等待对方接受', fp: t.fp || PEER.fp });
          drawTargets(`[data-target="${i}"] .btn`);
        }, '.quiet', 'send');
        ask.disabled = !ready();
        const keyLine = h('div.sv-set-line.sv-pg-keyline');
        const drawKey = (typing) => {
          const field = K.text('你在对端的账号 key', '', { class: 'mono grow', type: 'password', autocomplete: 'off', placeholder: 'ash_… （你在对端的账号 key）' });
          const save = K.btn('保存', () => { t.key = true; drawKey(false); $('.btn', keyLine).focus(); }, '.quiet.sm');
          save.disabled = true;
          field.addEventListener('input', () => { save.disabled = !field.value.trim(); });
          keyLine.replaceChildren(...[icon('pgKey', 'sm'), ...(typing ? [field, save, K.btn('取消', () => { drawKey(false); $('.btn', keyLine).focus(); }, '.quiet.sm')]
            : [h('small.grow', t.key ? '已配置对端账号 key（不回显）' : '还没配对端账号 key —— 目标机是多人实例时必须有它'), K.btn(t.key ? '换一把' : '填写', () => { drawKey(true); $('input', keyLine).focus(); }, '.quiet.sm'),
              t.key && K.btn('清除', () => { t.key = false; drawKey(false); $('.btn', keyLine).focus(); }, '.quiet.sm')])].filter(Boolean));
        };
        drawKey(false);
        drawState();
        return h('div.sv-pg-target', { 'data-target': i },
          h('div.sv-set-line', K.text('目标机器的名字', t.name, { placeholder: '名字（如 家里的台式机）', oninput: (e) => { t.name = e.target.value; ask.disabled = !ready(); } }),
            K.text('目标机器的地址', t.url, { class: 'mono grow', placeholder: 'http://192.168.1.50:4317', oninput: (e) => { Object.assign(t, { url: e.target.value, fp: '', state: '' }); drawState(); ask.lastElementChild.textContent = '申请'; ask.disabled = !ready(); } }),
            ask, state, M.ibtn('trash', `删除接力目标 ${t.name || t.url || i + 1}`, () => { TARGETS.splice(i, 1); drawTargets(); addTarget.focus(); })), keyLine);
      }));
      if (focus) $(focus, targets)?.focus();
    };
    const addTarget = K.btn('添加', () => { TARGETS.push({ name: '', url: '', fp: '', key: false, state: '' }); drawTargets(`[data-target="${TARGETS.length - 1}"] input`); }, '.quiet', 'plus');
    drawTargets();

    /* 任务接力 · 入站：三颗整台机器的闸，加谁敲过门。身份看指纹，不看地址 */
    const inbound = h('div');
    const drawInbound = (focus) => {
      const WORD = { pending: ['待批准', '.warn'], approved: ['已批准', '.ok'], blocked: ['已拒绝', '.bad'] };
      const set = (p, status) => { p.status = status; drawInbound(true); };
      inbound.replaceChildren(...(INBOUND.length ? INBOUND.map((p) => h('div.sv-set-row', h('div', h('b.sv-pg-state', p.name, M.tag(...WORD[p.status]), h('span.sv-set-val', '自用实例')), h('small', `指纹 ${p.fp} · 来自 ${p.from} · 最近 ${p.at}`)),
        p.status !== 'approved' && K.btn('批准', () => set(p, 'approved'), '.quiet', 'check'), p.status !== 'blocked' && K.btn('拒绝', () => set(p, 'blocked'), '.quiet', 'setBan'),
        M.ibtn('trash', `忘记接力来源 ${p.name}`, () => { INBOUND.splice(INBOUND.indexOf(p), 1); drawInbound(); limit.focus(); })))
        : [h('p.sv-pg-empty', '还没有别的机器申请接力进来。对方第一次申请时会自动出现在这里等你批准。')]));
      if (focus) $('button', inbound)?.focus();
    };
    const limit = K.text('接力载荷上限（MB）', '512', { class: 'sv-set-num', inputmode: 'numeric', onblur: (e) => { e.target.value = Math.min(512, Math.max(1, Math.round(Number(e.target.value) || 512))); }, onfocus: (e) => e.target.select() });
    drawInbound();

    /* 技能扫描：一种 CLI 一行，换项目或重新扫描都重画 */
    const scan = h('div');
    let scanIn = '';
    let scanAt = '2026/11/11 10:40:12';
    const drawScan = () => scan.replaceChildren(...S.agents.map((a) => {
      const hit = SKILLS[a.id];
      const more = scanIn && a.id === 'claude' ? 2 : 0;
      return h('div.sv-pg-scan', h('div', h('b.mono', a.id), h('small.cut', a.profiles.length ? a.profiles.map((x) => x.name).join(' · ') : '未注册执行器')),
        !hit ? h('small.grow', '这个 CLI 没有技能目录约定，菜单里只有 ash 自己的命令') : !hit[0] ? h('small.grow', '没扫到技能')
          : h('div.grow', h('span', `${hit[0] + more} 条`, h('em', `${more ? '项目 2 · ' : ''}${hit[1]}`)), h('small.cut.mono', `${hit[2]} …还有 ${hit[3] + more} 条`)));
    }), K.foot(scanIn ? `项目根：/Users/me/code/${scanIn}` : '未选项目：只扫了个人级与插件级技能', h('span', `扫描时间 ${scanAt}`)));
    drawScan();

    /* 实例模式：自用 → 多人是单向的。点开是一张表，填完拿到一串只显示一次的管理员 key */
    const mode = h('div.card');
    const drawMode = (stage) => {
      const idle = K.row('自用模式', M.hints('零鉴权，打开就用；CLI 用这台机器上的登录态，订阅照用。要几个人一起用就切到多人模式 —— **单向，切了转不回来**。'), stage === 'idle' && K.btn('切到多人模式…', () => drawMode('form'), '.danger'));
      if (stage === 'idle') return void mode.replaceChildren(idle);
      if (stage === 'key') {
        const fin = K.btn('完成', () => { drawMode('idle'); $('button', mode).focus(); }, '.pri');
        fin.disabled = true;
        mode.replaceChildren(h('div.sv-pg-key.enter', h('b', '这是你的管理员 key'), h('small', '这串 key 只显示这一次。关掉这一屏之后，服务端只留哈希，谁也读不回来。'), h('span.sv-pg-codeline', h('code', 'ash_••••••••••••••••••••'), M.copyKey('ash_', '复制')),
          M.check('我已经把它存到密码管理器里了', false, (on) => { fin.disabled = !on; }), h('div.sv-set-line', h('span.grow'), fin)));
        return void $('.sv-pg-check', mode).focus();
      }
      let shared = false;
      let touched = false;
      const name = K.text('你的姓名', '', { placeholder: '张三' });
      const base = K.text('根目录', '', { class: 'mono', placeholder: '~/ash-workspaces' });
      const dir = K.text('你的目录名', '', { class: 'mono', placeholder: 'zhangsan', oninput: () => { touched = true; } });
      const dirSaid = h('small.is-bad');
      const baseRow = K.row('根目录', null, base);
      const unbacked = h('div.note.bad', icon('warn'), h('div', h('b', '转换后这些执行器派不出任务：'), h('ul', S.agents.flatMap((a) => a.profiles.filter((x) => !x.prov).map((x) => h('li', `「${x.name}」（${a.id}）—— 没有挂供应商：多人模式下宿主机的 CLI 订阅被隔离，必须自带 key`)))),
        '你选的是「每人自带 key」，宿主机的 CLI 订阅会被隔离。转换后到「设置 → 供应商」里配一个，再把执行器挂上去 —— 或者上面改选「共用这台机器的 CLI 额度」。'));
      const go = K.btn('确认切到多人模式', () => drawMode('key'), '.pri');
      const quota = h('div.sv-pg-choice.is-tall', { role: 'radiogroup', 'aria-label': 'CLI 额度怎么算' }, [
        [false, '每人自带 key（隔离宿主机 CLI）', '每人一个独立的 CLI 配置目录，宿主机上 claude / codex 的登录态谁也用不到。执行器必须挂自己的供应商 key，各花各的钱。个人技能、个人全局 CLAUDE.md 也按人一份。'],
        [true, '共用这台机器的 CLI 额度', '所有人的任务都用这台机器上已经登录好的 CLI（~/.claude、~/.codex），烧的是同一份官方订阅额度。适合几个人合买一份订阅的小团队。代价是：额度、会话历史、CLI 全局配置和技能全都是共用的一份，个人 CLI 环境那一层不再生效。'],
      ].map(([value, title, text]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(value === shared), onclick: (e) => {
        shared = value;
        for (const b of quota.children) b.setAttribute('aria-checked', String(b === e.currentTarget));
        unbacked.hidden = shared;
      } }, h('strong', title), h('small', text))));
      const sync = () => {
        if (!touched) dir.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
        const bad = dir.value ? (/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/.test(dir.value.trim()) ? '' : '只能用小写字母、数字和连字符,2~32 个字符,不能以连字符开头或结尾') : name.value.trim() ? '自己填一个英文目录名（中文名推不出来），比如 zhangsan' : '';
        dirSaid.textContent = bad;
        M.setHints(baseRow, `每个人会在它下面得到一个自己的目录（\`${base.value.trim() || '<根目录>'}/${dir.value.trim() || '<目录名>'}\`）。**设定后锁死** —— 一改，所有已建项目的路径都会失效。`);
        go.disabled = !name.value.trim() || !base.value.trim() || !dir.value.trim() || !!bad;
      };
      const form = h('div.sv-pg-form.enter', { oninput: sync }, K.row('你的姓名', null, name), baseRow, h('div.sv-set-row', h('div', h('b', '你的目录名'), dirSaid), dir),
        K.row('git 署名', null, K.text('git 署名', '', { placeholder: '张三' })), K.row('git 邮箱', 'agent 提交时会用这对署名。不填就按姓名生成默认值，之后能改。', K.text('git 邮箱', '', { class: 'mono', placeholder: 'zhangsan@ash.local' })),
        K.row('CLI 额度怎么算', '之后随时能在「设置 → 默认规则 → 实例模式」里改，不锁死。', quota),
        h('div.sv-pg-warns', h('p.note.warn', icon('warn'), h('span', M.rich('**库里已经有数据了。**转换后这些全部归你（项目 3、任务 42、随手记 7、执行器 5、供应商 2、起手式 5、审查者 2、模式预设 2）。**项目路径一律不动**，不会往根目录里搬。'))),
          unbacked, h('p.note.warn', icon('warn'), h('span', M.rich('**多人模式转不回自用模式。**多人的数据（各人的项目、执行器、key）没有合并回单人的语义，所以这条路只有单向。')))),
        K.foot(null, K.btn('取消', () => { drawMode('idle'); $('button', mode).focus(); }, '.quiet'), go));
      sync();
      mode.replaceChildren(idle, form);
      name.focus();
    };
    drawMode('idle');

    page.append(M.head('默认规则', '设置新任务的初始行为；创建任务时仍可单独覆盖。'),
      K.sec('任务默认值'), h('p.sv-set-tail', pathText('「新任务默认使用 worktree」已按项目分开设置，去「设置 → 项目设置 → 工作目录」改。', () => ASH.go('#/settings/project'))),
      K.card(K.row('新任务默认走哪条起手式', '项目可以再单独指一条；任务在创建那一刻把线拷进自己兜里，之后改这儿不影响它', M.form2(K.flowPick('新任务默认走哪条起手式', '用系统推荐的那条')))),
      K.sec('输入框'), K.card(sendRow),
      K.sec('外观'), K.card(K.row('深浅色', '跟随系统时，系统切换深浅色页面跟着切换。', theme)),
      K.sec('任务接力'), K.card(K.row('本机接力身份', '别的机器第一次申请接力时会显示这串指纹，两边对上了再批准。私钥只存在本机数据目录，不随任何请求外传。', finger('4E2A-9C10-7BD3-55F8-0A6E'))),
      K.card(K.row('来源机器地址', ['来源机的 IP 或端口变了，在这里填写它现在的 ash 完整地址。核对原有指纹后保存，再回到任务重新检查。', '保存会同步更新接力目标机地址；多人模式下只对你生效。']), K.row(PEER.name, `指纹 ${PEER.fp}`, src, srcSave), srcSaid),
      K.card(K.row('接力目标机器', M.hints('另一台 ash 的根地址。第一次明确申请时会记住它的身份指纹，之后这个地址要是换了机器，申请和接力都会被拦下。', '目标机是**多人实例**时还要填**你在那台机器上的账号 key**——接力用的是你在对端的身份，能推进哪些项目由对端的成员名单决定。没有账号就找对端管理员开一个。'), addTarget), targets),
      K.card(K.row('接力进来要先批准', '开启后，别的机器必须先在下面被你放行，且每个接力请求都要带它自己的密钥签名。关掉就退回旧行为：任何连得上这个端口的机器都能把任务推进本机。', K.sw(true, ['已开启', '已关闭'])),
        K.row('接力传输加密', ['接力载荷（整个 git bundle + 完整 CLI 会话历史）出门前用对端公钥加密，防同网段抓包。冒充和篡改本来就由签名挡着，这一条只管窃听，关掉不影响身份校验。', '调试接力本身时可以关掉——密文在抓包工具里看不了。对端太旧收不了加密载荷时会自动回退成明文，接力对话框里会写明这次是不是明文。'], K.sw(true, ['已开启', '已关闭（明文）'])),
        K.row('接力载荷上限', ['单次接力最多收多大的载荷（MB）。超过就在读取过程中掐断，不等读完——验签必须等 body 读完（签名覆盖 body 哈希），没有这条闸，一个巨大的请求不用带任何签名就能把内存吃光。', '512 是硬顶：载荷最终要变成一个 JS 字符串，Node 的字符串最长就这么大。接力失败提示「超过上限」而任务确实很大时，先在两边把仓库同步到相近的提交——历史对齐了就只打增量包。'], limit),
        K.row('接力来源', '谁尝试过把任务接力进本机。身份看指纹，不看地址——地址会漂，指纹不会。'), inbound,
        K.row('历史回程权限', '曾接走任务的机器只能把对应历史任务免审批移回，不等于整机已批准。拒绝会立即阻止该指纹的所有接力与历史回程，避免遗留权限不可见、不可撤销。'), h('p.sv-pg-empty', '当前没有机器持有历史任务的免审批回程权限。')),
      K.sec('技能扫描'), K.card(
        K.row(M.rich('输入框里 `/技能` 清单多久刷一次'), '指的是页面隔多久去问一次服务端，不是服务端多久扫一次盘（它每次都真扫，命中缓存约 0.5ms）。装了新技能等不及，用下面的「立即重新扫描」，或者关掉输入框再打开——那一下一定是新的',
          K.pick('技能清单刷新间隔', [[0, '不自动刷新'], ...[1, 2, 4, 8, 12, 24].map((n) => [n, `每 ${n} 小时`])], 1)),
        K.row('每个 CLI 扫到了什么', M.hints('技能目录按 CLI 类型定，同一个 CLI 换供应商不会换出另一份技能，所以按类型合成一行。项目级技能来自所选项目仓库根的 `.claude/skills`'),
          K.pick('按项目查看技能', [['', '不限项目（只看个人/插件级）'], ...PROJECTS], scanIn, (v) => { scanIn = v; drawScan(); }), M.wait(ctx, '立即重新扫描', '扫描中…', 700, () => { scanAt = new Date().toLocaleString('zh-CN'); drawScan(); })),
        scan),
      K.sec('实例模式'), mode);
  };
})();
