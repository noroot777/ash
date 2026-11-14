// 会话里几种东西的画法：智能体的回合、你的气泡、审查者的气泡、ash 的尾注。只管出 HTML，不碰状态。
(() => {
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const icon = (id) => `<svg class="icon" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const paras = (list) => list.map((text) => `<p>${esc(text)}</p>`).join("");

  /** 智能体的一个回合。body 是已经拼好的正文 HTML；keys 是指到才出的那几颗键。 */
  function turn({ agent, fold, body, keys = "", fresh = false }) {
    return `<article class="msg${fresh ? " is-new" : ""}"><span class="avatar${agent.startsWith("codex") ? " is-codex" : ""}">${icon(agent.startsWith("codex") ? "codex" : "burst")}</span><div>
      <header>${esc(agent)}${keys ? `<span class="keys">${keys}</span>` : ""}</header>
      ${fold ? `<div class="fold">${icon("chevron")}${esc(fold)}</div>` : ""}
      ${body}
    </div></article>`;
  }

  /** 能点开的一行：点开后全文在它下面就地摊开。 */
  function unfold({ id, label, chars, text, open }) {
    return `<button type="button" class="fold" data-act="toggle" data-id="${id}" aria-expanded="${open}">${icon("chevron")}${esc(label)}${chars ? `<em>${chars} 字</em>` : ""}</button>
      ${open ? `<div class="lane" data-anim="lane:${id}">${paras(text)}</div>` : ""}`;
  }

  function me(text, { keys = "", fresh = false, id = "" } = {}) {
    return `<div class="me${fresh ? " is-new" : ""}"${id ? ` data-me="${id}"` : ""}><div class="me-bubble">${esc(text)}</div>${keys ? `<span class="keys">${keys}</span>` : ""}</div>`;
  }

  /** 审查者的气泡。text 可点开 lane；live = 它正在说。 */
  function reviewer({ id, text, head, lane, open = false, live = false, say = false, tight = false, keys = "" }) {
    const inner = live ? `<span class="run-dot"></span><span>${esc(text)}</span>` : `<span>${esc(text)}</span>`;
    const body = lane && !live
      ? `<button type="button" class="rv-text" data-act="toggle" data-id="${id}" aria-expanded="${open}">${inner}</button>`
      : `<div class="rv-text">${inner}</div>`;
    return `<div class="rv${say ? " is-say" : ""}${tight ? " is-tight" : ""}"><div class="rv-bubble"><header>${head}${keys}</header>${body}</div>${open && lane ? `<div class="lane" data-anim="lane:${id}">${paras(lane)}</div>` : ""}</div>`;
  }

  const foot = (html, { tone = "", right = false, fresh = false } = {}) =>
    `<p class="foot${tone ? ` is-${tone}` : ""}${right ? " is-right" : ""}${fresh ? " is-new" : ""}">${html}</p>`;

  const running = (agent, text, fresh = false) => turn({ agent, fresh, body: `<div class="run-line"><span class="run-dot"></span>${esc(text)}<time>3s</time></div>` });

  const key = (act, iconId, label, extra = "") => `<button type="button" class="key" data-act="${act}" aria-label="${label}" title="${label}" ${extra}>${icon(iconId)}</button>`;

  window.P = { esc, icon, paras, turn, unfold, me, reviewer, foot, running, key };
})();
