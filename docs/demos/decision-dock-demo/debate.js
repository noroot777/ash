// 会话右边那两颗气泡：审查结论、辩论。画法一样，手势也一样——
//   点气泡 = 在它下面就地摊开「轻的那一层」（审查是这一轮的经过，辩论是每段一句的概览），再点收起；
//   指到气泡，上方浮出的那一行右端一颗文档键 = 右侧抽屉里读「全文」（审查是报告，辩论是完整记录）；
//   摊开以后右上角还有同一颗键，带着字。
(() => {
  const { esc, icon, paras, key } = window.P;
  const who = (seg) => (seg.side === "reviewer" ? "审查者" : "执行者");

  /** 两颗气泡共用的骨架。full = { what, label }：全文是什么、那颗键叫什么。 */
  function shell({ cls = "", anim = "", name, meta, id, open, inner, lane, now = "", full }) {
    const docKey = `<button type="button" class="key" data-act="drawer" data-what="${full.what}" aria-label="${full.label}" title="${full.label}">${icon("file")}</button>`;
    return `<div class="rv${cls ? ` ${cls}` : ""}"${anim ? ` data-anim="${anim}"` : ""}><div class="rv-bubble">
      <header><b>${name}</b><span>${meta}</span>${docKey}</header>
      <button type="button" class="rv-text db-text" data-act="toggle" data-id="${id}" aria-expanded="${open}">${inner}</button>
    </div>${open
    ? `<div class="lane" data-anim="lane:${id}"><button type="button" class="rv-full" data-act="drawer" data-what="${full.what}">${icon("file")}${full.label}</button>${lane}</div>`
    : now ? `<p class="rv-now">${now}</p>` : ""}</div>`;
  }

  /** 审查结论那颗：点开是这一轮的经过（审查者收尾说的话），全文是报告。 */
  function verdict(st, V) {
    return shell({ name: "审查者", meta: V.meta, id: "verdict", open: st.open.has("verdict"),
      inner: `<span>${esc(V.text)}</span>`, lane: `<div class="fold">${icon("chevron")}${esc(V.fold)}</div>${paras(V.said)}`,
      full: { what: "report", label: "审查报告" } });
  }

  /** 概览：左边写谁，右边是那一段的一句话。点某一句，抽屉打开并停在那一段。 */
  function rows(st, segs, { quotable = false, live = false } = {}) {
    const list = segs.slice(0, st.shown).map((seg, i) => {
      const say = seg.full
        ? `<button type="button" class="db-gist" data-act="drawer" data-what="debate" data-i="${i}">${esc(seg.gist)}<em>全文 ${seg.chars} 字</em></button>`
        : `<p class="db-gist">${esc(seg.gist)}</p>`;
      return `<div class="db-row${st.freshSeg === i ? " is-new" : ""}"><span class="db-who">${who(seg)}</span>
        <div>${say}</div>${quotable ? key("quote", "quote", "用这段作要点", `data-i="${i}"`) : "<span></span>"}</div>`;
    });
    if (live) list.push(`<div class="db-row"><span class="db-who">${who(segs[st.shown])}</span><div><p class="db-gist is-live"><span class="run-dot"></span>正在组织发言…</p></div><span></span></div>`);
    return list.join("");
  }

  /** 辩论那颗：辩的时候写最新一句，辩完写结论，裁完缩成一行。点开是概览，全文是完整记录。 */
  function bubble(st, segs) {
    const live = st.phase === "debating";
    const done = st.phase === "debated";
    const last = segs[st.shown - 1];
    const closing = segs[segs.length - 1];
    const say = live ? (last ? `<b>${who(last)}</b>${esc(last.gist)}` : `${who(segs[0])}在组织第 1 段`)
      : done ? `<b>${who(closing)}收尾 · ${esc(closing.stance)}</b>${esc(closing.gist)}`
        : `辩了 ${st.shown} 段，${who(closing)}收尾：${esc(closing.stance)}`;
    return shell({ cls: `db${live ? " is-live" : done ? " is-done" : ""}`, anim: "debate", name: "辩论",
      meta: `审查者和执行者 · ${live ? `共 ${segs.length} 段` : `${st.shown} 段 · 4 分钟`}`, id: "debate", open: st.open.has("debate"),
      inner: `${live ? '<span class="run-dot"></span>' : ""}<span class="db-say${st.freshSeg != null ? " is-new" : ""}">${say}</span>`,
      lane: rows(st, segs, { quotable: done, live }),
      // 收着的时候，气泡下面一行小灰字是此刻谁在说第几段——跟审查进行中那一行同一个位置。
      now: live ? `${who(segs[st.shown])}在说第 ${st.shown + 1} / ${segs.length} 段` : "",
      full: { what: "debate", label: "完整记录" } });
  }

  /** 抽屉：从右边滑出来盖在会话上，读全文的地方。两颗气泡的全文都在这里。 */
  function drawer(st, segs, V) {
    if (!st.drawer) return "";
    const frame = (name, state, body, follow = false) => `<aside class="drawer" data-anim="drawer:${st.drawer}" role="dialog" aria-label="${name}">
      <header class="drawer-head"><b>${name}</b><span>${state}</span>${key("drawer-close", "x", "关上")}</header>
      <div class="drawer-body" id="drawer-body"${follow ? " data-follow" : ""}>${body}</div></aside>`;
    if (st.drawer === "report") {
      return frame("审查报告", esc(V.reportMeta), V.report.map((part) => `<section class="dr-seg"><header><b>${esc(part.h)}</b></header>${paras(part.p)}</section>`).join(""));
    }
    const live = st.phase === "debating";
    const items = segs.slice(0, st.shown).map((seg, i) => `<section class="dr-seg${st.freshSeg === i ? " is-new" : ""}"${st.drawerAt === i ? " data-scroll-here" : ""}>
      <header><b>${who(seg)}</b><span>第 ${i + 1} 段${seg.closing ? ` · 收尾，它自己的立场：${esc(seg.stance)}` : ""}</span>${st.phase === "debated" ? key("quote", "quote", "用这段作要点", `data-i="${i}"`) : ""}</header>
      <p class="dr-gist">${esc(seg.gist)}</p>${seg.full ? paras(seg.full) : ""}</section>`);
    if (live) items.push(`<section class="dr-seg"><header><b>${who(segs[st.shown])}</b><span>第 ${st.shown + 1} 段</span></header><p class="dr-live"><span class="run-dot"></span>正在组织发言…</p></section>`);
    return frame("辩论", live ? `<span class="run-dot"></span>第 ${st.shown + 1} / ${segs.length} 段` : `审查者和执行者 · ${st.shown} 段`, items.join(""), live);
  }

  window.Debate = { verdict, bubble, drawer };
})();
