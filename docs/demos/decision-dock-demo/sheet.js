// 答题卡。有事等你回时，回复框整个长成这张卡：最上面是题目，中间是一格一格的选项，下面还是你打字的地方和那颗发送键。
// 提问和裁定是同一张卡；裁定卡多一块辩论记录——辩论只在这里，不进会话。
(() => {
  const { esc, icon, paras, key } = window.P;
  const { sendKey, bar, text, box, plain } = window.Dock;
  const D = window.DEMO;

  const sheet = (inner) => box(inner, "is-sheet", "sheet");
  const foldKey = (st) => {
    const label = st.folded ? "展开这张卡" : "收起，先看上文";
    return `<button type="button" class="key sheet-fold" data-act="fold" aria-expanded="${!st.folded}" aria-label="${label}" title="${label}">${icon("caret")}</button>`;
  };
  const head = ({ intro = "", q, tools = "", st }) => `<div class="sheet-head${st.folded ? " is-folded" : ""}">
    <div class="sheet-q">${intro && !st.folded ? `<p class="sheet-intro">${esc(intro)}</p>` : ""}<p>${esc(q)}</p></div>
    <div class="sheet-tools">${tools}${foldKey(st)}</div></div>`;
  const opt = ({ act, data, n, on, label, disabled = false }) =>
    `<button type="button" class="sheet-opt" data-act="${act}" ${data} aria-pressed="${on}" ${disabled ? "disabled" : ""}><kbd>${on ? icon("check") : n}</kbd><span>${esc(label)}</span></button>`;

  // —— 它问你 ——
  const answered = (st, i) => st.picks[i].size > 0 || st.notes[i].trim() !== "";
  function ask(q, st, ui) {
    const item = q.items[st.index];
    const multi = q.items.length > 1;
    const last = st.index === q.items.length - 1;
    // 提问的那一轮还没停稳：卡已经在了，但要等它停下才能答。
    const settling = ui.askMoment === "settling";
    const steps = multi ? `<span class="sheet-steps" role="group" aria-label="题目">${q.items.map((_, i) =>
      `<button type="button" data-act="step" data-i="${i}" class="${answered(st, i) ? "is-answered" : ""}" ${i === st.index ? 'aria-current="step"' : ""} ${settling ? "disabled" : ""} aria-label="第 ${i + 1} 题${answered(st, i) ? "（已答）" : ""}">${i + 1}</button>`).join("")}</span>` : "";
    const top = head({ intro: q.intro, q: item.question, tools: steps, st });
    const send = multi && !last ? sendKey("下一题", settling) : sendKey("发送答复", settling || !q.items.some((_, i) => answered(st, i)));
    const field = text(st.notes[st.index], settling ? "这一轮结束后就能答" : item.options.length ? "补充说明（选填）" : "写下你的答案…", { disabled: settling, min: 36 });
    const foot = bar({ send, agent: q.agent.startsWith("codex") ? "codex · xhigh" : undefined });
    if (st.folded) return sheet(`${top}${field}${foot}`);
    const opts = item.options.length ? `<div class="sheet-opts" role="group" aria-label="建议答案">${item.options.map((label, i) =>
      opt({ act: "opt", data: `data-i="${i}"`, n: i + 1, on: st.picks[st.index].has(i), label, disabled: settling })).join("")}</div>` : "";
    return sheet(`${top}${opts}${field}${foot}`);
  }

  // —— 辩论记录：左边写谁，右边是那一句，点开看全文。不是气泡，一眼看得出它不是会话 ——
  function thread(st, segs, { quotable = false, live = false } = {}) {
    const rows = segs.slice(0, st.shown).map((seg, i) => {
      const id = `seg${i}`;
      const open = st.open.has(id);
      const who = seg.side === "reviewer" ? "审查者" : "执行者";
      const say = seg.full
        ? `<button type="button" class="thread-gist" data-act="toggle" data-id="${id}" aria-expanded="${open}">${esc(seg.gist)}<em>全文 ${seg.chars} 字</em></button>${open ? `<div class="thread-full" data-anim="lane:${id}">${paras(seg.full)}</div>` : ""}`
        : `<p class="thread-gist">${esc(seg.gist)}</p>`;
      // 收尾那一段是这场辩论的结论：它自己落在哪个立场，写在那一句上面。
      return `<div class="thread-seg${st.freshSeg === i ? " is-new" : ""}"><span class="thread-who">${who}</span>
        <div class="thread-say">${seg.closing ? `<p class="thread-stance">收尾，它自己的立场：${esc(seg.stance)}</p>` : ""}${say}</div>${quotable ? key("quote", "quote", "用这段作要点", `data-i="${i}"`) : "<span></span>"}</div>`;
    });
    if (live) {
      const next = segs[st.shown];
      rows.push(`<div class="thread-seg"><span class="thread-who">${next.side === "reviewer" ? "审查者" : "执行者"}</span><div class="thread-say"><p class="thread-gist is-live"><span class="run-dot"></span>正在组织发言…</p></div><span></span></div>`);
    }
    return `<div class="thread" id="thread">${rows.join("")}</div>`;
  }

  // —— 等你裁定 ——
  function rule(st, segs, ui) {
    const R = D.rule;
    if (st.phase === "ruled") return plain("回复…");
    const inSheet = ui.place === "sheet";
    if (st.phase === "debating") {
      const top = head({ q: R.ask, tools: `<span class="sheet-live"><span class="run-dot"></span>第 ${st.shown + 1} / ${segs.length} 段</span>`, st });
      return sheet(`${top}${!st.folded && inSheet ? thread(st, segs, { live: true }) : ""}${text("", "双方说完再裁", { disabled: true, min: 36 })}${bar({ send: sendKey("", true) })}`);
    }
    const top = head({ q: R.ask, st });
    const kinds = ["upheld", "withdrawn", "deferred", ...(st.phase === "open" ? ["debate"] : [])];
    const chosen = st.choice ? R.choices[st.choice] : null;
    const send = chosen ? sendKey(chosen.send, false) : sendKey("", !st.note.trim());
    if (st.folded) return sheet(`${top}${text(st.note, chosen ? chosen.hint : "回复…", { min: 36 })}${bar({ send })}`);
    const record = inSheet && st.shown ? thread(st, segs, { quotable: true }) : "";
    const opts = `<div class="sheet-opts is-row" role="group" aria-label="下一步">${kinds.map((kind, i) =>
      opt({ act: "choose", data: `data-kind="${kind}"`, n: i + 1, on: st.choice === kind, label: R.choices[kind].label })).join("")}</div>`;
    const middle = st.choice === "debate"
      ? `<div class="rb-rounds">来回<div class="seg">${[1, 2, 3].map((n) => `<button type="button" data-act="rounds" data-n="${n}" aria-pressed="${st.rounds === n}">${n}</button>`).join("")}</div><small>审查者先说，共 ${st.rounds * 2 + 1} 段</small></div>`
      : text(st.note, chosen ? chosen.hint : "回复…", { min: 36 });
    return sheet(`${top}${record}${opts}${middle}${bar({ send })}`);
  }

  window.Sheet = { ask, rule, thread, answered };
})();
