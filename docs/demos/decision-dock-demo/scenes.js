// 三个场面。每个场面给出：初始状态、会话怎么画、回复框怎么画、点了之后状态怎么变，以及现在线上的样子。
(() => {
  const { esc, icon, paras, turn, unfold, me, qa, reviewer, foot, running, key } = window.P;
  const D = window.DEMO;
  const Dock = window.Dock;
  const Sheet = window.Sheet;
  const shot = (file, width, caption) => `<figure><img src="before/${file}.webp" width="${width}" alt="${esc(caption)}" loading="lazy"><figcaption>${esc(caption)}</figcaption></figure>`;
  const runLine = (label) => `<div class="run-line"><span class="run-dot"></span>${esc(label)}</div>`;

  // —— 它问你 ——
  const ask = {
    init: (ui) => { const q = D.ask[ui.askKind]; return { q, picks: q.items.map(() => new Set()), notes: q.items.map(() => ""), index: 0, sent: null, folded: false }; },
    title: (st) => st.q.title,
    feed: (st, ui) => turn({ agent: st.q.agent, fold: st.q.fold, body: paras(st.q.prose) + (ui.askMoment === "settling" && !st.sent ? runLine("正在结束这一轮") : "") })
      + (st.sent ? qa(st.sent, { fresh: st.fresh }) + running(st.q.agent, st.q.running, st.fresh) : ""),
    dock: (st, ui) => (st.sent ? Dock.plain("回复…", "", "", st.q.agent.startsWith("codex") ? "codex · xhigh" : undefined) : Sheet.ask(st.q, st, ui)),
    sync: (st, value) => { if (!st.sent) st.notes[st.index] = value; },
    canSend(st, value, ui) {
      if (st.sent) return !!value.trim();
      if (ui.askMoment === "settling") return false;
      return st.index < st.q.items.length - 1 || st.q.items.some((_, i) => Sheet.answered(st, i));
    },
    act(name, data, st, api) {
      const items = st.q.items;
      if (name === "opt") { const picks = st.picks[st.index]; const i = +data.i; if (picks.has(i)) picks.delete(i); else picks.add(i); }
      if (name === "step") { st.index = +data.i; api.focus(); }
      if (name === "write") api.focus();
      if (name === "send" && !st.sent) {
        if (st.index < items.length - 1) { st.index += 1; api.focus(); return; }
        if (!items.some((_, i) => Sheet.answered(st, i))) return;
        // 答案 = 勾了的那几格 + 你补的话。题目跟着答案一起留下，卡收走以后还看得出当时问的是什么。
        st.sent = items.map((item, i) => [item.question,
          [...[...st.picks[i]].sort().map((n) => item.options[n]), st.notes[i].trim()].filter(Boolean).join("；") || "（没答）"]);
        st.fresh = true;
      }
    },
    digit(n, st, ui) {
      if (st.sent || st.folded || ui.askMoment === "settling") return null;
      const count = st.q.items[st.index].options.length;
      // 最后一格是「自己写」：按它的数字，光标就落进那一行。
      return n <= count ? { name: "opt", data: { i: n - 1 } } : count && n === count + 1 ? { name: "write", data: {} } : null;
    },
    old: () => `<div class="shots">${shot("question", 620, "同一个问题出现三次：智能体的回复里说一遍，灰字引用抄一遍，卡片里再抄一遍。卡片自带一个输入框和一颗发送键，紧挨着下面的回复框和它的发送键。")}</div>`,
    moves: [
      ["青色边框、「需要你的答复」卡头、问号图标", "去掉。等你答的时候，回复框的位置就是这张答题卡：题目是卡上最重的一行字"],
      ["卡片里的问题，和会话里灰字又抄的一遍", "题目只在答题卡上出现一次；答完后题目跟着你的答案一起留在你那颗气泡里"],
      ["每个选项各带一个框，框里的数字又带一个框", "一行一个，行和行之间只有一条细线，整行都能点；行首那一小格是数字键，选中变成黑底对勾"],
      ["卡片自己的输入框，下面还有一个回复框", "只有一处能打字：卡的最后一行。它也是选项里的一格，按它的数字光标就落进去"],
      ["两颗发送键", "只有一颗，在最后一行的右边，写着「发送答复」"],
      ["勾了的选项落进输入框，可以改字", "勾了就是选了，不再抄进输入框；最后一行只写补充。想换个说法就不勾，自己写"],
      ["多个问题的题号、上一题 / 下一题", "题号在题目右边，点题号跳题；没到最后一题时键上写「下一题」"],
      ["多个问题前面那段共同背景", "题目上方一行灰字"],
      ["「收起答复卡，先看上文」", "题目右边那颗箭头；收起后只剩题目一行，下面是平常的回复框"],
      ["「等这一轮结束」徽章和页脚说明", "选项点不动，最后一行里写着什么时候能答"],
    ],
  };

  // —— 等你裁定（含辩论）——
  const R = D.rule;
  const segsFor = (rounds) => [R.segs[0], R.segs[1], ...R.extra.slice(0, (rounds - 1) * 2), R.segs[2]];
  const ruledLine = (st) => (st.ruled === "upheld" ? (st.sentNote ? "照你这段接着改" : "你让它照第 1 轮报告接着改")
    : st.ruled === "withdrawn" ? "你裁定第 1、3 条作废，这一轮不用改了"
      : `第 1、3 条转给了新任务「<a href="#">${esc(R.deferredTask)}</a>」，还没开工`);
  const rule = {
    init(ui, api) {
      const at = ui.moment;
      const st = { phase: at, shown: at === "debated" || at === "ruled" ? 3 : at === "debating" ? 1 : 0, choice: null, note: "", rounds: 1,
        open: new Set(), ruled: at === "ruled" ? "upheld" : null, sentNote: "", said: [], folded: false, side: false };
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
    feed(st, ui) {
      const segs = segsFor(st.rounds);
      const dispute = R.dispute;
      // 会话里只有三样：它干的活、审查结论、它驳回时说的话。辩论一个字都不在这里。
      let html = turn({ agent: R.agent, fold: R.work.fold, body: paras(R.work.prose) })
        + reviewer({ id: "verdict", text: R.verdict.text, head: R.verdict.head })
        + turn({ agent: R.agent, fold: dispute.fold, body: `<p>${esc(dispute.gist)}</p>`
          + unfold({ id: "reason", ...dispute.reason, open: st.open.has("reason") })
          + unfold({ id: "defer", ...dispute.defer, open: st.open.has("defer") }) });
      const inFeed = ui.place === "feed";
      if (inFeed && st.phase === "ruled" && st.shown) {
        const open = st.open.has("debate");
        html += `<button type="button" class="fold is-past" data-act="toggle" data-id="debate" aria-expanded="${open}">${icon("chevron")}辩了 ${st.shown} 段</button>`;
        if (open) html += `<div class="thread-block" data-anim="past">${Sheet.thread(st, segs)}</div>`;
      } else if (inFeed && (st.shown || st.phase === "debating")) {
        html += `<div class="thread-block">${Sheet.thread(st, segs, { quotable: st.phase === "debated", live: st.phase === "debating" })}</div>`;
      }
      html += st.said.map((text) => me(text)).join("");
      if (st.phase === "ruled") {
        // 裁完了：会话里只留你这一句。整场辩论和结论在右侧「审查」格的记录里。
        const record = !inFeed && st.shown ? ` · <a href="#" data-act="side">辩了 ${st.shown} 段</a>` : "";
        html += (st.sentNote ? me(st.sentNote, { fresh: st.fresh }) : "") + foot(ruledLine(st) + record, { right: true, fresh: st.fresh });
        if (st.ruled === "upheld") html += running(R.agent, "正在读第 1 轮报告", st.fresh);
      }
      return html;
    },
    side(st) {
      if (!st.side) return "";
      return `<aside class="side" data-anim="side" aria-label="审查记录"><header><b>第 1 轮审查</b>${key("side", "x", "关上")}</header>
        <p class="side-line">${esc(R.record)}</p>${Sheet.thread(st, segsFor(st.rounds))}<p class="side-line">你裁定：${esc(R.choices[st.ruled].label)}</p></aside>`;
    },
    dock: (st, ui) => Sheet.rule(st, segsFor(st.rounds), ui),
    sync: (st, value) => { st.note = value; },
    canSend: (st, value) => (st.phase === "debating" ? false : !!st.choice || !!value.trim()),
    act(name, data, st, api) {
      if (name === "choose") { st.choice = st.choice === data.kind ? null : data.kind; if (st.choice && st.choice !== "debate") api.focus(); }
      if (name === "rounds") st.rounds = +data.n;
      if (name === "side") st.side = !st.side;
      if (name === "quote") {
        const seg = segsFor(st.rounds)[+data.i];
        const quoted = `〔${seg.side === "reviewer" ? "审查者" : "执行者"}第 ${+data.i + 1} 段〕${seg.gist}`;
        st.note = st.note.trim() ? `${st.note.trimEnd()}\n\n${quoted}` : quoted;
        st.choice = "upheld";
        api.focus();
      }
      if (name === "send") {
        if (st.phase === "ruled" || !st.choice) { if (st.note.trim()) { st.said.push(st.note.trim()); st.note = ""; } return; }
        if (st.choice === "debate") { st.phase = "debating"; st.shown = 0; st.choice = null; rule.play(st, api); return; }
        st.ruled = st.choice; st.sentNote = st.note.trim(); st.phase = "ruled"; st.choice = null; st.note = ""; st.fresh = true;
      }
    },
    digit(n, st) {
      if (st.folded || (st.phase !== "open" && st.phase !== "debated")) return null;
      const kinds = ["upheld", "withdrawn", "deferred", ...(st.phase === "open" ? ["debate"] : [])];
      return n <= kinds.length ? { name: "choose", data: { kind: kinds[n - 1] } } : null;
    },
    dismiss(st) { if (st.side) { st.side = false; return true; } if (st.choice) { st.choice = null; return true; } return false; },
    old: (ui) => (ui.moment === "open"
      ? `<div class="shots"><div class="shots-row">${shot("dispute-card", 420, "裁定在右侧「审查」格的这张卡上，会话里只有一颗「去裁定」把你送过来。四个出口各配一行说明。")}
          ${shot("debate-dialog", 500, "点「让双方辩论」弹出的确认框。")}</div>
          ${shot("upheld-dialog", 560, "点「让它接着改」弹出的确认框：要交代的话写在弹窗里，另外两个出口各有一个同样的弹窗。")}</div>`
      : `<div class="shots">${shot("debate-lane", 620, "会话里的辩论是一张折叠卡：木槌图标、七格进度、徽章、三颗带框按钮。")}
          <div class="shots-row">${shot("dispute-card-debated", 420, "同一场辩论在「审查」格的裁定卡里又画一遍。这一栏太窄，所以还有一个「全宽阅读」。")}
          ${shot("debate-reader", 560, "「全宽阅读」是第三处：盖住整页的阅读层。")}</div></div>`),
    moves: [
      ["会话里那颗「去裁定」，和右侧「审查」格里的裁定卡", "和提问是同一张答题卡：题目是「第 1、3 条它没改，接下来怎么办」，几种下一步横着排成一条"],
      ["卡上执行者的那句话、两段折着的依据", "这是它自己那一回合说的话，留在会话左边；依据是正文下面两行可点开的字"],
      ["四颗按钮各配一行「什么时候该点它」", "按钮原话不变；选中一格，那句话写在下面那一行的提示里"],
      ["三个裁定确认框、框里的「要交代的话」", "选了哪一格，卡下面才多出一行：要交代的话写在这里，右边的键写着「发起修复」这类字"],
      ["辩论确认框里的「辩几个来回」", "选「让双方辩论」，多出的那一行是 1 2 3 和「共几段」"],
      ["会话里的辩论折叠卡、裁定卡里的回放、全宽阅读层", "只画一处：裁定卡里题目下面那一段浅底，左边写谁、右边是那一句，点开看全文。会话里一个字都不多"],
      ["审查者收尾那段的自述立场", "记录的最后一段，那一句上面写着「收尾，它自己的立场：部分成立」"],
      ["每段上的「用这段作要点」", "指到那一段才出的引号键，点了落进要交代的话并选中「让它接着改」"],
      ["裁完之后", "卡收走。会话里只留右边一句「你让它接着改 · 辩了 3 段」；点「辩了 3 段」，整场记录和结论在右侧「审查」格里"],
      ["「时间线上这一档记作…」那行小字", "去掉了；记录里的叫法只在审查记录里出现"],
    ],
  };

  // —— 排着的输入 ——
  const Q = D.queue;
  const queue = {
    init: () => ({ rows: Q.rows.map((row) => ({ ...row })), gone: new Set(), steered: [], draft: "" }),
    title: () => Q.title,
    feed(st) {
      const steered = st.steered.map((text, i) => me(text, { fresh: st.fresh && i === st.steered.length - 1 })).join("");
      return me(Q.me) + turn({ agent: Q.agent, fold: Q.fold, body: paras(Q.prose) + (steered ? "" : runLine(Q.running)) })
        + (steered ? steered + running(Q.agent, "正在读你接进来的这条", st.fresh) : "");
    },
    dock: (st) => Dock.queue(st),
    sync: (st, value) => { st.draft = value; },
    canSend: (st, value) => !!value.trim(),
    act(name, data, st, api) {
      const row = st.rows[+data.i];
      if (name === "steer") { st.gone.add(+data.i); st.steered.push(row.text); st.fresh = true; api.bottom(); }
      // 撤回：这条不发了，字回到输入框里接着改。
      if (name === "withdraw") { st.gone.add(+data.i); st.draft = st.draft.trim() ? `${st.draft.trimEnd()}\n${row.text}` : row.text; api.focus(); }
      if (name === "unqueue") st.gone.add(+data.i);
      // 它还在跑，这时候发出去的话就排在这一行里。
      if (name === "send" && st.draft.trim()) { st.rows.push({ kind: "mine", who: "你", text: st.draft.trim(), when: "这一轮结束后发", queued: true }); st.draft = ""; }
    },
    // 这一场面没有现成截图，「现在」是按线上样式重画的。
    oldFrame() {
      const row = (n, tag, text, tools) => `<div class="old-tray-row"><i>${n}</i><em>${tag}</em><b>${esc(text)}</b>${tools}</div>`;
      const undo = `<button type="button" aria-label="撤回">${icon("undo")}</button>`;
      return {
        top: "",
        rail: `<div class="old-tray"><span class="old-tray-mark">${icon("copy")}</span><b>排队输入 <i>${Q.rows.length}</i></b><span>我的消息 2 · 哨兵 1 · 系统 1 · 含 1 条定时</span><em>1 条需留意</em><button type="button">展开全部 ${Q.rows.length} 条</button>
          ${row(1, "我的消息", Q.rows[0].text, `<button type="button">${icon("steer")}引导会话</button>${undo}`)}
          ${row(2, "哨兵", Q.rows[1].text, `<span class="old-exit">exit 2</span><button type="button" aria-label="取消这次唤醒">${icon("x")}</button>`)}
          ${row(3, "18:30", Q.rows[2].text, undo)}
          <small>另有 1 条系统输入已收起 · 按原顺序等待处理</small></div>`,
        dock: Dock.plain("回复…", "", "", "codex · xhigh"),
        note: "这一场面的「现在」是照线上样式重画的，不是截图。",
      };
    },
    moves: [
      ["带一摞纸阴影的蓝框卡片、图标、「排队输入 4」", "回复框上方一行字「排着 4 条」，点开是几行"],
      ["来源统计「我的消息 2 · 哨兵 1 · …」和一排筛选键", "去掉；每一行行首写着是谁排进来的"],
      ["「1 条需留意」徽章", "这一行里的琥珀色字"],
      ["你自己的消息常驻预览", "收着的时候，这一行上带着你最早那条"],
      ["引导会话", "还在，而且不用点开：收着时就在这一行上，点开后在那条消息的行尾。和现在一样，只有能引导时才出现（任务正在跑，而且是你最早那条）"],
      ["撤回（内容放回输入框）", "还在：指到你的那一行出，点了字回到输入框"],
      ["哨兵那条的「取消这次唤醒」", "指到那一行出的叉；确认框照旧"],
      ["审查答复、系统排进来的「不可撤回」", "行尾没有键"],
      ["「查看完整输入」", "点那一行，全文就地摊开"],
    ],
  };

  window.SCENES = { ask, rule, queue };
})();
