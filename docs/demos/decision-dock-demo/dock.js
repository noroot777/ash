// 回复框本身，以及它正上方那一行排着的输入。有事等你回时它长成的答题卡在 sheet.js。
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

  // —— 计划模式：回复框里一颗亮着的键 ——
  function plan(st) {
    const toggle = `<button type="button" class="rb-act" data-act="plan-toggle" aria-pressed="${st.plan}" data-tip="${esc(D.plan.tip)}">计划模式</button>`;
    return box(`${text("", st.plan ? "只聊方案…" : "回复…")}${bar({ send: sendKey("", true), tools: toggle, agent: "codex · xhigh" })}`);
  }

  window.Dock = { sendKey, bar, text, box, plain, queue, plan };
})();
