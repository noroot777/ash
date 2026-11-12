/* 回复框（部件 reply）。发送键是公共的那一颗（sendkey.js）；「再审 / 预约复审 / 审查中」那颗键读的是 ASH.review。
   回复框发出的事件：reply:send { text, files }（空闲时发）、reply:queue { text }（运行中发，进托盘）、reply:later { text, mode }（定时 / 等任务，进托盘）、
     reply:steer { text, taken }（引导会话：接的人把 taken 置 true）、reply:stop、reply:preview { open }。
     听的事件：run:state { running }、task:status { id, status }、review:change。
   回复框的方法：el、key（它的发送键）、value()、set(text)、clear()、focus()、takeQueued()、hasQueued()、destroy()。 */
(() => {
  const { h, icon } = ASH;
  ASH.icons.stopc = '<circle cx="8" cy="8" r="5.5"/><rect x="6" y="6" width="4" height="4" rx=".8"/>';
  const STUCK = { failed: '失败', stopped: '已取消' };
  const two = (n) => String(n).padStart(2, '0');
  const clock = (at) => { const d = new Date(at); return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };

  /* ---------- 回复框 ---------- */
  const FILES = [['回归截图.png', 248e3], ['later-send.log', 12e3], ['补发前后对比.png', 391e3]];
  /* 敲 / 出命令与技能，敲 @ 出智能体与文件：[填进去的字, 说明, 图标] */
  const SLASH = [['/team', '派一支团队来做', 'team'], ['/duet', '找两个智能体讨论', 'chat'], ['/compact', '压缩上下文', 'box'], ['/review', '让它自查一遍', 'search'], ['/code-review', '技能 · 代码审查', 'spark']];
  const AT = [['@codex', '召唤 codex 接着做', 'bot'], ['@gemini', '召唤 gemini 接着做', 'bot'], ['@server/src/later-send.ts', '引用文件', 'file'], ['@server/src/later-send-recover.ts', '引用文件', 'file']];
  /* 底排两颗会换字的键各自最长能写成什么：放不放得下按最长的量，开跑、开审都不会让整排换形 */
  const LONGEST = { review: ['已预约复审', '审查新改动', '审查中 2/2'], preview: ['启动中·点此取消'] };
  const ROW_ICON = { queue: 'queue', timed: 'clock', after: 'sand' };
  const LOG = ['$ npm -w web run dev -- --port 5174', '', '  VITE v6.0.3  ready in 412 ms', '', '  ➜  Local:   http://localhost:5174/', '  ➜  Network: use --host to expose',
    '', '14:02:11 [vite] hmr update /src/reply/LaterRow.tsx', '14:02:36 [vite] hmr update /src/reply/later-row.css', '14:05:02 [vite] page reload src/reply/later-send-copy.ts'];
  const LINE = 20;   /* 输入区行高，和 reply.css 里的 textarea 对齐 */
  const MIN = 74;    /* 三行：20 × 3 + 上下内边距 14 */
  const size = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
  let fileNo = 0;
  let probe = null;
  /* 每 1px 字号对应多高的字形：用画布量真实字形，不拿行盒算（大写字母没有下伸部）。照 components/AgentPlate.tsx */
  function inkPer(style, text) {
    probe ??= document.createElement('canvas').getContext('2d');
    if (!probe) return 0.73;
    probe.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const m = probe.measureText(text);
    const ink = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    return ink > 0 ? ink / (parseFloat(style.fontSize) || 1) : 0.73;
  }

  /* 截图批注、预览日志开的那种对话框：走公共的那一层（ASH.sheet）。acts(close) 给出底下那排按钮 */
  function sheet(title, body, acts) {
    const dlg = h('div.dlg.reply-dlg', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', title), body);
    const close = ASH.sheet(dlg);
    dlg.append(h('div.dlg-acts', acts(close)));
    dlg.querySelector('button:not([disabled])')?.focus();
    return dlg;
  }
  let ruler = null;
  const widest = (el, labels) => {
    ruler ??= document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(el);
    ruler.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return Math.ceil(Math.max(...labels.map((label) => ruler.measureText(label).width)));
  };

  ASH.part('reply', {
    mount(el, ctx) {
      const task = ASH.data.tasks.find((t) => t.id === ASH.data.current);
      const first = ASH.AGENTS[ctx?.agent ?? task?.agent] ? (ctx?.agent ?? task.agent) : 'claude';
      let who = { agent: first, model: ASH.AGENTS[first].models[0], level: 'high' };
      let running = Boolean(ctx?.running ?? ASH.parts.live?.running);
      let uploading = 0;
      let pinned = null;      /* 拖出来的高度；null = 跟着行数长 */
      let preview = 'off';    /* off / starting / on */
      let logged = false;     /* 预览起过：从这时起「更多」里才有预览日志 */
      let previewTimer = 0;
      let rehearsal = 0;
      const queue = [];
      const files = [];

      /* 水印：最底层，写着这一回合由谁来跑；换智能体时换词并重播进场。字号按框实测求解：字宽、字形高各占框的八成，取紧的那个。
         对照清单的圆圈要落在字上，所以另放一个不可见的框（mark）套住字形本身，水印自己的值一个不动。 */
      let word = h('span', who.agent);
      const mark = h('i', { 'data-m': 'reply-keep' });
      const plate = h('div.reply-plate', { 'aria-hidden': 'true' }, word, mark);
      function fit() {
        const style = getComputedStyle(word);
        const widthPer = word.offsetWidth / (parseFloat(style.fontSize) || 1);
        if (!widthPer) return;
        const next = Math.max(12, Math.min((box.clientWidth * 0.8) / widthPer, (box.clientHeight * 0.8) / inkPer(style, word.textContent)));
        plate.style.setProperty('--plate-size', `${next}px`);
        mark.style.width = `${widthPer * next}px`;
        mark.style.height = `${inkPer(style, word.textContent.toUpperCase()) * next}px`;
      }
      function setWord(name) { const next = h('span', name); word.replaceWith(next); word = next; fit(); }

      const ta = h('textarea', { rows: '3', placeholder: '回复…', 'aria-label': '回复任务', 'data-m': 'reply-1' });
      const tray = h('div.reply-list', { role: 'list', 'aria-label': '待发送消息' });
      const shelf = h('div.reply-list', { role: 'list', 'aria-label': '附件' });
      const key = ASH.sendKey({ onsend: send, onstop: stop, onlayout: () => fitActs() });
      key.opt.dataset.m = 'reply-2';
      key.main.dataset.m = 'reply-4 run-1';
      /* 三段胶囊：改的是这个任务以后都由谁跑；换智能体时水印跟着换词 */
      const caps = ASH.target({ value: who, label: '这个任务以后由谁来跑', place: 'top-start', onchange: (next) => {
        const swapped = next.agent !== who.agent;
        who = next;
        if (swapped) setWord(next.agent);
      } });

      /* ---------- 底排的动作：附件、派审、预览、接力在明面，截图批注和预览日志进「更多」 ---------- */
      const act = (name, onclick, attrs) => h('button.btn.quiet.sm', { type: 'button', onclick, ...attrs }, icon(name), h('span'));
      /* 这颗键写什么、点了开什么，都问 ASH.review：空闲是派审的对话框，任务在跑是预约，审查中是调轮数 */
      const reviewBtn = act('search', () => ASH.review.press(reviewBtn), { 'aria-haspopup': 'dialog' });
      /* 预览要起一会儿，这段时间里这颗键是「取消」 */
      const previewBtn = act('monitor', () => {
        clearTimeout(previewTimer);
        if (preview === 'off') {
          preview = 'starting';
          logged = true;
          previewTimer = setTimeout(() => { preview = 'on'; paintActs(); ASH.emit('reply:preview', { open: true }); }, 1600);
        } else {
          if (preview === 'on') ASH.emit('reply:preview', { open: false });
          preview = 'off';
        }
        paintActs();
      });
      /* 预览跑起来以后才有：直接开那一页 */
      const pageLink = h('button.btn.quiet.sm', { type: 'button', hidden: true, 'data-tip': 'localhost:5174', onclick: () => ASH.todo('在浏览器里打开预览页') }, icon('ext'), h('span', '预览页'));
      const handBtn = act('send', () => ASH.todo('接力对话框'), { 'aria-haspopup': 'dialog', 'aria-label': '接力到…', 'data-tip': '把这个任务移到另一台机器接着跑' });
      handBtn.lastChild.textContent = '接力到…';
      /* 等请求回来的那一种：图标的位置上转圈，字照常 */
      const busyIcon = (btn, on, name) => { btn.classList.toggle('is-busy', on); btn.firstChild.replaceWith(on ? h('i.spin') : icon(name)); };
      function paintActs(quick) {
        const set = (btn, label, tip) => {
          if (quick) btn.lastChild.textContent = label; else ASH.swap(btn.lastChild, label, { row: acts });
          btn.setAttribute('aria-label', label);
          if (tip) btn.dataset.tip = tip; else delete btn.dataset.tip;
        };
        const k = ASH.review.key();
        set(reviewBtn, k.text, k.tip);
        busyIcon(reviewBtn, Boolean(k.busy), 'search');
        reviewBtn.disabled = Boolean(k.off);
        reviewBtn.setAttribute('aria-pressed', String(Boolean(k.armed)));
        if (preview === 'on') set(previewBtn, '关闭预览', '停掉预览服务');
        else if (preview === 'starting') set(previewBtn, '启动中·点此取消', '不等了，取消启动');
        else set(previewBtn, '打开预览', '把这次改动跑起来看');
        busyIcon(previewBtn, preview === 'starting', preview === 'on' ? 'stopc' : 'monitor');
        previewBtn.setAttribute('aria-pressed', String(preview === 'on'));
        previewBtn.disabled = running && preview === 'off';   /* 有回合在改代码时不让起预览；已经起了的照样关得掉 */
        if (pageLink.hidden !== (preview !== 'on')) ASH.flip(acts, () => { pageLink.hidden = preview !== 'on'; });
      }

      const copy = (text) => { try { navigator.clipboard?.writeText(text)?.catch(() => {}); } catch { /* file:// 下可能没有剪贴板 */ } };
      const showLog = () => sheet('预览日志', h('pre.reply-log', { tabindex: '0', 'aria-label': '预览日志' }, LOG.join('\n')), (close) => [
        h('button.btn', { type: 'button', onclick: () => copy(LOG.join('\n')) }, icon('copy'), '复制'),
        h('button.btn', { type: 'button', onclick: () => close() }, '关闭')]);
      /* 截图批注：选一张图（粘贴或上传），在图上点出几处意见，连同标注图单独发成一条回复 */
      function annotate() {
        let count = 0;
        const input = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => { if (input.files[0]) show(input.files[0]); } });
        const stage = h('div.reply-shot', h('b', '选一张截图，开始圈画'), h('p', '直接粘贴图片（⌘V），或从电脑上传。'),
          h('button.btn', { type: 'button', onclick: () => input.click() }, icon('image'), '选择图片'), input);
        const say = h('p');
        const sendBtn = h('button.btn.pri', { type: 'button', disabled: true }, running ? '排队发送批注' : '发送批注');
        function show(file) {
          const board = h('button.reply-shot-img', { type: 'button', 'aria-label': '在图上点一下，加一处意见' }, h('img', { src: URL.createObjectURL(file), alt: file.name }));
          board.addEventListener('click', (e) => {
            const r = board.getBoundingClientRect();
            const at = e.detail ? [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] : [0.5, 0.5];   /* 键盘点的落在正中 */
            board.append(h('i.enter', { style: { left: `${at[0] * 100}%`, top: `${at[1] * 100}%` } }, String(++count)));
            say.textContent = `${count} 条意见 + 1 张标注图，将单独回复给 ${who.agent}`;
            sendBtn.disabled = false;
          });
          stage.replaceChildren(board, say);
          board.focus();
        }
        const dlg = sheet('截图批注', stage, (close) => {
          sendBtn.onclick = () => { close(); post(`截图批注：${count} 条意见，附 1 张标注图`); };
          return [h('button.btn', { type: 'button', onclick: () => close() }, '关闭'), sendBtn];
        });
        dlg.addEventListener('paste', (e) => {
          const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
          if (file) { e.preventDefault(); show(file); }
        });
      }
      const clipBtn = h('button.ico', { type: 'button', 'aria-label': '上传附件', 'data-tip': '上传附件，也可直接粘贴', onclick: () => attach() }, icon('clip'));
      const moreBtn = h('button.ico', { type: 'button', 'aria-label': '更多', 'aria-haspopup': 'menu', 'data-tip': '更多',
        onclick: () => ASH.menu(moreBtn, [{ label: '截图批注', icon: 'edit', onpick: annotate }, logged && { label: '预览日志', icon: 'term', onpick: showLog }].filter(Boolean), { place: 'top-start' }) }, icon('more'));

      /* 顶边的拖动条：往上拖把输入区拉高，双击回到跟着行数长；方向键也能调。照 task-detail/ReplyResizeHandle.tsx */
      const ceiling = () => Math.max(MIN, Math.min(560, innerHeight - 260));
      const pinTo = (px) => { pinned = px == null ? null : Math.max(MIN, Math.min(ceiling(), Math.round(px))); grow(); };
      const grip = h('div.reply-grip', { role: 'separator', tabindex: '0', 'aria-orientation': 'horizontal', 'aria-label': '拖动调整回复框高度，双击恢复按输入行数自动撑高',
        ondblclick: () => pinTo(null),
        onpointerdown: (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const from = ta.offsetHeight + e.clientY;
          const move = (next) => pinTo(from - next.clientY);
          grip.classList.add('is-on');
          addEventListener('pointermove', move);
          addEventListener('pointerup', () => { grip.classList.remove('is-on'); removeEventListener('pointermove', move); }, { once: true });
        },
        onkeydown: (e) => {
          const to = { ArrowUp: ta.offsetHeight + 10, ArrowDown: ta.offsetHeight - 10, Home: MIN, End: ceiling() }[e.key];
          if (to == null) return;
          e.preventDefault();
          pinTo(to);
        } });

      const spacer = h('span.grow');
      const acts = h('div.reply-acts', { 'data-m': 'reply-3' }, clipBtn, reviewBtn, previewBtn, pageLink, handBtn, moreBtn, spacer, caps.el, key.el);
      /* 底排放不下时按次序让：先把没有状态的动作收成图标（审查中、启动中、已预约这些有话要说的照样带字），
         再把胶囊收成只剩智能体，最后才换行。每次从最宽的样子量起，左右两组中间的空够用就停。
         够不够用按两颗会换字的键「最长能写成什么」算，不按此刻的字算：开跑、开审只换字，不会让整排换一次形 */
      const room = (btn, labels) => {
        const span = btn.lastChild;
        const need = widest(span, labels) + 6;
        return Math.max(0, need - (span.offsetWidth ? span.offsetWidth + 6 : 0));
      };
      function fitActs() {
        for (let level = 0; level < 4; level++) {
          acts.dataset.tight = level;
          if (level === 3 || spacer.offsetWidth > room(reviewBtn, LONGEST.review) + room(previewBtn, LONGEST.preview)) break;
        }
      }
      const box = h('div.reply-box.inbox', grip, plate, ta, acts);
      const root = h('div.reply', h('div.reply-col', tray, shelf, box));

      /* ---------- 输入区：三行起步，随内容长到最多 12 行（且不过窗口的四成）；拖过就以拖的为准 ---------- */
      function grow() {
        ta.style.height = 'auto';
        const full = ta.scrollHeight;
        const next = pinned ?? Math.min(full, LINE * 12 + 14, Math.max(MIN, Math.round(innerHeight * 0.4)));
        ta.style.height = `${next}px`;
        ta.style.overflowY = full > next ? 'auto' : 'hidden';
      }
      const sync = () => key.update({ empty: !ta.value.trim() && !files.some((file) => !file.timer), running, uploading: uploading || false });
      ta.addEventListener('input', () => { grow(); sync(); });
      ta.addEventListener('input', suggest);
      ta.addEventListener('keydown', (e) => {
        if (hint && !e.isComposing) {
          const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
          if (step) { e.preventDefault(); hint.at = (hint.at + step + hint.items.length) % hint.items.length; lightHint(); return; }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickHint(hint.items[hint.at]); return; }
        }
        if (ASH.sendKey.hit(e)) { e.preventDefault(); key.submit(); }
      });
      ta.addEventListener('paste', (e) => {
        const file = e.clipboardData?.files?.[0];
        if (file) { e.preventDefault(); attach(file.name, file.size); }
      });

      /* ---------- 敲 / 和 @ 出的那张浮层：锚在输入框上，焦点不离开输入框。上下键挪，回车或 Tab 选，Esc 收 ---------- */
      let hint = null;
      const lightHint = () => [...hint.list.children].forEach((btn, i) => { btn.dataset.active = String(i === hint.at); if (i === hint.at) btn.scrollIntoView({ block: 'nearest' }); });
      function pickHint([name]) {
        const head = ta.value.slice(0, ta.selectionStart).replace(/[/@][^\s]*$/, `${name} `);
        ta.value = head + ta.value.slice(ta.selectionStart);
        ta.setSelectionRange(head.length, head.length);
        ASH.closePop();
        grow();
        sync();
        if (name === '/team' || name === '/duet') ASH.todo('派生面板');
      }
      function suggest() {
        const token = /(?:^|\s)([/@][^\s]*)$/.exec(ta.value.slice(0, ta.selectionStart))?.[1];
        const items = token ? (token[0] === '/' ? SLASH : AT).filter(([name]) => name.toLowerCase().startsWith(token.toLowerCase())) : [];
        if (!items.length) { if (hint) ASH.closePop(); return; }
        const rows = items.map((item) => h('button', { type: 'button', role: 'option', tabindex: '-1', onpointerdown: (e) => e.preventDefault(), onclick: () => pickHint(item) }, icon(item[2]), h('span', item[0]), h('em', item[1])));
        if (hint) { hint.items = items; hint.at = 0; hint.list.replaceChildren(...rows); lightHint(); return; }
        const list = h('div.menu.reply-hint', { role: 'listbox', 'aria-label': token[0] === '/' ? '斜杠命令与技能' : '召唤智能体或引用文件' }, rows);
        if (!ASH.pop(box, list, { place: 'top-start', onclose: () => { hint = null; } })) return;
        hint = { list, items, at: 0 };
        lightHint();
      }

      /* ---------- 框上方的状态：待发送的消息、附件。没有就不占高度 ---------- */
      function addRow(list, host, item, parts) {
        item.row = h('div.reply-row', { role: 'listitem' }, parts);
        list.push(item);
        ASH.flip(host, () => host.append(item.row));
        return item;
      }
      function dropRow(list, item) {
        const i = list.indexOf(item);
        if (i < 0) return;
        list.splice(i, 1);
        clearTimeout(item.due);
        const host = item.row.parentElement;
        item.row.classList.add('is-out');
        setTimeout(() => { if (host?.isConnected) ASH.flip(host, () => item.row.remove()); }, ASH.reduced() ? 0 : 120);
        paintRows();
      }
      /* 现在就发：任务在跑就排队，空闲就直接发 */
      function post(text, names = []) {
        if (running) { hold('queue', text, { names }); ASH.emit('reply:queue', { text }); } else ASH.emit('reply:send', { text, files: names.map((file) => file.name) });
      }
      /* 引导会话：不等这一轮结束，把最早排着的那条现在就接进对话。没人接这个事件时自己把气泡放进会话，不让它凭空消失 */
      function steer(item) {
        dropRow(queue, item);
        if (!running) { ASH.emit('reply:send', { text: item.text, files: [] }); return; }
        const msg = { text: item.text, taken: false };
        ASH.emit('reply:steer', msg);
        const bubble = !msg.taken && ASH.feedKit?.user?.(item.text, '刚刚');
        if (!bubble) return;
        bubble.classList.add('enter');
        ASH.parts.feed?.pin?.();
        ASH.parts.feed?.append?.(bubble);
      }
      function hold(kind, text, more = {}) {
        const item = { kind, text, names: [], ...more, status: more.task?.status };
        const withdraw = () => {
          dropRow(queue, item);
          api.set([item.text, ta.value].filter(Boolean).join('\n'));
          for (const file of item.names) attach(file.name, file.size, true);
          if (kind === 'after' || (kind === 'timed' && new Date(item.at).getTime() > Date.now())) key.set({ mode: kind, at: item.at ?? '', task: item.task ?? null });
          ta.focus();
        };
        item.when = h('small.cut.num');
        item.steer = h('button.btn.quiet.sm', { type: 'button', hidden: true, 'data-tip': '不等这一轮结束，现在就接进对话', onclick: () => steer(item) }, icon('chat'), '引导会话');
        item.now = h('button.btn.quiet.sm', { type: 'button', hidden: true, 'data-tip': '不再等它，现在发出', onclick: () => { dropRow(queue, item); post(item.text, item.names); } }, icon('send'), '直接发送');
        addRow(queue, tray, item, [icon(ROW_ICON[kind], 'sm'), h('span.cut.grow', text), item.when, item.steer, item.now,
          h('button.ico.sm', { type: 'button', 'aria-label': `撤回「${text}」，内容放回输入框`, 'data-tip': '撤回，放回输入框', onclick: withdraw }, icon('undo'))]);
        if (kind === 'timed') item.due = setTimeout(() => { dropRow(queue, item); post(text, item.names); }, Math.min(new Date(item.at).getTime() - Date.now(), 2 ** 31 - 1));
        paintRows();
      }
      /* 每一行右边那句话，和两颗只在特定时候出现的按钮：「引导会话」只在最早排队的那条上；「直接发送」只在等的任务不会再完成时 */
      function paintRows() {
        const head = queue.find((item) => item.kind === 'queue');
        for (const item of queue) {
          const stuck = item.kind === 'after' && STUCK[item.status];
          item.when.textContent = item.kind === 'queue' ? '排队中' : item.kind === 'timed' ? clock(item.at) : stuck ? `「${item.task.title}」${stuck}` : `等「${item.task.title}」完成`;
          item.when.classList.toggle('is-stuck', Boolean(stuck));
          item.steer.hidden = item !== head;
          item.now.hidden = !stuck;
        }
      }
      function attach(name, bytes, done) {
        if (uploading && !done) return;
        const [fileName, fileBytes] = name ? [name, bytes] : FILES[fileNo++ % FILES.length];
        const state = h('small.num', done ? size(fileBytes) : `上传中 1% · ${size(fileBytes)}`);
        const item = { name: fileName, size: fileBytes, timer: 0 };
        const remove = () => { if (item.timer) { clearInterval(item.timer); item.timer = 0; uploading = 0; } dropRow(files, item); sync(); };
        addRow(files, shelf, item, [icon(/\.(png|jpe?g|gif|webp)$/i.test(fileName) ? 'image' : 'file', 'sm'), h('span.cut.grow', fileName), state,
          h('button.ico.sm', { type: 'button', 'aria-label': `移除 ${fileName}`, 'data-tip': '移除', onclick: remove }, icon('x'))]);
        if (done) { sync(); return; }
        uploading = 1;
        item.timer = setInterval(() => {
          uploading = Math.min(100, uploading + 18);
          if (uploading < 100) { state.textContent = `上传中 ${uploading}% · ${size(fileBytes)}`; sync(); return; }
          clearInterval(item.timer);
          item.timer = 0;
          uploading = 0;
          ASH.swap(state, size(fileBytes));
          sync();
        }, 260);
        sync();
      }

      /* ---------- 发送与停止 ---------- */
      function send(mode, detail) {
        const body = ta.value.trim();
        const names = files.map((file) => ({ name: file.name, size: file.size }));
        const text = body || `[${names.length} 个附件]`;
        if (mode !== 'now') {
          hold(mode, text, { at: detail.at, task: detail.task, names });
          ASH.emit('reply:later', { text, mode });
          key.reset();
        } else post(text, names);
        for (const file of [...files]) dropRow(files, file);
        api.clear();
      }
      const setRunning = (next) => { running = next; paintActs(); sync(); };
      function stop() {
        ASH.emit('reply:stop');
        if (rehearsal) { clearTimeout(rehearsal); rehearsal = 0; setRunning(false); }
      }

      const api = {
        el: root,
        key,
        value: () => ta.value,
        set(next) { ta.value = next ?? ''; grow(); sync(); },
        clear() { api.set(''); },
        focus() { ta.focus(); },
        takeQueued() {
          const item = queue.find((it) => it.kind === 'queue');
          if (item) dropRow(queue, item);
          return item?.text ?? null;
        },
        hasQueued: () => queue.some((it) => it.kind === 'queue'),
        destroy() {
          for (const off of offs) off();
          for (const ob of [watch, tidy]) ob.disconnect();
          for (const id of [previewTimer, rehearsal, ...queue.map((item) => item.due)]) clearTimeout(id);
          for (const file of files) clearInterval(file.timer);
          delete ASH.prep['reply-2'];
          delete ASH.prep['reply-4'];
          delete ASH.prep['reply-5'];
        },
      };

      el.replaceChildren(root);
      const watch = new ResizeObserver(() => { fit(); fitActs(); });
      watch.observe(box);
      const tidy = new MutationObserver(fitActs);   /* 按钮上的字、键上的字、胶囊里的字一变就重量；它自己只改 data-tight，不会绕回来 */
      tidy.observe(acts, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-pressed', 'hidden'] });
      document.fonts?.ready.then(fit);
      const offs = [
        ASH.on('run:state', (state) => setRunning(Boolean(state?.running))),
        ASH.on('review:change', () => paintActs()),
        ASH.on('task:status', ({ id, status } = {}) => {
          if (id === ASH.data.current) return;
          for (const item of queue.filter((it) => it.kind === 'after' && it.task.id === id)) {
            item.status = status;
            if (status === 'done') { dropRow(queue, item); post(item.text, item.names); }
          }
          paintRows();
        }),
      ];
      /* 对照清单：发送设置、派审对话框要先打开；停止键要任务在跑才有——真跑一轮（没有执行模拟时自己演 4 秒） */
      ASH.prep['reply-2'] = () => key.open();
      ASH.prep['reply-5'] = () => { const k = ASH.review.key(); if (!k.off && !k.busy && !document.querySelector('.rv-dlg')) ASH.review.dialog(); };
      ASH.prep['reply-4'] = () => {
        if (running) return;
        if (ASH.parts.live?.play) { ASH.parts.live.play('run'); return; }
        setRunning(true);
        rehearsal = setTimeout(() => { rehearsal = 0; setRunning(false); }, 4000);
      };
      paintActs(true);
      grow();
      sync();
      return api;
    },
  });
})();
