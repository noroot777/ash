// 辩论。它在会话里，但不是一段一段的气泡：整场辩论是会话里的一块，辩到哪了、辩出了什么都写在这一块上。
// 两种画法：一颗气泡（只写最新一句，点开才是逐段记录），或者一段缩进的记录（每段一句都摆着）。
(() => {
  const { esc, icon, paras, key } = window.P;
  const who = (seg) => (seg.side === "reviewer" ? "审查者" : "执行者");

  /** 逐段记录：左边写谁，右边是那一句，点开看全文。stance = 收尾那段上面要不要写它的立场（气泡上已经写了就不再写）。 */
  function rows(st, segs, { quotable = false, live = false, stance = false } = {}) {
    const list = segs.slice(0, st.shown).map((seg, i) => {
      const id = `seg${i}`;
      const open = st.open.has(id);
      const say = seg.full
        ? `<button type="button" class="db-gist" data-act="toggle" data-id="${id}" aria-expanded="${open}">${esc(seg.gist)}<em>全文 ${seg.chars} 字</em></button>${open ? `<div class="db-full" data-anim="lane:${id}">${paras(seg.full)}</div>` : ""}`
        : `<p class="db-gist">${esc(seg.gist)}</p>`;
      return `<div class="db-row${st.freshSeg === i ? " is-new" : ""}"><span class="db-who">${who(seg)}</span>
        <div>${stance && seg.closing ? `<p class="db-stance">收尾，它自己的立场：${esc(seg.stance)}</p>` : ""}${say}</div>${quotable ? key("quote", "quote", "用这段作要点", `data-i="${i}"`) : "<span></span>"}</div>`;
    });
    if (live) list.push(`<div class="db-row"><span class="db-who">${who(segs[st.shown])}</span><div><p class="db-gist is-live"><span class="run-dot"></span>正在组织发言…</p></div><span></span></div>`);
    return list.join("");
  }

  const past = (st, segs) => `辩了 ${st.shown} 段，${who(segs[segs.length - 1])}收尾：${esc(segs[segs.length - 1].stance)}`;

  /** 一颗气泡：和审查结论那颗是同一种。辩的时候写最新一句，辩完写结论，裁完缩成一行。 */
  function bubble(st, segs) {
    const live = st.phase === "debating";
    const done = st.phase === "debated";
    const open = st.open.has("debate");
    const last = segs[st.shown - 1];
    const closing = segs[segs.length - 1];
    const say = live ? (last ? `<b>${who(last)}</b>${esc(last.gist)}` : `${who(segs[0])}在组织第 1 段`)
      : done ? `<b>${who(closing)}收尾 · ${esc(closing.stance)}</b>${esc(closing.gist)}`
        : past(st, segs);
    const count = live ? `${Math.max(1, st.shown)} / ${segs.length}` : done ? `${segs.length} 段` : "";
    return `<div class="rv db${live ? " is-live" : done ? " is-done" : ""}" data-anim="debate"><div class="rv-bubble">
      <header><b>辩论</b><span>审查者和执行者 · ${(segs.length - 1) / 2} 个来回</span></header>
      <button type="button" class="rv-text db-text" data-act="toggle" data-id="debate" aria-expanded="${open}">${live ? '<span class="run-dot"></span>' : ""}<span class="db-say${st.freshSeg != null ? " is-new" : ""}">${say}</span>${count ? `<em class="db-count">${count}</em>` : ""}</button>
    </div>${open ? `<div class="lane" data-anim="lane:debate">${rows(st, segs, { quotable: done, live })}</div>` : ""}</div>`;
  }

  /** 一段缩进的记录：每段一句都摆着，不用点。裁完收成一行。 */
  function block(st, segs) {
    if (st.phase !== "ruled") return `<div class="db-block" data-anim="debate">${rows(st, segs, { quotable: st.phase === "debated", live: st.phase === "debating", stance: true })}</div>`;
    const open = st.open.has("debate");
    return `<button type="button" class="fold is-past" data-act="toggle" data-id="debate" aria-expanded="${open}">${icon("chevron")}${past(st, segs)}</button>
      ${open ? `<div class="db-block" data-anim="lane:debate">${rows(st, segs)}</div>` : ""}`;
  }

  window.Debate = { bubble, block };
})();
