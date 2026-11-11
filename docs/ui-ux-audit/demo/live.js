/* 执行中（部件 live）：把一轮从发出到落定演一遍。数据按 ash 真实的粒度来——
   正文是「攒够约 40 字」才来一块，工具只有一条「开始」、没有「结束」——动效都落在前端能做的那一侧：
   一行进行条（流光 + 用时，做完原地落定成过去式）、匀速放字 + 淡入、同一时刻只有一个「活的」信号。
   这一轮跟着任务走，不跟着页面：切到别的面它照常往下跑（侧栏那一行照样变），回来接着看。
   对外：ASH.parts.live = { running, play(name, say), stop(), retry(), destroy() }，name 是 run / ask / fail / slow；
   报告页隔着 iframe 递 { ash: 'play', name } 也能起一轮（正跑着的那一轮连同它留下的半截一起撤掉），{ ash: 'stop' } 是停。
   发 run:state { running }（同时发 run:start / run:end）、task:status { id, status, why }、
   usage { turn, tokens, ctx, files, add, del, elapsedMs, commit? }（turn 是这一轮的用量，其余是跑完之后的总数，ctx 是上下文还剩百分之几）；
   听 reply:send / reply:stop（回复框）、head:act（任务头的停止 / 重试 / 运行 / 验收）。 */
(() => {
  const { h, $, icon } = ASH;
  const TITLE = document.title;
  const STOP = 'stopped';
  const rand = (n) => Math.floor(Math.random() * n);
  const plain = (s) => s.replace(/[`*]/g, '');
  const short = (s) => plain(s).replace(/[\w./-]*\/([\w.-]+)/g, '$1');
  /* 进场只演一次：演完把类摘掉，这个节点以后再被挂回页面（切走又回来）就不会重播 */
  const enter = (el) => {
    const done = (e) => { if (e.target !== el) return; el.classList.remove('enter'); el.removeEventListener('animationend', done); };
    el.classList.add('enter');
    el.addEventListener('animationend', done);
    return el;
  };

  /* 「读了 3 个文件，改了 1 个，跑了 1 条命令」：读、改按对象去重；相邻两段同一种东西时后一段省掉名词 */
  const KINDS = [['读', '个', '文件'], ['搜', '次', ''], ['改', '个', '文件'], ['跑', '条', '命令'], ['看网页', '个', '网页'], ['派', '个', '子智能体']];
  function summarize(steps) {
    if (!steps.length) return '想了一会儿';
    if (steps.length === 1) return `${steps[0].verb}了 ${plain(steps[0].text)}`;
    const parts = KINDS.map(([verb, unit, noun]) => {
      const mine = steps.filter((s) => s.verb === verb);
      return { verb, unit, noun, n: noun === '文件' ? new Set(mine.map((s) => s.text)).size : mine.length };
    }).filter((p) => p.n);
    const rest = parts.slice(3).reduce((sum, p) => sum + p.n, 0) + steps.filter((s) => !KINDS.some(([verb]) => verb === s.verb)).length;
    const said = parts.slice(0, 3).map((p, i, all) => `${p.verb}了 ${p.n} ${p.unit}${i && all[i - 1].noun === p.noun ? '' : p.noun}`);
    return said.join('，') + (rest ? `，另有 ${rest} 步` : '');
  }
  const thinkWord = (ms) => (ms >= 45000 ? '想了很久' : ms >= 15000 ? '还在想' : '在想');

  const TEST = { verb: '跑', text: '裁定闸的回归测试', fields: { 命令: 'npm -w server run test:free-review', 目录: 'server', 时限: '10 分钟' } };
  const SCRIPTS = {
    run: { say: '把这两条修复合成一个提交，再跑一遍回归。', events: [
      { think: 2400 },
      { tool: { verb: '读', text: '`server/src/free-review-reservations.ts`' }, ms: 900 },
      { tool: { verb: '读', text: '`server/scripts/test-free-review-ruling.ts`' }, ms: 1100 },
      { tool: { verb: '跑', text: '`git log --oneline -3`', fields: { 命令: 'git log --oneline -3', 目录: '.' } }, ms: 1200 },
      { text: '两条修复现在是两个提交：`b255e9ac` 和 `7c1d04e`。我把它们压成一个，说明里写清各自对应哪条审查意见，然后重跑回归。' },
      { tool: { verb: '跑', text: '`git reset --soft HEAD~2`' }, ms: 1100 },
      { tool: { verb: '跑', text: '`git commit`', fields: { 命令: 'git commit -m "裁定后保留预约；开审前重新检查资格"', 目录: '.' } }, ms: 1200 },
      { tool: TEST, ms: 3400 },
      { think: 1400 },
      { text: '合成了一个提交 `e41f7a2`：**裁定后保留预约，每次开审前重新检查资格**。\n\n回归测试 14 条全部通过。改动没有超出这两条意见的范围，可以直接验收。' },
      { end: { turn: 41800, files: 1, add: 12, del: 3, ctx: 3, commit: { hash: 'e41f7a2', text: '裁定后保留预约；开审前重新检查资格', squash: 2 } } },
    ] },
    ask: { say: '回归偶尔会挂，看一下是不是用例本身的问题。', events: [
      { think: 1800 },
      { tool: { verb: '读', text: '`server/scripts/test-free-review-ruling.ts`' }, ms: 1200 },
      { tool: { verb: '搜', text: '「Date.now」于 `server/scripts`', fields: { 查找: 'Date.now', 范围: 'server/scripts' } }, ms: 1000 },
      { text: '有一条用例依赖真实时钟：它等 50 毫秒后断言「已过期」，机器一忙就会差几毫秒。' },
      { ask: { q: '这条用例改成假时钟，还是把断言放宽？', options: ['改成假时钟', '把断言放宽到 ±1 秒'] } },
      { think: 1200 },
      { tool: { verb: '改', text: '`server/scripts/test-free-review-ruling.ts`' }, ms: 1300 },
      { tool: TEST, ms: 2400 },
      { text: '按你说的改好了，连跑 20 遍没有再挂。' },
      { end: { turn: 18600, files: 0, add: 8, del: 3, ctx: 2 } },
    ] },
    fail: { say: '再跑一遍回归。', events: [
      { think: 1500 },
      { tool: TEST, ms: 3200 },
      { fail: 1 },
    ] },
    slow: { say: '这个闸还有没有别的漏网的路径？仔细想想。', events: [
      { think: 17000 },
      { text: '想了一圈，还剩一条：任务被接力到另一台机器时，预约没有跟过去。这条我单独开一个任务记下来。' },
      { end: { turn: 9200, files: 0, add: 0, del: 0, ctx: 1 } },
    ] },
    /* 「重试」跑的那一轮：没有新的气泡，接着上一轮做 */
    again: { events: [
      { think: 1200 },
      { tool: TEST, ms: 2800 },
      { text: '这次过了，14 条全部通过。上一次是测试端口被别的进程占着，和这次的改动没有关系。' },
      { end: { turn: 6400, files: 0, add: 0, del: 0, ctx: 1 } },
    ] },
  };
  const PREP = { 'run-1': 'run', 'run-2': 'run', 'run-3': 'run', 'run-4': 'run', 'run-5': 'run', 'run-6': 'run', 'run-7': 'ask', 'run-8': 'fail' };

  /* 行内的 `代码` 和 **着重** 拆开：代码整颗出，其余一个字一个字放 */
  function atoms(text) {
    const out = [];
    for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
      if (!part) continue;
      if (part.startsWith('`')) out.push({ kind: 'code', s: part.slice(1, -1) });
      else if (part.startsWith('**')) out.push({ kind: 'b', s: part.slice(2, -2) });
      else out.push({ kind: 't', s: part });
    }
    return out;
  }

  const kit = ASH.feedKit;
  let run = null;     /* 正在跑的那一轮 */
  let last = 'run';   /* 上一次跑的是哪段：停掉之后点「运行」接着跑它 */
  let seq = 0;
  /* 剧本里 end 写的是这一轮多出来的量；报给面板的是总数。起点和右侧面板一开始画的数对得上 */
  const totals = { tokens: 48.9e6, files: 9, add: 371, del: 65, ctx: 65 };
  const rounds = [];   /* 跑完的每一轮报过的数：回到这一面时面板是新画的，照原样再报一遍 */
  /* 会话流不在页面上的时候（切到别的面了）：滚动的事不用做，新来的节点先记着，回来时会话流自己接上 */
  const feed = {
    follow: () => ASH.parts.feed?.follow?.(),
    pin: () => ASH.parts.feed?.pin?.(),
    unask: () => ASH.parts.feed?.unask?.(),
    append(...nodes) { run?.nodes.push(...nodes); if (ASH.parts.feed?.append) ASH.parts.feed.append(...nodes); else kit.kept.push(...nodes); },
  };
  const paintBtn = () => { const btn = $('#runBtn'); if (btn) btn.textContent = run ? '停止' : '运行一轮'; };

  /* 这一轮里所有的「等」都走 hold：停掉时一起收到 STOP；已经停掉的轮再来等，当场拒掉 */
  const hold = (arm) => new Promise((done, fail) => {
    const r = run;
    if (!r || r.dead) { fail(STOP); return; }
    const undo = arm((value) => { r.waits.delete(fail); done(value); });
    r.waits.set(fail, undo);
  });
  const sleep = (ms) => hold((done) => { const id = setTimeout(done, ms); return () => clearTimeout(id); });
  const status = (state, why) => ASH.emit('task:status', { id: ASH.data.current, status: state, why });
  const busy = (on) => { ASH.emit('run:state', { running: on }); ASH.emit(on ? 'run:start' : 'run:end', { id: ASH.data.current }); };
  /* 清单的圆圈跟着最新的那一处走 */
  const claimed = {};
  const marks = (el) => (el.dataset.m ?? '').split(' ').filter(Boolean);
  const claim = (el, ids) => {
    for (const id of ids.split(' ')) {
      const old = claimed[id];
      if (old && old !== el) { const rest = marks(old).filter((x) => x !== id); if (rest.length) old.dataset.m = rest.join(' '); else old.removeAttribute('data-m'); }
      claimed[id] = el;
    }
    el.dataset.m = [...new Set([...marks(el), ...ids.split(' ')])].join(' ');
  };

  /* ---- 进行条：就是那一行「执行过程」。同一时刻只有它或者正在出的正文是「活的」 ---- */
  function openStrip(text, thinking = false) {
    const strip = kit.fold(text);
    const now = performance.now();
    Object.assign(strip, { time: h('span.live-time.num'), steps: [], thinking, said: text, since: now, shownAt: now, pending: 0 });
    strip.btn.classList.add('is-live');
    strip.label.classList.add('shim');
    strip.label.after(strip.time);
    enter(strip.btn);
    run.turn.body.append(strip.btn, strip.list);
    run.flat.push(strip.btn, strip.list);
    run.strip = strip;
    claim(strip.label, 'run-2');   /* 两条认领在同一处会叠成一颗圆圈：「在想」认字，「跟着工具换标题」认这一行 */
    claim(strip.btn, 'run-3');
    tick();
    feed.follow();
    return strip;
  }
  /* 换标题：每条至少停 1 秒；积压了就只留最新的一条 */
  function relabel(strip, text) {
    clearTimeout(strip.pending);
    strip.said = text;
    strip.pending = setTimeout(() => { strip.shownAt = performance.now(); ASH.swap(strip.label, text); }, Math.max(0, strip.shownAt + 1000 - performance.now()));
  }
  /* 落定：流光停、用时收走，同一行换成过去式（或者你给的那句话） */
  function settle(strip, text, cls) {
    clearTimeout(strip.pending);
    strip.btn.classList.remove('is-live');
    strip.label.classList.remove('shim');
    if (cls) strip.btn.classList.add(cls);
    strip.time.remove();
    ASH.swap(strip.label, text ?? summarize(strip.steps));
    delete strip.btn.dataset.m;
    delete strip.label.dataset.m;
    if (run?.strip === strip) run.strip = null;
  }
  /* 用时过 2 秒才跟上来；「在想」过 15 秒换一次说法 */
  function tick() {
    const strip = run?.strip;
    if (!strip) return;
    const now = performance.now();
    if (now - run.t0 >= 2000) { strip.time.textContent = ASH.dur(now - run.t0); strip.time.classList.add('is-in'); }
    if (strip.thinking && thinkWord(now - strip.since) !== strip.said) relabel(strip, thinkWord(now - strip.since));
  }

  /* ---- 放字：来的是一坨一坨，放出去是匀的。每 40ms 放一点，积压越多放得越快；新放出的字 280ms 淡入，淡完把包着它的 span 拆掉 ---- */
  function put(host, node) {
    node.classList.add('w');
    node.addEventListener('animationend', () => { if (node.tagName === 'SPAN') node.replaceWith(...node.childNodes); else node.classList.remove('w'); }, { once: true });
    host.append(node);
  }
  async function stream(text) {
    const r = run;
    const paras = text.split('\n\n');
    const total = plain(text.replaceAll('\n\n', '')).length;
    /* 到达的节奏：40 到 70 个字一块，两块之间隔 0.26 到 0.68 秒 */
    const plan = [];
    for (let n = 0, at = 0; n < total; at += 260 + rand(420)) { n = Math.min(total, n + 40 + rand(30)); plan.push([at, n]); }
    const began = performance.now();
    const arrived = () => plan.reduce((n, [at, upto]) => (at <= performance.now() - began ? upto : n), 0);
    /* 正文一出，进行条就让位：只是「在想」的那条直接换成正文，做过事的那条原地落定 */
    const giveWay = () => {
      const strip = r.strip;
      if (!strip) return;
      if (strip.steps.length) { settle(strip); return; }
      clearTimeout(strip.pending);
      strip.btn.remove();
      strip.list.remove();
      r.flat = r.flat.filter((node) => node !== strip.btn && node !== strip.list);
      r.strip = null;
    };
    const md = h('div.md');
    const begin = () => { giveWay(); r.turn.body.append(md); r.flat.push(md); r.prose.push(md); claim(md, 'run-4'); };
    if (ASH.reduced()) {
      /* 减少动效：等这一段到齐，整段一次出现；到齐之前进行条照常在 */
      await sleep(plan.at(-1)[0]);
      begin();
      md.innerHTML = paras.map((para) => `<p>${kit.fmt(para)}</p>`).join('');
      feed.follow();
      await sleep(320);
      return;
    }
    begin();
    let shown = 0;
    for (const para of paras) {
      const p = h('p');
      const list = atoms(para);
      let host = p;
      let ai = 0;
      let ci = 0;
      md.append(p);
      while (ai < list.length) {
        let budget = Math.ceil((arrived() - shown) / 14);
        while (budget > 0 && ai < list.length) {
          const a = list[ai];
          if (a.kind === 'code') { put(p, h('code', a.s)); shown += a.s.length; budget -= a.s.length; ai++; continue; }
          if (a.kind === 'b' && ci === 0) { host = h('strong'); p.append(host); }
          const take = a.s.slice(ci, ci + budget);
          put(host, h('span', take));
          ci += take.length; shown += take.length; budget -= take.length;
          if (ci >= a.s.length) { ai++; ci = 0; host = p; }
        }
        feed.follow();
        await sleep(40);
      }
    }
    await sleep(280);
  }

  /* ---- 一轮 ---- */
  const retries = [];   /* 还挂在会话里的「重试」：重试一次就都收走 */
  function openTurn() {
    const turn = kit.turn({});
    turn.el.classList.add('is-live');
    Object.assign(run, { turn, strip: null, flat: [], prose: [], steps: [], t0: performance.now() });
    feed.append(enter(turn.el));
  }

  async function play(name = 'run', say) {
    const script = SCRIPTS[name];
    if (run || !script) return;
    if (name !== 'again') last = name;
    const r = (run = { name, dead: false, waits: new Map(), waiting: false, ask: null, answer: null, nodes: [], turn: null, strip: null, flat: [], prose: [], steps: [], t0: performance.now() });
    r.over = new Promise((done) => { r.end = done; });
    paintBtn();
    const text = say ?? script.say;
    if (text) {
      const bubble = enter(kit.user(text, '刚刚'));
      claim(bubble.firstElementChild, 'run-1');
      feed.pin();
      feed.append(bubble);
    }
    busy(true);
    status('running');
    r.clock = setInterval(tick, 250);
    try {
      if (text) await sleep(350);
      feed.pin();
      openTurn();
      for (const ev of script.events) await step(ev);
    } catch (why) {
      halt();
      if (why !== STOP) throw why;
    }
  }

  async function step(ev) {
    const r = run;
    if (ev.think) {
      if (!r.strip) openStrip('在想', true);
      await sleep(ev.think);
    } else if (ev.tool) {
      const doing = `正在${ev.tool.verb} ${short(ev.tool.text)}`;
      let strip = r.strip;
      if (strip) { strip.thinking = false; relabel(strip, doing); } else strip = openStrip(doing);
      strip.steps.push(ev.tool);
      r.steps.push(ev.tool);
      strip.add(ev.tool);
      feed.follow();
      await sleep(ev.ms);
    } else if (ev.text) {
      await stream(ev.text);
    } else if (ev.ask) {
      /* 停下来问你：这一回合到此收口，回复框回到空闲（这时在回复框里发话 = 撤下提问、当成普通消息发出） */
      collapse();
      r.waiting = true;
      r.ask = ev.ask;
      status('waiting', '等你答复');
      busy(false);
      document.title = `● 等你答复 · ${TITLE}`;
      let got;
      try {
        got = await hold((done) => {
          r.answer = (said, card) => done({ text: said, card });
          showCard();
          return () => feed.unask();
        });
      } finally { document.title = TITLE; r.answer = null; r.waiting = false; }
      feed.unask();
      feed.pin();
      feed.append(enter(got.card ? kit.answer({ ...ev.ask, text: got.text, time: '刚刚' }) : kit.user(got.text, '刚刚')));
      busy(true);
      status('running');
      await sleep(350);
      openTurn();
    } else if (ev.fail) {
      /* 进行条原地落定成红色的一句，「重试」紧跟在它后面；退出码收在点开的那一层 */
      const strip = r.strip ?? openStrip('这一轮异常结束');
      strip.put(h('p.step-note', `退出码 ${ev.fail}`));
      settle(strip, '这一轮异常结束', 'is-failed');
      const again = h('button.btn.sm.retry', { type: 'button', onclick: () => retry() }, icon('redo'), '重试');
      retries.push(again);
      strip.btn.after(again);
      claim(strip.btn, 'run-8');
      r.turn.setMeta(`claude-opus-5-5 · high · 刚刚 · ${ASH.dur(performance.now() - r.t0)}`);
      finish('failed');
    } else if (ev.end) {
      collapse();
      const d = ev.end;
      Object.assign(totals, { tokens: totals.tokens + d.turn, files: totals.files + d.files, add: totals.add + d.add, del: totals.del + d.del, ctx: Math.max(8, totals.ctx - d.ctx) });
      const round = { turn: d.turn, ...totals, elapsedMs: performance.now() - r.t0 };
      /* 同一个提交只记一次：再跑一遍这段剧本，不会又合掉两个 */
      if (d.commit && !rounds.some((old) => old.commit?.hash === d.commit.hash)) round.commit = d.commit;
      rounds.push(round);
      ASH.emit('usage', round);
      finish('done');
    }
  }

  /* 提问卡住在页面上：人不在这一面时先不画，回来再补（那时不滑，直接在位） */
  function showCard(instant) {
    const r = run;
    if (r?.waiting) ASH.parts.feed?.ask?.({ ...r.ask, instant, onanswer: (said) => r.answer?.(said, true) });
  }

  /* 回合收口：最后一段正文之前的东西收成一行。收起不带动画——它是系统替你收的；收完的那一行是淡入的，回合尾的操作淡入一次 */
  function collapse() {
    const r = run;
    if (r.strip) settle(r.strip);
    const final = r.prose.at(-1);
    const hidden = r.flat.filter((node) => node !== final);
    const total = ASH.dur(performance.now() - r.t0);
    if (hidden.length === 2 && hidden[0].classList.contains('fold')) {
      /* 前面本来就只有一行「执行过程」：它已经是摘要了，原样留着，只补上用时 */
      hidden[0].append(h('time.rt', total));
      claim(hidden[0], 'run-5');
    } else if (hidden.length) {
      const fold = kit.fold(summarize(r.steps), [], { time: total });
      for (const node of hidden) {
        if (node.classList.contains('md')) { node.classList.add('said'); node.removeAttribute('data-m'); fold.put(node); }
        else if (node.classList.contains('steps')) { fold.put(...node.children); node.remove(); }
        else node.remove();
      }
      r.turn.body.prepend(enter(fold.btn), fold.list);
      claim(fold.btn, 'run-5');
    }
    r.turn.setMeta(`claude-opus-5-5 · high · 刚刚 · ${total}`);
    const acts = r.turn.acts;
    r.turn.el.classList.remove('is-live');
    void acts.offsetWidth;   /* 这一排刚从「不画」出来，先让它以透明的样子落一次，下面那句才有过渡可走 */
    acts.classList.add('is-shown');
    setTimeout(() => acts.classList.remove('is-shown'), 2400);
    feed.follow();
  }

  /* 被停掉：正在做的那一行原地落定成「已停止」；正文出到一半的，在后面补这一行 */
  function halt() {
    const r = run;
    if (!r) return;
    if (r.turn?.el.classList.contains('is-live')) {
      settle(r.strip ?? openStrip('已停止'), '已停止');
      r.turn.setMeta(`claude-opus-5-5 · high · 刚刚 · ${ASH.dur(performance.now() - r.t0)}`);
    }
    finish('stopped');
  }

  function finish(state) {
    const r = run;
    clearInterval(r.clock);
    for (const undo of r.waits.values()) undo?.();
    r.waits.clear();
    r.dead = true;
    r.turn?.el.classList.remove('is-live');
    run = null;
    paintBtn();
    busy(false);
    status(state);
    feed.follow();
    r.end();
    /* 排着的那条只在这一轮正常结束后接着发；你自己停掉的，它留在原地等你 */
    const queued = state === 'done' ? ASH.parts.reply?.takeQueued?.() : null;
    if (queued) setTimeout(() => play('run', queued), 700);
  }

  function stop() {
    const r = run;
    if (!r || r.dead) return;
    r.dead = true;
    const waits = [...r.waits];
    r.waits.clear();
    for (const [fail, undo] of waits) { undo?.(); fail(STOP); }
  }
  /* 重试：不发新的气泡，接着上一轮做 */
  function retry() {
    if (run) return;
    for (const btn of retries.splice(0)) btn.remove();
    play('again');
  }
  /* 换一段跑（报告页点了另一段）：正跑着的先停掉，它留下的半截一起撤走，台面上只剩新的这一段；连着点只认最后一次 */
  async function restart(name) {
    const mine = ++seq;
    const r = run;
    if (r) {
      stop();
      await r.over;
      for (const node of r.nodes) node.remove();
      kit.kept = kit.kept.filter((node) => !r.nodes.includes(node));
      kit.changed?.();
    }
    if (mine === seq) play(name);
  }
  function accept() {
    if (run) return;
    status('accepted');
    feed.pin();
    feed.append(enter(kit.sys({ tone: 'ok', text: '已合并到 `main`', more: '3 条记录', time: '刚刚',
      log: [['验收前置命令通过', ''], ['`ash/QsjSuz_e` 合并进 `main`，没有冲突', ''], ['任务分支和它的工作区已清理', '']] })));
  }


  /* ---- 部件：只管把这一面的按钮和事件接上。卸载时不停那一轮 ---- */
  ASH.part('live', {
    mount() {
      if (!ASH.parts.feed?.append) return {};
      const runBtn = $('#runBtn');
      const offs = [
        ASH.on('reply:send', ({ text } = {}) => { if (run?.answer) run.answer(text); else play('run', text); }),
        ASH.on('reply:stop', stop),
        ASH.on('head:act', ({ label } = {}) => {
          if (label === '停止') stop();
          else if (label === '重试') retry();
          else if (label === '运行' || label === '继续') play(last, '');
          else if (label === '验收') accept();
        }),
      ];
      const pick = () => (run ? stop() : ASH.menu(runBtn, [
        { label: '跑一轮', icon: 'play', onpick: () => play('run') },
        { label: '跑到要你答复', icon: 'help', onpick: () => play('ask') },
        { label: '中途失败', icon: 'warn', onpick: () => play('fail') },
        { label: '想得很久（17 秒）', icon: 'clock', onpick: () => play('slow') },
      ]));
      runBtn.hidden = false;
      runBtn.addEventListener('click', pick);
      paintBtn();
      /* 报告把这一列嵌在 iframe 里；file:// 下两边互相碰不到脚本，只能递消息 */
      const onMessage = (e) => { if (e.data?.ash === 'play' && SCRIPTS[e.data.name]) restart(e.data.name); else if (e.data?.ash === 'stop') stop(); };
      addEventListener('message', onMessage);
      for (const [id, name] of Object.entries(PREP)) ASH.prep[id] = () => { if (!run) play(name); };
      /* 回到这一面时那一轮还在：回复框的键、提问卡、面板上的数字对上现在的样子 */
      if (run && !run.waiting) ASH.emit('run:state', { running: true });
      if (run?.waiting) showCard(true);
      for (const round of rounds) ASH.emit('usage', round);

      return {
        get running() { return Boolean(run) && !run.waiting; },
        play, stop, retry,
        destroy() {
          seq++;
          for (const off of offs) off();
          removeEventListener('message', onMessage);
          runBtn.removeEventListener('click', pick);
          runBtn.hidden = true;
          for (const id of Object.keys(PREP)) delete ASH.prep[id];
        },
      };
    },
  });
})();
