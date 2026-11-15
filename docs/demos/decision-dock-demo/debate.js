// 辩论。它在会话里，但不是一段一段的气泡：整场辩论是会话里的一颗气泡，辩到哪了、辩出了什么都写在它上面。
// 点气泡，下面就地摊开一段概览（每段一句）；要读整场的完整发言，从概览打开右侧的抽屉。
(() => {
  const { esc, icon, paras, key } = window.P;
  const who = (seg) => (seg.side === "reviewer" ? "审查者" : "执行者");

  /** 概览：左边写谁，右边是那一段的一句话。点某一句，抽屉打开并停在那一段。 */
  function rows(st, segs, { quotable = false, live = false } = {}) {
    const list = segs.slice(0, st.shown).map((seg, i) => {
      const say = seg.full
        ? `<button type="button" class="db-gist" data-act="drawer" data-i="${i}">${esc(seg.gist)}<em>全文 ${seg.chars} 字</em></button>`
        : `<p class="db-gist">${esc(seg.gist)}</p>`;
      return `<div class="db-row${st.freshSeg === i ? " is-new" : ""}"><span class="db-who">${who(seg)}</span>
        <div>${say}</div>${quotable ? key("quote", "quote", "用这段作要点", `data-i="${i}"`) : "<span></span>"}</div>`;
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
    </div>${open ? `<div class="lane" data-anim="lane:debate"><button type="button" class="db-whole" data-act="drawer">${icon("expand")}完整记录</button>${rows(st, segs, { quotable: done, live })}</div>` : ""}</div>`;
  }

  /** 抽屉：整场辩论的完整发言，从右边滑出来，盖在会话上面。辩论还在进行时它跟着长。 */
  function drawer(st, segs) {
    if (!st.drawer) return "";
    const live = st.phase === "debating";
    const items = segs.slice(0, st.shown).map((seg, i) => `<section class="dr-seg${st.freshSeg === i ? " is-new" : ""}"${st.drawerAt === i ? " data-scroll-here" : ""}>
      <header><b>${who(seg)}</b><span>第 ${i + 1} 段${seg.closing ? ` · 收尾，它自己的立场：${esc(seg.stance)}` : ""}</span>${st.phase === "debated" ? key("quote", "quote", "用这段作要点", `data-i="${i}"`) : ""}</header>
      <p class="dr-gist">${esc(seg.gist)}</p>${seg.full ? paras(seg.full) : ""}</section>`);
    if (live) items.push(`<section class="dr-seg"><header><b>${who(segs[st.shown])}</b><span>第 ${st.shown + 1} 段</span></header><p class="dr-live"><span class="run-dot"></span>正在组织发言…</p></section>`);
    const state = live ? `<span class="run-dot"></span>第 ${st.shown + 1} / ${segs.length} 段` : `审查者和执行者 · ${st.shown} 段`;
    return `<aside class="drawer" data-anim="drawer" role="dialog" aria-label="辩论的完整记录">
      <header class="drawer-head"><b>辩论</b><span>${state}</span>${key("drawer-close", "x", "关上")}</header>
      <div class="drawer-body" id="drawer-body">${items.join("")}</div></aside>`;
  }

  window.Debate = { bubble, drawer };
})();
