// 回复框本身、等你裁定时框顶多出的那一行下一步，以及它正上方那一行排着的输入。它问你时长成的答题卡在 sheet.js。
(() => {
  const { esc, icon, key } = window.P;
  const D = window.DEMO;

  const sendKey = (label, disabled) =>
    `<button type="button" class="rb-send${label ? " has-label" : ""}" data-act="send" ${disabled ? "disabled" : ""} aria-label="${label || "发送"}">${label ? esc(label) : icon("up")}</button>`;

  function bar({ send, tools = "", agent = "claude · opus-5-5 · high" }) {
    return `<div class="rb-bar"><span class="rb-act" title="上传附件">${icon("clip")}</span>${tools}<span class="rb-gap"></span><span class="rb-agent">${agent}</span>${send}</div>`;
  }
  const text = (value, placeholder, { disabled = false, min = 52 } = {}) =>
    `<textarea id="rb-text" rows="1" data-min="${min}" placeholder="${esc(placeholder)}" ${disabled ? "disabled" : ""}>${esc(value)}</textarea>`;
  const box = (inner, cls = "", anim = "") => `<form class="rb${cls ? ` ${cls}` : ""}" id="rb" autocomplete="off"${anim ? ` data-anim="${anim}"` : ""}>${inner}</form>`;

  function plain(placeholder, tools = "", value = "", agent) {
    return box(`${text(value, placeholder)}${bar({ send: sendKey("", !value.trim()), tools, agent })}`);
  }

  // —— 等你裁定：几种下一步排在框顶。点一个，框就变成那一步——要交代的话写在框里，发送键写着这一按的名字；再点一下回到平常的回复 ——
  function rule(st) {
    const R = D.rule;
    // 辩论中、裁完以后都是平常的回复框：辩到哪了写在会话里那一块上，这里不再抄一遍。
    if (st.phase === "ruled" || st.phase === "debating") return plain("回复…", "", st.note);
    const kinds = ["upheld", "withdrawn", "deferred", ...(st.phase === "open" ? ["debate"] : [])];
    const row = kinds.map((kind) => {
      const choice = R.choices[kind];
      return `<button type="button" class="rule-opt" data-act="choose" data-kind="${kind}" aria-pressed="${st.choice === kind}" data-tip="${esc(choice.tip)}">${esc(choice.label)}</button>`;
    }).join("");
    const chosen = st.choice ? R.choices[st.choice] : null;
    const middle = st.choice === "debate"
      ? `<div class="rb-rounds">来回<div class="seg">${[1, 2, 3].map((n) => `<button type="button" data-act="rounds" data-n="${n}" aria-pressed="${st.rounds === n}">${n}</button>`).join("")}</div><small>审查者先说，共 ${st.rounds * 2 + 1} 段</small></div>`
      : text(st.note, chosen ? chosen.hint : "回复…");
    const send = chosen ? sendKey(chosen.send, false) : sendKey("", !st.note.trim());
    return box(`<div class="rb-ask" data-anim="ask"><div class="rule-row" role="group" aria-label="怎么裁定">${row}</div></div>${middle}${bar({ send })}`);
  }

  // —— 排着的输入：回复框上方一行。你自己最早那条和「引导会话」不用点开就在这一行上 ——
  function queue(st) {
    const Q = D.queue;
    const rows = st.rows.map((row, i) => ({ ...row, i })).filter((row) => !st.gone.has(row.i));
    if (!rows.length) return plain("回复…", "", st.draft, "codex · xhigh");
    const open = st.open.has("queue");
    const alerts = rows.filter((row) => row.alert).length;
    // 能引导的只有一条：你自己最早的那条，而且它排在正在跑的这一轮后面。
    const firstMine = rows.find((row) => row.kind === "mine");
    const steerKey = (row) => (row === firstMine && row.queued
      ? `<button type="button" class="rail-steer" data-act="steer" data-i="${row.i}" data-tip="${esc(Q.steerTip)}">引导会话</button>` : "");
    const rowKey = (row) => (row.kind === "mine" ? key("withdraw", "undo", "撤回，内容放回输入框", `data-i="${row.i}"`)
      : row.kind === "monitor" ? key("unqueue", "x", "取消这次唤醒", `data-i="${row.i}"`) : "");
    const list = open ? `<ul class="rail-rows" data-anim="rail">${rows.map((row) => {
      const id = `q${row.i}`;
      const shown = st.open.has(id);
      return `<li><b${row.alert ? ' class="is-warn"' : ""}>${esc(row.who)}</b>
        <button type="button" class="rail-text" data-act="toggle" data-id="${id}" aria-expanded="${shown}">${esc(row.text)}</button>
        <time>${esc(row.when)}</time><span class="rail-keys">${steerKey(row)}${rowKey(row)}</span>
        ${shown ? `<div class="rail-full" data-anim="lane:${id}">${esc(row.full || row.text)}</div>` : ""}</li>`;
    }).join("")}</ul>` : "";
    const peek = !open && firstMine ? `<span class="rail-peek"><b>你</b>${esc(firstMine.text)}</span>${steerKey(firstMine)}` : "";
    const rail = `<div class="rb-rail"><div class="rail-line"><button type="button" class="fold" data-act="toggle" data-id="queue" aria-expanded="${open}">${icon("chevron")}排着 ${rows.length} 条</button>${alerts ? `<em class="is-warn">${alerts} 条要留意</em>` : ""}${peek}</div>${list}</div>`;
    return `${rail}${plain("回复…", "", st.draft, "codex · xhigh")}`;
  }

  window.Dock = { sendKey, bar, text, box, plain, rule, queue };
})();
