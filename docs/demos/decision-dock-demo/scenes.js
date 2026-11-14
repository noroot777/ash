// 五个场面。每个场面给出：初始状态、会话怎么画、回复框怎么画、点了之后状态怎么变，以及现在线上的样子。
(() => {
  const { esc, icon, paras, turn, unfold, me, reviewer, foot, running, key } = window.P;
  const D = window.DEMO;
  const Dock = window.Dock;
  const shot = (file, width, caption) => `<figure><img src="before/${file}.webp" width="${width}" alt="${esc(caption)}" loading="lazy"><figcaption>${esc(caption)}</figcaption></figure>`;
  const anchor = (trigger, pop) => `<span class="anchor">${trigger}${pop}</span>`;

  // —— 它问你 ——
  const ask = {
    init: (ui) => { const q = D.ask[ui.askKind]; return { q, answers: q.items.map(() => ""), index: 0, sent: null }; },
    title: (st) => st.q.title,
    feed: (st) => turn({ agent: st.q.agent, fold: st.q.fold, body: `${paras(st.q.prose)}<p>${esc(st.q.context)}</p>` })
      + (st.sent ? me(st.sent, { fresh: st.fresh }) + running(st.q.agent, st.q.running, st.fresh) : ""),
    dock: (st) => (st.sent ? Dock.plain("回复…") : Dock.ask(st.q, st)),
    sync: (st, value) => { if (!st.sent) st.answers[st.index] = value; },
    act(name, data, st, api) {
      const items = st.q.items;
      if (name === "opt") { st.answers[st.index] = Dock.toggleOption(st.answers[st.index], items[st.index].options[+data.i]); api.focus(); }
      if (name === "step") { st.index = +data.i; api.focus(); }
      if (name === "send") {
        if (st.index < items.length - 1) { st.index += 1; api.focus(); return; }
        if (!st.answers.some((value) => value.trim())) return;
        const flat = (value) => value.trim().split("\n").join("；");
        st.sent = items.length === 1 ? st.answers[0].trim() : st.answers.map((value, i) => `${i + 1}. ${flat(value) || "（没答）"}`).join("\n");
        st.fresh = true;
      }
    },
    digit(n, st) { if (!st.sent && n <= st.q.items[st.index].options.length) return { name: "opt", data: { i: n - 1 } }; return null; },
    old: () => `<div class="shots">${shot("question", 620, "同一个问题出现三次：智能体的回复里说一遍，灰字引用抄一遍，卡片里再抄一遍。卡片自带一个输入框和一颗发送键，紧挨着下面的回复框和它的发送键。")}</div>`,
    moves: [
      ["青色边框、「需要你的答复」卡头、问号图标", "去掉。框顶多出几行现成答法，就是在等你答"],
      ["卡片里又抄一遍的问题", "只在会话里出现一次，是智能体那一回合的最后一段"],
      ["灰字「本回合以提问暂停，等待答复：…」", "去掉。它说的事，回复框已经在说"],
      ["卡片自己的输入框和「发送答复」", "就是回复框和它的发送键"],
      ["带框的选项、数字键勾选、可多选可改", "不带框的一行一个；数字键、多选、勾了落进输入框照旧"],
      ["多个问题的题号、上一题 / 下一题", "题号在题目那一行的右边；没到最后一题时发送键写「下一题」"],
      ["「收起答复卡，先看上文」", "不需要了：框顶只剩选项，不再挡住上文"],
    ],
  };

  // —— 等你裁定（含辩论）——
  const R = D.rule;
  const segsFor = (rounds) => [R.segs[0], R.segs[1], ...R.extra.slice(0, (rounds - 1) * 2), R.segs[2]];
  const sideName = (seg) => (seg.side === "reviewer" ? "审查者" : "执行者");
  function segHtml(seg, i, total, st, quotable) {
    const id = `seg${i}`;
    const quote = quotable ? key("quote", "quote", "用这段作要点", `data-i="${i}"`) : "";
    if (seg.side === "reviewer") {
      return reviewer({ id, text: seg.gist, say: true, tight: true, lane: seg.full, open: st.open.has(id), keys: quote,
        head: `<b>审查者</b><span>第 ${i + 1} / ${total} 段${seg.closing ? ` · 收尾，自述${seg.stance}` : ""}</span>` });
    }
    return turn({ agent: R.agent, keys: quote, fresh: st.freshSeg === i,
      body: `<p>${esc(seg.gist)}</p>${seg.full ? unfold({ id, label: "完整发言", chars: seg.chars, text: seg.full, open: st.open.has(id) }) : ""}` });
  }
  function speaking(seg, i, total) {
    return seg.side === "reviewer"
      ? reviewer({ text: "正在组织发言…", live: true, say: true, tight: true, head: `<b>审查者</b><span>第 ${i + 1} / ${total} 段</span>` })
      : turn({ agent: R.agent, body: `<div class="run-line"><span class="run-dot"></span>正在组织发言…</div>` });
  }
  const rule = {
    init(ui, api) {
      const st = { phase: ui.moment, shown: ui.moment === "debated" ? 3 : ui.moment === "debating" ? 1 : 0, choice: null, note: "", rounds: 1, open: new Set(), ruled: null, sentNote: "", said: [] };
      if (st.phase === "debating") rule.play(st, api);
      return st;
    },
    title: () => R.title,
    // 辩论一段一段往下走：说完一段换下一方，全部说完回到「等你裁定」。
    play(st, api) {
      const total = st.rounds * 2 + 1;
      const step = () => {
        st.freshSeg = st.shown;
        st.shown += 1;
        if (st.shown >= total) st.phase = "debated"; else api.later(step, 1700);
        api.render();
      };
      api.later(step, 1700);
    },
    feed(st) {
      const segs = segsFor(st.rounds);
      const dispute = R.dispute;
      let html = turn({ agent: R.agent, fold: R.work.fold, body: paras(R.work.prose) })
        + reviewer({ id: "verdict", text: R.verdict.text, head: R.verdict.head })
        + turn({ agent: R.agent, fold: dispute.fold, body: `<p>${esc(dispute.gist)}</p>`
          + unfold({ id: "reason", ...dispute.reason, open: st.open.has("reason") })
          + unfold({ id: "defer", ...dispute.defer, open: st.open.has("defer") }) });
      if (st.phase !== "ruled") html += foot(esc(R.openNote), { tone: "open" });
      if (st.phase === "ruled" && st.shown) {
        // 裁完了：整场辩论收成一行，想回看再点开。
        const open = st.open.has("debate");
        html += `<button type="button" class="fold is-past" data-act="toggle" data-id="debate" aria-expanded="${open}">${icon("chevron")}审查者和执行者辩了 ${st.shown} 段</button>`;
        if (open) html += `<div class="past" data-anim="past">${segs.slice(0, st.shown).map((seg, i) => segHtml(seg, i, segs.length, st, false)).join("")}</div>`;
      } else {
        html += segs.slice(0, st.shown).map((seg, i) => segHtml(seg, i, segs.length, st, st.phase === "debated")).join("");
        if (st.phase === "debating") html += speaking(segs[st.shown], st.shown, segs.length);
      }
      html += st.said.map((text) => me(text)).join("");
      if (st.ruled === "upheld") {
        html += (st.sentNote ? me(st.sentNote, { fresh: st.fresh }) : "")
          + foot(st.sentNote ? "照你这段接着改" : "你让它照第 1 轮报告接着改", { right: true, fresh: st.fresh })
          + running(R.agent, "正在读第 1 轮报告", st.fresh);
      }
      if (st.ruled === "withdrawn") html += foot("你裁定第 1、3 条作废，这一轮不用改了", { right: true, fresh: st.fresh });
      if (st.ruled === "deferred") html += foot(`第 1、3 条转给了新任务「<a href="#">${esc(R.deferredTask)}</a>」，还没开工`, { right: true, fresh: st.fresh });
      return html;
    },
    dock: (st) => Dock.rule(st, segsFor(st.rounds)),
    sync: (st, value) => { st.note = value; },
    act(name, data, st, api) {
      if (name === "choose") { st.choice = st.choice === data.kind ? null : data.kind; if (st.choice !== "debate") api.focus(); }
      if (name === "rounds") st.rounds = +data.n;
      if (name === "quote") {
        const seg = segsFor(st.rounds)[+data.i];
        const quoted = `〔${sideName(seg)}第 ${+data.i + 1} 段〕${seg.gist}`;
        st.note = st.note.trim() ? `${st.note.trimEnd()}\n\n${quoted}` : quoted;
        st.choice = "upheld";
        api.focus();
      }
      if (name === "send") {
        if (!st.choice) { if (st.note.trim()) { st.said.push(st.note.trim()); st.note = ""; } return; }
        if (st.choice === "debate") { st.phase = "debating"; st.shown = 0; st.choice = null; rule.play(st, api); return; }
        st.ruled = st.choice; st.sentNote = st.note.trim(); st.phase = "ruled"; st.choice = null; st.note = ""; st.fresh = true;
      }
    },
    dismiss(st) { if (st.choice) { st.choice = null; return true; } return false; },
    old: (ui) => (ui.moment === "open"
      ? `<div class="shots"><div class="shots-row">${shot("dispute-card", 420, "裁定在右侧「审查」格的这张卡上，会话里只有一颗「去裁定」把你送过来。四个出口各配一行说明。")}
          ${shot("debate-dialog", 500, "点「让双方辩论」弹出的确认框。")}</div>
          ${shot("upheld-dialog", 560, "点「让它接着改」弹出的确认框：要交代的话写在弹窗里，另外两个出口各有一个同样的弹窗。")}</div>`
      : `<div class="shots">${shot("debate-lane", 620, "会话里的辩论是一张折叠卡：木槌图标、七格进度、徽章、三颗带框按钮。")}
          <div class="shots-row">${shot("dispute-card-debated", 420, "同一场辩论在「审查」格的裁定卡里又画一遍。这一栏太窄，所以还有一个「全宽阅读」。")}
          ${shot("debate-reader", 560, "「全宽阅读」是第三处：盖住整页的阅读层。")}</div></div>`),
    moves: [
      ["会话里那颗「去裁定」，和右侧「审查」格里的裁定卡", "不用去别处：几种下一步就在回复框顶上，一直在，不会被后来的话挤掉"],
      ["卡上执行者的那句话、两段折着的依据", "它说的话回到会话左边，是它那一回合的正文；依据是正文下面两行可点开的字"],
      ["四颗按钮各配一行「什么时候该点它」", "按钮原话不变；那一行说明指到才浮出来，选中后写在输入框的提示里"],
      ["三个裁定确认框、框里的「要交代的话」", "选一种下一步，回复框就变成它：要交代的话写在框里，发送键换成「发起修复」这类字"],
      ["辩论确认框里的「辩几个来回」和那行说明", "选「让双方辩论」后，框里是 1 2 3 和「共几段」"],
      ["会话里的辩论折叠卡、卡里的回放、全宽阅读层", "辩论就是对话：审查者在右、执行者在左，一段一句，点开看全文。裁完收成一行"],
      ["每段上的「用这段作要点」", "指到那一段才出的一颗引号键，点了落进回复框并选中「让它接着改」"],
      ["「时间线上这一档记作…」那行小字", "去掉了；记录里的叫法只在审查记录里出现"],
    ],
  };

  // —— 派审查 ——
  const V = D.review;
  const review = {
    init: () => ({ on: false, who: V.who[0], kind: V.kind[0], rounds: 1, note: "", menu: null, sent: false }),
    title: () => V.title,
    feed: (st) => turn({ agent: V.agent, fold: V.fold, body: paras(V.prose) })
      + (st.sent ? reviewer({ text: V.first, live: true, head: `<b>审查者</b><span>${esc(st.who)} · 第 1 轮</span>` })
        + (st.sentNote ? foot(`附言：${esc(st.sentNote)}`, { right: true }) : "") : ""),
    dock: (st) => Dock.review(st),
    sync: (st, value) => { st.note = value; },
    act(name, data, st, api) {
      if (name === "review-toggle") { st.on = !st.on; st.menu = null; api.focus(); }
      if (name === "menu") st.menu = st.menu === data.menu ? null : data.menu;
      if (name === "pick") { st[data.menu] = data.value; st.menu = null; }
      if (name === "rounds") st.rounds = Math.max(0, Math.min(6, st.rounds + +data.d));
      if (name === "send") {
        if (!st.on) { st.note = ""; return; }
        st.sent = true; st.sentNote = st.note.trim(); st.on = false; st.note = ""; st.fresh = true;
      }
    },
    dismiss(st) { if (st.menu) { st.menu = null; return true; } if (st.on) { st.on = false; return true; } return false; },
    old: () => `<div class="shots">${shot("review-dialog", 620, "回复框里的「再审」弹出居中的表单，背后整页虚化。附言写在弹窗里的另一个输入框。")}</div>`,
    moves: [
      ["居中弹窗、虚化的背景、「取消」", "点回复框里的「派审查」，框就变成对审查者说话；再点一下或按 Esc 回到普通回复"],
      ["审查者、检查类型两个下拉", "框顶的两项，点开就地换"],
      ["失败后自动复审 − 1 + 轮", "同一行里的「没过再审 1 轮」；减到 0 写「没过就停下」"],
      ["附言输入框", "就是回复框"],
      ["「开始审查」", "发送键上的字"],
      ["调整审查轮数的弹窗", "同一种做法，样机没画"],
    ],
  };

  // —— 确认 ——
  const C = D.confirm;
  const confirm = {
    init: () => ({ pop: null, deleted: false, gone: false }),
    title: () => C.title,
    feed(st) {
      if (st.gone) return foot("任务删掉了。点右上角「重来」再看一遍。");
      const trash = anchor(key("pop", "trash", "删除这条消息", `data-pop="msg" aria-expanded="${st.pop === "msg"}"`), st.pop === "msg"
        ? `<div data-anim="pop" class="pop is-below is-right"><p>删掉后智能体也读不到它，恢复不了。</p><div class="pop-foot"><button type="button" class="btn" data-act="delete-msg" data-autofocus>删除</button></div></div>` : "");
      const keys = `${key("noop", "copy", "复制")}${key("noop", "pencil", "改了再发")}${trash}`;
      return me(C.me) + turn({ agent: C.agent, fold: C.fold, body: paras(C.prose) })
        + (st.deleted ? "" : me(C.extra, { keys }));
    },
    head(st) {
      const menu = st.pop === "menu" ? `<div data-anim="pop" class="pop is-menu is-below is-right">${["置顶", "复制任务 ID", "标记为已完成"].map((label) => `<button type="button" class="menu-item" data-act="noop">${label}</button>`).join("")}<button type="button" class="menu-item" data-act="pop" data-pop="task">删除任务</button></div>`
        : st.pop === "task" ? `<div data-anim="pop" class="pop is-below is-right menu-confirm"><p>任务、分支 <code>ash/Q7Fd</code> 和它的工作区一起删掉，恢复不了。</p><div class="pop-foot"><button type="button" class="btn" data-act="delete-task" data-autofocus>删除任务</button></div></div>` : "";
      return anchor(`<button type="button" class="head-icon" data-act="pop" data-pop="menu" aria-expanded="${st.pop === "menu" || st.pop === "task"}" aria-label="更多任务操作">${icon("dots")}</button>`, menu);
    },
    dock: () => Dock.plain("回复…"),
    act(name, data, st) {
      if (name === "pop") st.pop = st.pop === data.pop ? null : data.pop;
      if (name === "delete-msg") { st.deleted = true; st.pop = null; }
      if (name === "delete-task") { st.gone = true; st.pop = null; }
    },
    dismiss(st) { if (st.pop) { st.pop = null; return true; } return false; },
    old: () => `<div class="shots">${shot("confirm-delete", 620, "同一个确认框在全站用了 57 处：整页虚化，图标块、英文小标题、大号标题、带投影的按钮。删一条消息和强制通过验证是同一种阵仗。")}</div>`,
    moves: [
      ["整页虚化的遮罩", "去掉。一小层挂在被点的那颗键上，点别处或按 Esc 就是取消"],
      ["图标块、CONFIRM ACTION / HIGH IMPACT ACTION", "去掉"],
      ["大号标题「删除这条消息？」", "去掉：按钮上写着「删除」，标题是在重复它"],
      ["一段后果说明", "留一句，只说按下去会失去什么"],
      ["「取消」按钮", "去掉：点别处、Esc 都是取消"],
      ["回车确认", "照旧，层一出来焦点就在那颗键上"],
      ["菜单里的危险项（删除任务）", "菜单原地换成那一句和一颗键，不另起一层"],
    ],
  };

  // —— 提示条 ——
  const N = D.notice;
  const notice = {
    init: () => ({ plan: true, pop: null, fixed: false, open: new Set(), gone: new Set() }),
    title: () => N.title,
    feed: (st, ui) => me(N.me) + turn({ agent: N.agent, fold: N.fold, body: paras(N.prose) })
      + (ui.notice === "moved" && ui.style === "new" ? foot(`${esc(N.moved.line)} · <a href="#">在本机继续…</a>`) : ""),
    dock: (st, ui) => Dock.notice(ui.notice, st),
    act(name, data, st) {
      if (name === "plan-toggle") st.plan = !st.plan;
      if (name === "pop") st.pop = st.pop === data.pop ? null : data.pop;
      if (name === "fix-ctx") { st.fixed = true; st.pop = null; }
      if (name === "unqueue") st.gone.add(+data.i);
    },
    dismiss(st) { if (st.pop) { st.pop = null; return true; } return false; },
    // 这一场面没有现成截图，「现在」是按线上样式重画的。
    oldFrame(ui) {
      const rows = N.queue.rows;
      return {
        top: ui.notice === "plan" ? `<div class="old-bar is-accent"><b>${N.plan.old[0]}</b><span>${N.plan.old[1]}</span></div>`
          : ui.notice === "moved" ? `<div class="old-bar is-plain">${icon("plane")}<span>${N.moved.old}</span><button type="button">核验后在本机继续…</button></div>` : "",
        rail: ui.notice === "ctx" ? `<div class="old-bar is-amber is-inset"><span>${N.ctx.old}</span><button type="button" class="is-solid">开启 1M</button></div>`
          : ui.notice === "queue" ? `<div class="old-tray"><span class="old-tray-mark">${icon("copy")}</span><b>排队输入 <i>${rows.length}</i></b><span>你的 2 条 · 哨兵 1 条</span><em>1 条需留意</em><button type="button">展开全部 ${rows.length} 条</button></div>` : "",
        dock: Dock.plain("回复…", "", "", "codex · xhigh"),
        note: "这一场面的「现在」是照线上样式重画的，不是截图。",
      };
    },
    moves: [
      ["Codex 计划模式：任务头下面一整条蓝底说明", "回复框里一颗亮着的「计划模式」键；怎么退出就是再点它一下"],
      ["没开 1M：回复框上方一条黄底说明加实心按钮", "上下文那一格变成琥珀色的「上下文 200k」，点开是一句话和「开启 1M」"],
      ["排队输入：带一摞纸阴影的蓝框卡片、图标、筛选键", "回复框上方一行字；点开是几行排着的话，指到哪行哪行出撤回"],
      ["已接力：任务头下面一条带框按钮的横幅", "会话末尾一句小灰字带链接；回复框写明任务在哪台机器上"],
    ],
  };

  window.SCENES = { ask, rule, review, confirm, notice };
})();
