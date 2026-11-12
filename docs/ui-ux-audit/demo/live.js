/* 执行中（部件 live）：把一轮从发出到落定演一遍。数据按 ash 真实的粒度来——
   正文是「攒够约 40 字」才来一块，工具只有一条「开始」、没有「结束」——动效都落在前端能做的那一侧：
   一行进行条（流光 + 用时，做完原地落定成过去式）、匀速放字 + 淡入、同一时刻只有一个「活的」信号。
   剧本在 live-scripts.js，数字和拆字在 live-words.js，进行条在 live-strip.js。这一轮跟着任务走，不跟着页面：切到别的面它照常往下跑（侧栏那一行照样变），回来接着看。
   对外：ASH.parts.live = { running, play(name, say), stop(), retry(), accept(), destroy() }，name 是 run / ask / fail / slow / squeeze / squeezeFail / stall / compact / watch / watchSay / agents；
   报告页隔着 iframe 递 { ash: 'play', name } 也能起一轮（正跑着的那一轮连同它留下的半截一起撤掉），{ ash: 'stop' } 是停；
   嵌在报告里时，等你答复那一刻往外递 { ash: 'title', waiting }，报告拿它改自己的标签页标题。
   发 run:state { running }（同时发 run:start / run:end）、agents:spawn（这一轮派出一个子智能体）、watch:hang / watch:wake（挂上一个哨兵、它回来一次；右侧面板的那两格接）、
   task:status { id, status, why }（等哨兵时是 paused、why 是「在等哨兵」）、task:resume { text }（它歇下来时留的续跑交代，空 = 没有了）、
   usage { turn, tokens, ctx, files, add, del, elapsedMs, commit? }（turn 是这一轮的用量，其余是跑完之后的总数，ctx 是上下文还剩百分之几；
   中途只报 { ctx } 是水位变了，{ squeezing } 是正在压缩 / 压完了）；
   听 reply:send / reply:stop / reply:steer（回复框）、task:act（任务头的重试 / 运行 / 继续）、watch:stop（不等了：会话里那一行或者哨兵格里点的）、
   review:start / review:done（审查那一行在会话里起、落）。 */
(() => {
  const { h, $, icon } = ASH;
  const TITLE = document.title;
  const STOP = 'stopped';
  const QUIT = 'quit';   /* 不等哨兵了：这一轮到此为止，台面已经收好 */
  const rand = (n) => Math.floor(Math.random() * n);
  const { plain, short, summarize, anyBad, atoms } = ASH.liveWords;
  /* 进场只演一次：演完把类摘掉，这个节点以后再被挂回页面（切走又回来）就不会重播 */
  const enter = (el) => {
    const done = (e) => { if (e.target !== el) return; el.classList.remove('enter'); el.removeEventListener('animationend', done); };
    el.classList.add('enter');
    el.addEventListener('animationend', done);
    return el;
  };

  const cur = ASH.data.cur;
  const after = (minutes) => new Date(Date.now() + minutes * 6e4).toTimeString().slice(0, 5);
  const { SCRIPTS, PREP } = ASH.liveScripts;

  const kit = ASH.feedKit;
  let run = null;     /* 正在跑的那一轮 */
  let last = 'run';   /* 上一次跑的是哪段：停掉之后点「运行」接着跑它 */
  let seq = 0;
  /* 剧本里 end 写的是这一轮多出来的量；报给面板的是总数。起点和右侧面板一开始画的数对得上 */
  const totals = { tokens: cur.use.claude.tokens + cur.use.codex.tokens, files: ASH.changes.rows.length, add: ASH.changes.sum('add'), del: ASH.changes.sum('del'), ctx: cur.remain };
  const rounds = [];   /* 跑完的每一轮报过的数：回到这一面时面板是新画的，照原样再报一遍 */
  /* 会话流不在页面上的时候（切到别的面了）：滚动的事不用做，新来的节点先记着，回来时会话流自己接上 */
  const feed = {
    follow: () => ASH.parts.feed?.follow?.(),
    pin: () => ASH.parts.feed?.pin?.(),
    unask: (then) => { if (ASH.parts.feed?.unask) ASH.parts.feed.unask(then); else then?.(); },
    append(...nodes) { run?.nodes.push(...nodes); if (ASH.parts.feed?.append) ASH.parts.feed.append(...nodes); else kit.kept.push(...nodes); },
  };
  /* 这一刻它在不在动：挂着提问、歇着等哨兵都不算（那时回复框的键是发送，不是停止） */
  const working = () => Boolean(run) && !run.waiting && !run.parked?.line;
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
  /* 等你答复时标签页标题前多一个 ●；嵌在报告里看不到自己的标题，递给外面那一页去改 */
  const waitingTitle = (on) => {
    document.title = on ? `● 等你答复 · ${TITLE}` : TITLE;
    if (parent !== window) parent.postMessage({ ash: 'title', waiting: on }, '*');
  };
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

  /* ---- 进行条在 live-strip.js。这里的钟多管一样：歇着等哨兵时，那一行「在等哨兵」后面等了多久 ---- */
  const strips = ASH.liveStrip({ now: () => run, claim, enter, follow: () => feed.follow() });
  const { open: openStrip, relabel, restate, settle } = strips;
  function tick() {
    const p = run?.parked;
    if (p?.line) p.line.time.textContent = ASH.dur(performance.now() - p.since);
    strips.tick();
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
      if (strip.list.childElementCount) { settle(strip); return; }
      clearTimeout(strip.pending);
      strip.btn.remove();
      strip.list.remove();
      r.flat = r.flat.filter((node) => node !== strip.btn && node !== strip.list);
      r.strip = null;
    };
    const md = h('div.md');
    /* 被哨兵叫醒过的回合：新的一段正文一出来，它前面的东西（上一段正文也在内）就并成一行 */
    const begin = () => { giveWay(); r.turn.body.append(md); r.flat.push(md); r.prose.push(md); claim(md, 'run-4'); if (r.woke) compact(md); };
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
  function openTurn() {
    const turn = kit.turn({ cause: run.cause });
    run.cause = null;
    turn.el.classList.add('is-live');
    Object.assign(run, { turn, strip: null, flat: [], prose: [], steps: [], t0: performance.now() });
    run.s0 = run.t0;   /* 进行条后面的用时从哪一刻算起：平时是回合开头；等哨兵时是开始等的那一刻，被叫醒以后是叫醒的那一刻 */
    feed.append(enter(turn.el));
  }

  async function play(name = 'run', say, { cause = null } = {}) {
    const script = SCRIPTS[name];
    if (run || !script) return;
    if (SCRIPTS[name].say) last = name;
    const r = (run = { name, cause, dead: false, steered: false, waits: new Map(), waiting: false, ask: null, answer: null, parked: null, aside: null, nodes: [], turn: null, strip: null, flat: [], prose: [], steps: [], t0: performance.now() });
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
      if (why === QUIT) return;
      if (r.steered) { if (r.turn?.el.classList.contains('is-live')) collapse(); release(); } else halt();
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
      if (ev.tool.spawn) ASH.emit('agents:spawn', ev.tool.spawn);
      if (ev.tool.hang) { r.hang = { ...ev.tool.hang, until: after(ev.tool.hang.limit) }; ASH.emit('watch:hang', ev.tool.hang); }
      feed.follow();
      await sleep(ev.ms);
      /* 这一步读进来的东西把上下文占掉了多少：右侧「信息」里的水位跟着走 */
      if (ev.ctx != null) { totals.ctx = ev.ctx; ASH.emit('usage', { ctx: ev.ctx }); }
    } else if (ev.text) {
      await stream(ev.text);
    } else if (ev.ask) {
      /* 停下来问你：这一回合到此收口，回复框回到空闲（这时在回复框里发话 = 撤下提问、当成普通消息发出） */
      collapse();
      r.waiting = true;
      r.ask = ev.ask;
      status('waiting', '等你答复');
      busy(false);
      waitingTitle(true);
      let got;
      try {
        got = await hold((done) => {
          r.answer = (said, card) => done({ text: said, card });
          showCard();
          return () => feed.unask();
        });
      } finally { waitingTitle(false); r.answer = null; r.waiting = false; }
      /* 提问卡沉下去和答复落进会话是同一段：卡往下走的那 320ms 里，会话带着新来的这一行一起落回贴底 */
      feed.pin();
      feed.unask(() => feed.append(enter(kit.user(got.text, '刚刚', got.card ? { quote: ev.ask.q, options: ev.ask.options } : {}))));
      busy(true);
      status('running');
      await sleep(350);
      openTurn();
    } else if (ev.watch) {
      await park(ev.watch);
    } else if (ev.meanwhile) {
      /* 中途插进来的事——压缩上下文、上游不回话在重试：不是它做的，也不是它说的，所以不进正文。
         进行条写着它，后面是这件事已经花了多久；过去了这一行接着往下走，外面什么都不留，只在执行过程里它发生的位置上记一行（kit.note）。
         没成的才留在外面：那一行是红的，摘要最后多半句（summarize 的 bad）。
         quiet = 这件事是你自己叫它做的（敲了 /compact）：做完它会回你一句，执行过程里就不再记这一行 */
      const m = ev.meanwhile;
      const squeeze = m.ctx != null;
      const strip = r.strip ?? openStrip(m.says[0]);
      r.s0 = performance.now();
      restate(strip, m.says[0], { still: m.still });
      claim(strip.btn, 'run-9');
      if (squeeze) ASH.emit('usage', { squeezing: true });
      feed.follow();
      try {
        for (const [i, said] of m.says.entries()) { if (i) relabel(strip, said); await sleep(m.ms / m.says.length); }
      } catch (why) { if (squeeze) ASH.emit('usage', { squeezing: false }); throw why; }
      if (m.fail) { const failed = { bad: m.fail }; strip.steps.push(failed); r.steps.push(failed); }
      if (!m.quiet) {
        const row = kit.note({ glyph: m.glyph, text: m.fail ?? m.done, tail: ASH.dur(performance.now() - r.s0), bad: Boolean(m.fail), why: m.why,
          act: m.act && { label: m.act, onclick: () => ASH.todo(`${m.act}之后的样子`) } });
        if (strip.open) row.classList.add('enter');
        strip.put(row);
      }
      if (squeeze) { if (!m.fail) totals.ctx = m.ctx; ASH.emit('usage', { squeezing: false, ctx: totals.ctx }); }
      r.s0 = performance.now();
      if (!m.quiet) restate(strip, '在想', { thinking: true });
      feed.follow();
    } else if (ev.fail) {
      /* 进行条原地落定成红色的一句；退出码收在点开的那一层。「重试」不挂在会话里：它在任务头上，是一颗图标 */
      const strip = r.strip ?? openStrip('这一轮异常结束');
      strip.put(h('p.step-note', `退出码 ${ev.fail}`));
      settle(strip, '这一轮异常结束', 'is-failed');
      claim(strip.btn, 'run-8');
      r.turn.setMeta(`${cur.model} · 刚刚 · ${ASH.dur(performance.now() - r.t0)}`);
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

  /* 把一串节点收进一行「执行过程」，放在 before 前面：步骤照搬，夹在中间的正文变成过程说明，原来那几行摘要不要了 */
  function pack(nodes, steps, before, time) {
    const fold = kit.fold(summarize(steps), [], { time });
    fold.btn.classList.toggle('has-bad', anyBad(steps));
    for (const node of nodes) {
      if (node.classList.contains('md')) { node.classList.add('said'); node.removeAttribute('data-m'); fold.put(node); }
      else if (node.classList.contains('steps')) { fold.put(...node.children); node.remove(); }
      else node.remove();
    }
    if (before) before.before(enter(fold.btn), fold.list); else run.turn.body.append(enter(fold.btn), fold.list);
    claim(fold.btn, 'run-5');
    return fold;
  }
  /* 被哨兵叫醒以后说的每一段话，都把它前面的东西并成一行（本来就只有一行的不动）。
     于是不管被叫醒多少次，回合里摊着的最多三样——之前的一行、最近说的那段话、正在走的进行条 */
  function compact(keep) {
    const r = run;
    const at = r.flat.indexOf(keep);
    if (at < 3) return;
    const fold = pack(r.flat.slice(0, at), r.steps, keep);
    r.flat = [fold.btn, fold.list, ...r.flat.slice(at)];
  }
  /* 回合收口：最后一段正文之前的东西收成一行。收起不带动画——它是系统替你收的；收完的那一行是淡入的，回合尾的操作淡入一次。
     收口不一定是结束：歇下来等哨兵也收一次（quiet：回合尾的操作不闪），被叫醒以后同一回合接着往下走，所以 flat 要跟着改成收完的样子 */
  function tidy() {
    const r = run;
    if (r.strip) settle(r.strip);
    const final = r.prose.at(-1);
    const hidden = r.flat.filter((node) => node !== final);
    const total = ASH.dur(performance.now() - r.t0);
    if (hidden.length === 2 && hidden[0].classList.contains('fold')) {
      /* 前面本来就只有一行「执行过程」：它已经是摘要了，原样留着，只补上（换上）用时 */
      $('.rt', hidden[0])?.remove();
      hidden[0].append(h('time.rt', total));
      claim(hidden[0], 'run-5');
    } else if (hidden.length) {
      const fold = pack(hidden, r.steps, final, total);
      r.flat = [fold.btn, fold.list, ...(final ? [final] : [])];
    }
  }
  function collapse(quiet) {
    const r = run;
    tidy();
    r.turn.setMeta(`${cur.model} · 刚刚 · ${ASH.dur(performance.now() - r.t0)}`);
    const acts = r.turn.acts;
    r.turn.el.classList.remove('is-live');
    feed.follow();
    if (quiet) return;
    void acts.offsetWidth;   /* 这一排刚从「不画」出来，先让它以透明的样子落一次，下面那句才有过渡可走 */
    acts.classList.add('is-shown');
    setTimeout(() => acts.classList.remove('is-shown'), 2400);
  }

  /* ---- 等哨兵：任务这时是暂停的 ----
     歇下来（rest）：回合收口，最近那一回合的最后多一行「在等哨兵…」，回复框回到空闲。这一轮（run）还留着：哨兵回来要接着它往下走。
     叫醒：那一行撤掉，同一回合里起一条进行条，头一步就是「等 哨兵…」（等了多久、等到了什么），然后接着做。
     这时你发话（interject）：那一行让位，你的话和它的回答另起一回合；哨兵照常跑。答完它还没回来，那一行回到新回合的最后，等了多久接着原来的数；
     答的时候它回来了，不打断，带回来的东西排着。
     叫醒接在哪：中间你没说过话，就接在等它的那一回合后面（被叫醒多少次都还是那一段）；你说过话，答你的那一回合不动，
     叫醒另起一回合，回合头名字后面写着「被哨兵叫醒」——你问的那句话的答案不会被后来的事盖掉 */
  function rest() {
    const r = run;
    const p = r.parked;
    collapse(true);
    p.line = kit.wait({ name: p.w.name, until: p.until, then: p.then, onquit: () => ASH.emit('watch:stop') });
    r.turn.body.append(enter(p.line.el));
    tick();
    status('paused', '在等哨兵');
    ASH.emit('task:resume', { text: p.then });   /* 右侧「信息」里的续跑指令：它留的那句交代 */
    busy(false);
    feed.follow();
    /* 排着的那条这时发出去：这一回合已经把话交还给你了。到时候它要是已经被叫醒了，那条就留在托盘里等下一次 */
    if (ASH.parts.reply?.hasQueued?.()) sleep(700).then(() => { const said = run === r && p.line && !r.aside && ASH.parts.reply.takeQueued(); if (said) interject(said); }, () => {});
  }
  function unwait() {
    const p = run?.parked;
    if (!p?.line) return;
    p.line.el.remove();
    p.line = null;
    ASH.emit('task:resume', {});
  }
  async function park(w) {
    const r = run;
    const p = (r.parked = { w, since: performance.now(), until: r.hang?.until, then: r.hang?.then, line: null, fired: false, dropped: false, said: false, drop: null });
    rest();
    if (w.you) sleep(w.you.at).then(() => interject(w.you.text), () => {});
    /* 样机里半小时按几秒演：你正往回复框里写字的时候，哨兵先不回来（最多让 30 秒），不然来不及试「等的时候发一句」 */
    const how = r.unwatched ? 'dropped' : await hold((done) => {
      let spare = 30;
      let id = setTimeout(function due() {
        if (spare-- > 0 && p.line && ASH.parts.reply?.value?.().trim()) id = setTimeout(due, 1000); else done('fired');
      }, w.ms);
      p.drop = () => { clearTimeout(id); done('dropped'); };
      return () => clearTimeout(id);
    });
    if (how === 'fired') { p.fired = true; ASH.emit('watch:wake', { title: w.name, lines: w.lines, exit: w.exit }); } else p.dropped = true;
    if (r.aside) await r.aside;   /* 它正在答你：哨兵带回来的东西排着，答完再接 */
    const took = ASH.dur(performance.now() - p.since);
    const resting = Boolean(p.line);   /* 歇着（那一行在）还是刚答完你（它回来的时候正忙着） */
    if (p.dropped) {
      /* 不等了：那一行原地落定成一句，留在这一回合的最后；任务留在暂停，等你点「继续」或者发话 */
      const line = p.line ?? kit.wait({ name: w.name });
      if (!resting) r.turn.body.append(line.el);
      line.quit(took);
      ASH.emit('task:resume', {});
      r.parked = null;
      release();
      if (!resting) busy(false);
      status('paused');
      feed.follow();
      throw QUIT;
    }
    unwait();
    r.parked = null;
    if (resting) { busy(true); status('running'); }
    if (p.said) { r.cause = { text: '被哨兵叫醒', onclick: () => ASH.emit('insp:open', { pane: 'watch' }) }; feed.pin(); openTurn(); }
    else r.turn.el.classList.add('is-live');
    r.s0 = performance.now();
    const strip = openStrip('在想', true);
    const stepped = { verb: '等', text: `哨兵「${w.name}」` };
    strip.steps.push(stepped);
    r.steps.push(stepped);
    strip.put(kit.watch({ name: w.name, took, exit: w.exit, lines: w.lines }).el);
    r.woke = true;
    feed.follow();
  }
  /* 等哨兵的时候你发了一句（或者点了任务头上的「继续」：没有气泡，回合头名字后面写着起因）。照 name 那段剧本答，剧本里的 end 不算——这一轮还没完 */
  function interject(text, { name = 'aside', cause = null } = {}) {
    const r = run;
    const p = r?.parked;
    if (!p?.line || r.aside || r.dead) return;
    p.said = true;
    const chain = (async () => {
      unwait();
      if (text) { feed.pin(); feed.append(enter(kit.user(text, '刚刚'))); }
      busy(true);
      status('running');
      if (text) await sleep(350);
      feed.pin();
      r.cause = cause;
      openTurn();
      for (const ev of SCRIPTS[name].events) if (!ev.end) await step(ev);
      if (p.fired || p.dropped) collapse(); else rest();
    })();
    const mine = (r.aside = chain.then(() => { r.aside = null; }, (why) => { r.aside = null; throw why; }));
    mine.catch(() => {});
  }

  /* 被停掉：正在做的那一行原地落定成「已停止」；正文出到一半的，在后面补这一行 */
  function halt() {
    const r = run;
    if (!r) return;
    unwait();
    if (r.turn?.el.classList.contains('is-live')) {
      settle(r.strip ?? openStrip('已停止'), '已停止');
      r.turn.setMeta(`${cur.model} · 刚刚 · ${ASH.dur(performance.now() - r.t0)}`);
    }
    finish('stopped');
  }

  /* 这一轮不再往下走：钟停掉、还在等的都收掉。任务的状态由调用的人定 */
  function release() {
    const r = run;
    clearInterval(r.clock);
    for (const undo of r.waits.values()) undo?.();
    r.waits.clear();
    r.dead = true;
    r.turn?.el.classList.remove('is-live');
    run = null;
    paintBtn();
    r.end();
  }
  function finish(state) {
    release();
    busy(false);
    status(state);
    feed.follow();
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
    play('again', undefined, { cause: { text: '重试' } });
  }
  /* 引导会话：正在跑的那一回合就地收住（已经出来的步骤折成一行），你的话接在它后面，再另起一回合。任务一直是「运行中」 */
  async function steer(msg = {}) {
    const r = run;
    if (!r || r.dead || r.waiting || r.parked?.line || !msg.text) return;
    msg.taken = true;
    r.steered = true;
    stop();
    await r.over;
    play('steer', msg.text);
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
  /* 验收是盖一枚章，不是换状态：做完的落成「验收完成」；失败、已取消的还是原来的状态，后面多半句「已验收」 */
  function accept() {
    if (run) return;
    const state = ASH.parts.head?.state ?? 'done';
    if (state === 'done') status('accepted'); else ASH.emit('task:status', { id: ASH.data.current, status: state, accepted: true });
    feed.pin();
    feed.append(enter(kit.mile({ tone: 'ok', text: `已验收，合并到 \`${cur.target}\``, note: '刚刚',
      log: [['验收前置命令通过', ''], [`\`${cur.branch}\` 合并进 \`${cur.target}\`，没有冲突`, ''], ['任务分支和它的工作区已清理', '']] })));
  }

  /* 审查那一行在会话里：起一轮时是活的一行（「审查中」带流光），出了结论原地落定。人不在这一面时照样记着 */
  const revRows = {};
  ASH.on('review:start', ({ round, by } = {}) => {
    const row = enter(kit.rev({ n: round, by }));
    revRows[round] = row;
    feed.pin();
    feed.append(row);
  });
  ASH.on('review:done', ({ round, post, repair } = {}) => {
    if (post) return;
    revRows[round]?.settle(ASH.review.rounds.find((r) => r.n === round));
    delete revRows[round];
    if (!repair) return;
    setTimeout(() => {
      if (run) return;
      play('fix', '', { cause: { text: `按第 ${round} 轮审查的意见改`, onclick: () => ASH.emit('insp:open', { pane: 'review', round }) } });
    }, 900);
  });

  /* ---- 部件：只管把这一面的按钮和事件接上。卸载时不停那一轮 ---- */
  ASH.part('live', {
    mount() {
      if (!ASH.parts.feed?.append) return {};
      const runBtn = $('#runBtn');
      const offs = [
        /* 你发话：挂着提问就是答复；在等哨兵就插进来；别的时候起一轮。敲的是 /compact 就演压缩那一段 */
        ASH.on('reply:send', ({ text } = {}) => {
          const cmd = /^\/compact\b/.test(text ?? '') ? 'compact' : null;
          if (run?.answer) run.answer(text);
          else if (run?.parked) interject(text, { name: cmd ?? 'aside' });
          else play(cmd ?? 'run', text);
        }),
        ASH.on('reply:stop', stop),
        ASH.on('reply:steer', steer),
        /* 不等了：正歇着就当场收；它这会儿在忙（刚被叫醒、还没再歇下来），记一笔，下次要等的时候就不等了 */
        ASH.on('watch:stop', () => { if (run?.parked) run.parked.drop(); else if (run) run.unwatched = true; }),
        ASH.on('task:act', ({ label } = {}) => {
          if (label === '重试') retry();
          else if (label === '运行') play(last, '');
          /* 继续：哨兵还在跑，它看一眼接着等；哨兵已经停了，它把停下来的地方交代一句 */
          else if (label === '继续' && run?.parked) interject('', { name: 'peek', cause: { text: '继续' } });
          else if (label === '继续') play('unwatched', '', { cause: { text: '继续' } });
        }),
      ];
      const pick = () => (run ? stop() : ASH.menu(runBtn, [
        { label: '跑一轮', icon: 'play', onpick: () => play('run') },
        { label: '跑到要你答复', icon: 'help', onpick: () => play('ask') },
        { label: '中途失败', icon: 'warn', onpick: () => play('fail') },
        '-',
        { label: '想得很久（17 秒）', icon: 'clock', onpick: () => play('slow') },
        { label: '中途压缩上下文', icon: 'squeeze', onpick: () => play('squeeze') },
        { label: '压缩没成', icon: 'squeeze', onpick: () => play('squeezeFail') },
        { label: '你敲 /compact', icon: 'squeeze', onpick: () => play('compact', '/compact') },
        { label: '上游不回话，重试三次', icon: 'redo', onpick: () => play('stall') },
        '-',
        { label: '中途挂哨兵等结果', icon: 'pulse', onpick: () => play('watch') },
        { label: '等哨兵的时候你插一句', icon: 'pulse', onpick: () => play('watchSay') },
        { label: '派子智能体分头查', icon: 'bot', onpick: () => play('agents') },
      ]));
      runBtn.hidden = false;
      runBtn.addEventListener('click', pick);
      paintBtn();
      /* 报告把这一列嵌在 iframe 里；file:// 下两边互相碰不到脚本，只能递消息 */
      const onMessage = (e) => { if (e.data?.ash === 'play' && SCRIPTS[e.data.name]) restart(e.data.name); else if (e.data?.ash === 'stop') stop(); };
      addEventListener('message', onMessage);
      /* 清单点到「执行中」的哪一条就演哪一段：正跑着的是别的段，先撤掉它再起 */
      for (const [id, name] of Object.entries(PREP)) ASH.prep[id] = () => { if (!run) play(name); else if (run.name !== name) restart(name); };
      /* 回到这一面时那一轮还在：回复框的键、提问卡、面板上的数字对上现在的样子 */
      if (working()) ASH.emit('run:state', { running: true });
      if (run?.waiting) showCard(true);
      for (const round of rounds) ASH.emit('usage', round);

      return {
        get running() { return working(); },
        play, stop, retry, accept,
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
