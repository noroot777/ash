/* 侧栏最底下那一行（side.js 把它装进去），外加弹在它上面的那一层。
   左边是主仓现在在哪个分支：点它，「项目 Git」从这一行的上沿升起来，盖在任务列表上面（列表不让位、不挪动），这一行不挡——分支那颗键是按下去的样子，再点一次、点别处、按 Esc 落回去。原来它是顶行里的一颗下拉。
   右边四颗图标：聊天、助手（去别处），深浅色（画的是现在选的那一档，点开三选一）和收起。名字在提示里。原来深浅色是项目菜单里的一排分段。
   那一层里的东西照现在的（web/src/workspace/ProjectGitPanel.tsx）：搜索、更新 / 拉取 / 推送（领先几个写在推送上）、分支一行一条、去 Git 工作台；
   那一段说明压成最后一句。现在在哪个分支不再写一遍：正下方那一行写着，列表里打勾的也是它。切分支是真的会换（换完落下去、底下那一行跟着改）；更新、拉取、推送之后的样子样机没画。
   对外：ASH.sideFoot() → { el, layer, chat, helper }。layer 要直接放在侧栏那个元素里：它的下沿量的是这一行的上沿。分支是编的。 */
(() => {
  const { h, $$, icon } = ASH;

  const BRANCHES = [
    { name: 'main', up: 2 },
    { name: 'chore/bump-vite', down: 3 },
    { name: 'feat/later-send-recover', bare: true },
    { name: 'fix/reply-stick-bottom', held: true },
    { name: 'docs/keyboard-help', gone: true },
  ];
  const THEMES = [['system', '跟随系统', 'monitor'], ['light', '浅色', 'sun'], ['dark', '深色', 'moon']];
  /* 一条分支右边那半句（照 ProjectGitBranchList.tsx）：被任务的工作区占着、上游没了、没有上游、领先落后几个 */
  const tail = (b) => (b.held ? '占用中' : b.gone ? '上游已删除' : b.bare ? '无 upstream' : [b.up && `↑${b.up}`, b.down && `↓${b.down}`].filter(Boolean).join(' '));

  ASH.sideFoot = () => {
    let cur = BRANCHES[0];
    let up = false;
    let leaving = 0;

    /* ---------- 左边：分支。领先落后紧跟在名字后面；挤的时候先收后半句，再截名字 ---------- */
    const name = h('span.cut', cur.name);
    const ahead = h('em.num', tail(cur));
    const git = h('button.side-git', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-tip': '切换分支或同步', onclick: () => rise(!up) }, icon('branch'), name, ahead);
    const paintGit = () => {
      ASH.swap(name, cur.name);
      ahead.textContent = tail(cur);
      git.setAttribute('aria-label', `主仓在 ${cur.name} 分支，点击切换分支或同步`);
      /* 名字被截了，提示里给全名 */
      requestAnimationFrame(() => { git.dataset.tip = name.scrollWidth > name.clientWidth || ahead.scrollWidth > ahead.clientWidth ? [cur.name, tail(cur)].filter(Boolean).join(' · ') : '切换分支或同步'; });
    };

    /* ---------- 右边：聊天、助手、深浅色、收起 ---------- */
    const chat = h('a.ico', { href: '#/chat', 'aria-label': '聊天', 'data-tip': '聊天' }, icon('chat'));
    const helper = h('a.ico', { href: '#/assistant', 'aria-label': 'ash 助手', 'data-tip': 'ash 助手' }, icon('assistant'));
    const themeGlyph = h('span.side-theme-glyph');
    const theme = h('button.ico', { type: 'button', 'aria-haspopup': 'listbox', 'data-tip': '配色', onclick: () => ASH.menu(theme,
      THEMES.map(([value, label, glyph]) => ({ label, icon: glyph, selected: ASH.theme.pref === value, onpick: () => ASH.theme.set(value) })), { role: 'listbox', place: 'top-end' }) }, themeGlyph);
    const paintTheme = () => {
      const [, label, glyph] = THEMES.find(([value]) => value === ASH.theme.pref) ?? THEMES[0];
      themeGlyph.replaceChildren(icon(glyph));
      theme.setAttribute('aria-label', `配色：${label}`);
    };
    ASH.on('theme:change', paintTheme);
    const el = h('div.side-foot', { 'data-m': 'side-4' }, git, chat, helper, theme,
      h('button.ico', { type: 'button', 'aria-label': '收起侧边栏', 'data-tip': '收起侧边栏', 'data-key': '⌘B', onclick: () => ASH.todo('收起侧栏') }, icon('sidebar')));

    /* ---------- 弹在这一行上面的那一层 ---------- */
    const push = h('em.num');
    const tool = (label, glyph, what) => h('button.ico', { type: 'button', 'aria-label': label, 'data-tip': label, onclick: () => ASH.todo(what) }, icon(glyph));
    const input = h('input', { type: 'text', placeholder: '搜索分支…', 'aria-label': '搜索分支', autocomplete: 'off', spellcheck: 'false' });
    const list = h('div.menu.side-sheet-list', { role: 'listbox', 'aria-label': '分支' });
    const sheet = h('div.side-sheet', { role: 'dialog', 'aria-label': '项目 Git' },
      h('header.side-sheet-head', {}, h('label.side-pm-find', {}, icon('search'), input),
        tool('更新', 'redo', '更新之后的样子'), tool('拉取', 'down', '拉取之后的样子'), h('span.side-sheet-push', {}, tool('推送', 'up', '推送之后的样子'), push)),
      list,
      h('a.side-sheet-go', { href: '#/git', onclick: () => rise(false) }, h('span', '打开 Git 工作台'), icon('chev', 'sm')),
      h('p.side-sheet-note', '主仓是所有任务共用的：切了分支，新建的任务就从它起。'));
    const layer = h('div.side-rise', { hidden: true }, sheet);

    function checkout(branch) {
      cur = branch;
      paintGit();
      rise(false);
    }
    function draw() {
      const q = input.value.trim().toLowerCase();
      const hit = BRANCHES.filter((b) => !q || b.name.toLowerCase().includes(q));
      push.textContent = cur.up ? String(cur.up) : '';
      list.replaceChildren(...(hit.length ? hit.map((b) => {
        const on = b === cur;
        return h(`button${b.held ? '.is-disabled' : ''}`, { type: 'button', role: 'option', 'aria-selected': String(on), 'aria-disabled': b.held ? 'true' : null, 'data-tip': b.held ? '有任务的工作区正用着这个分支' : null,
          onclick: () => { if (b.held) return; if (on) rise(false); else checkout(b); } }, h('span.cut', b.name), h('em.num', tail(b)));
      }) : [h('p.none', '没有匹配的分支')]));
    }
    input.addEventListener('input', draw);
    sheet.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const stops = [input, ...$$('button:not(.is-disabled)', list)];
      e.preventDefault();
      stops[(stops.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : stops.length - 1)) % stops.length]?.focus();
    });

    /* 升、落：那张卡只动位置（transform），外面那一层只管把它裁在底部那一行以上、再把后面的任务树压暗一点。落下去之后整层摘掉，Tab 走不进去。
       分支那颗键自己管开合，所以它不算「点别处」 */
    const outside = (e) => { if (!sheet.contains(e.target) && !git.contains(e.target)) rise(false); };
    const key = (e) => { if (e.key === 'Escape' && !document.querySelector('.pop')) { e.stopPropagation(); rise(false); git.focus({ preventScroll: true }); } };
    function rise(next) {
      if (up === next) return;
      up = next;
      git.setAttribute('aria-expanded', String(up));
      clearTimeout(leaving);
      if (up) {
        ASH.closePop();
        input.value = '';
        draw();
        layer.style.bottom = `${el.offsetParent.clientHeight - el.offsetTop}px`;
        layer.hidden = false;
        void layer.offsetWidth;
        layer.classList.add('is-up');
        addEventListener('pointerdown', outside, true);
        addEventListener('keydown', key, true);
        input.focus({ preventScroll: true });
      } else {
        const inside = sheet.contains(document.activeElement);
        layer.classList.remove('is-up');
        removeEventListener('pointerdown', outside, true);
        removeEventListener('keydown', key, true);
        leaving = setTimeout(() => { layer.hidden = true; }, ASH.reduced() ? 0 : 220);
        if (inside) git.focus({ preventScroll: true });
      }
    }
    ASH.on('route', () => rise(false));

    paintGit();
    paintTheme();
    return { el, layer, chat, helper };
  };
})();
