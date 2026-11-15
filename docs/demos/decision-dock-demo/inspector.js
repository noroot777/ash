// 右侧的「审查」格。一轮审查的全部都在这一轮下面：报告、它驳回了什么、辩论、你怎么裁的。
// 辩论不另开一格——它本来就是这一轮审查里的一段。要读全文，从这里把左侧抽屉推出来。
(() => {
  const { esc, icon, key } = window.P;
  const { rows } = window.Debate;

  const wide = (what, label) => `<button type="button" class="key" data-act="drawer" data-what="${what}" aria-label="${label}" title="${label}">${icon("expand")}</button>`;
  const part = (id, st, name, tools, body) => `<section class="insp-part"${st.inspectAt === id ? " data-scroll-here" : ""}><header><b>${name}</b>${tools}</header>${body}</section>`;

  function review(st, segs, R) {
    if (!st.inspector) return "";
    const V = R.verdict;
    const live = st.phase === "debating";
    const parts = [
      part("verdict", st, "报告", wide("report", "在左侧读报告全文"),
        `<p>${esc(V.report[0].p[0])}</p><ol>${V.report.slice(1).map((item) => `<li>${esc(item.h.replace(/^\d+\.\s*/, ""))}</li>`).join("")}</ol>`),
      part("dispute", st, "驳回", "", `<p>${esc(R.disputeLine)}</p>`),
    ];
    if (st.shown || live) {
      parts.push(part("debate", st, `辩论<i>${live ? `第 ${st.shown + 1} / ${segs.length} 段` : `${st.shown} 段`}</i>`, wide("debate", "在左侧读完整记录"),
        rows(st, segs, { quotable: st.phase === "debated", live })));
    }
    if (st.phase === "ruled") parts.push(part("ruling", st, "裁定", "", `<p>${esc(R.choices[st.ruled].label)}${st.sentNote ? "，附了一段要交代的话" : ""}</p>`));
    return `<aside class="insp" data-anim="insp" aria-label="审查">
      <header class="insp-head"><b>审查</b>${key("inspect-close", "x", "关上")}</header>
      <div class="insp-round"><b>第 1 轮</b><span>${esc(V.roundMeta)}</span><em>未通过</em></div>
      <div class="insp-body" id="insp-body">${parts.join("")}</div></aside>`;
  }

  window.Inspector = { review };
})();
