// 回复框。此刻有事在等你时，框顶多出一段现成的答法；没有事在等，它就是普通的回复框。
(() => {
  const { esc, icon } = window.P;
  const D = window.DEMO;

  const sendKey = (label, disabled) =>
    `<button type="button" class="rb-send${label ? " has-label" : ""}" data-act="send" ${disabled ? "disabled" : ""} aria-label="${label || "发送"}">${label ? esc(label) : icon("up")}</button>`;

  function bar({ send, tools = "", agent = "claude · opus-5-5 · high" }) {
    return `<div class="rb-bar"><span class="rb-act" title="上传附件">${icon("clip")}</span>${tools}<span class="rb-gap"></span><span class="rb-agent">${agent}</span>${send}</div>`;
  }
  const text = (value, placeholder) => `<textarea id="rb-text" rows="2" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`;
  const box = (inner) => `<form class="rb" id="rb" autocomplete="off">${inner}</form>`;

  // —— 它问你 ——
  const picked = (answer, option) => answer.split("\n").includes(option);
  function toggleOption(answer, option) {
    const lines = answer.split("\n").filter((line) => line.trim());
    return (lines.includes(option) ? lines.filter((line) => line !== option) : [...lines, option]).join("\n");
  }
  function ask(q, st) {
    const item = q.items[st.index];
    const multi = q.items.length > 1;
    const last = st.index === q.items.length - 1;
    const answer = st.answers[st.index];
    const steps = multi ? `<span class="ask-step">${q.items.map((_, i) =>
      `<button type="button" data-act="step" data-i="${i}" class="${st.answers[i].trim() ? "is-answered" : ""}" ${i === st.index ? 'aria-current="step"' : ""} aria-label="第 ${i + 1} 题">${i + 1}</button>`).join("")}</span>` : "";
    const head = multi ? `<div class="ask-q"><span>${esc(item.question)}</span>${steps}</div>` : "";
    const options = item.options.map((option, i) => {
      const on = picked(answer, option);
      return `<button type="button" class="ask-opt" data-act="opt" data-i="${i}" aria-pressed="${on}"><kbd>${on ? icon("check") : i + 1}</kbd><span>${esc(option)}</span></button>`;
    }).join("");
    const answered = st.answers.some((value) => value.trim());
    const send = multi && !last ? sendKey("下一题", false) : sendKey("", !answered);
    return box(`<div class="rb-ask" data-anim="ask">${head}<div class="ask-opts">${options}</div></div>
      ${text(answer, "补充或修改…")}${bar({ send, agent: q.agent.startsWith("codex") ? "codex · xhigh" : undefined })}`);
  }

  // —— 等你裁定 ——
  function rule(st, segs) {
    const R = D.rule;
    if (st.phase === "ruled") return plain("回复…");
    if (st.phase === "debating") {
      const who = segs[st.shown].side === "reviewer" ? "审查者" : "执行者";
      return box(`<div class="rb-ask" data-anim="ask"><div class="rule-live"><span class="run-dot"></span>${who}在说第 ${st.shown + 1} / ${segs.length} 段</div></div>
        ${text(st.note, "回复…")}${bar({ send: sendKey("", true) })}`);
    }
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

  function plain(placeholder, tools = "", value = "", agent) {
    return box(`${text(value, placeholder)}${bar({ send: sendKey("", !value.trim()), tools, agent })}`);
  }

  // —— 派审查：对审查者说话。几项设置在框顶，附言就写在框里 ——
  const menu = (name, list, current, open) => `<span class="anchor"><button type="button" class="rule-opt has-caret" data-act="menu" data-menu="${name}" aria-expanded="${open}">${esc(current)}${icon("caret")}</button>${open
    ? `<div data-anim="pop" class="pop is-menu is-above is-left">${list.map((value) => `<button type="button" class="menu-item" data-act="pick" data-menu="${name}" data-value="${esc(value)}">${esc(value)}</button>`).join("")}</div>` : ""}</span>`;
  function review(st) {
    const V = D.review;
    const tools = `<button type="button" class="rb-act" data-act="review-toggle" aria-pressed="${st.on}">${icon("search")}派审查</button>`;
    if (st.sent) return plain("回复…");
    if (!st.on) return plain("回复…", tools, st.note);
    const again = `<span class="stepper">${st.rounds ? "没过再审" : "没过就停下"}<button type="button" data-act="rounds" data-d="-1" ${st.rounds ? "" : "disabled"} aria-label="少一轮">−</button>${st.rounds ? `<b>${st.rounds}</b>` : ""}<button type="button" data-act="rounds" data-d="1" ${st.rounds < 6 ? "" : "disabled"} aria-label="多一轮">+</button>${st.rounds ? "轮" : ""}</span>`;
    return box(`<div class="rb-ask" data-anim="ask"><div class="rule-row" role="group" aria-label="这次审查">${menu("who", V.who, st.who, st.menu === "who")}${menu("kind", V.kind, st.kind, st.menu === "kind")}${again}</div></div>
      ${text(st.note, "给审查者的附言（选填）")}${bar({ send: sendKey("开始审查", false), tools })}`);
  }

  // —— 提示条：原来横在页面上的那几条，各自回到管它的那颗键上 ——
  function notice(kind, st) {
    const N = D.notice;
    if (kind === "plan") {
      const key = `<button type="button" class="rb-act" data-act="plan-toggle" aria-pressed="${st.plan}" data-tip="${esc(N.plan.tip)}">计划模式</button>`;
      return box(`${text("", st.plan ? "只聊方案…" : "回复…")}${bar({ send: sendKey("", true), tools: key, agent: "codex · xhigh" })}`);
    }
    if (kind === "ctx") {
      const chip = st.fixed
        ? `<span class="rb-act">上下文 1M</span>`
        : `<span class="anchor"><button type="button" class="rb-act is-warn" data-act="pop" data-pop="ctx" aria-expanded="${st.pop === "ctx"}">上下文 200k</button>${st.pop === "ctx"
          ? `<div data-anim="pop" class="pop is-above is-left"><p>${esc(N.ctx.pop)}</p><div class="pop-foot"><button type="button" class="btn" data-act="fix-ctx">开启 1M</button></div></div>` : ""}</span>`;
      return box(`${text("", "回复…")}${bar({ send: sendKey("", true), tools: chip })}`);
    }
    if (kind === "queue") {
      const rows = N.queue.rows.filter((_, i) => !st.gone.has(i));
      const alerts = rows.filter((row) => row.alert).length;
      const list = st.open.has("queue") ? `<ul class="rail-rows" data-anim="rail">${N.queue.rows.map((row, i) => st.gone.has(i) ? "" :
        `<li><b${row.alert ? ' class="is-warn"' : ""}>${esc(row.who)}</b><span>${esc(row.text)}</span><time>${esc(row.when)}</time><button type="button" class="key" data-act="unqueue" data-i="${i}" aria-label="撤回这条" title="撤回这条">${icon("trash")}</button></li>`).join("")}</ul>` : "";
      const rail = rows.length ? `<div class="rb-rail"><button type="button" class="fold" data-act="toggle" data-id="queue" aria-expanded="${st.open.has("queue")}">${icon("chevron")}排着 ${rows.length} 条${alerts ? `<em class="is-warn">${alerts} 条要留意</em>` : ""}</button>${list}</div>` : "";
      return `${rail}${box(`${text("", "回复…")}${bar({ send: sendKey("", true), agent: "codex · xhigh" })}`)}`;
    }
    return box(`<textarea id="rb-text" rows="2" disabled placeholder="这个任务在 mac-mini 上接着跑"></textarea>${bar({ send: sendKey("", true), agent: "codex · xhigh" })}`);
  }

  window.Dock = { ask, rule, review, notice, plain, toggleOption };
})();
