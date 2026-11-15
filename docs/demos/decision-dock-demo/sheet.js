// 答题卡。它问你时，回复框的位置就是这张卡：一块白底，用细线分成几段——题目、选项、你自己写的那一行。
// 段和段之间只有细线，卡里不再套框。
(() => {
  const { esc, icon } = window.P;
  const { sendKey, bar, text, box } = window.Dock;

  const sheet = (inner) => box(inner, "is-sheet", "sheet");
  const foldKey = (st) => {
    const label = st.folded ? "展开这张卡" : "收起，先看上文";
    return `<button type="button" class="key sheet-fold" data-act="fold" aria-expanded="${!st.folded}" aria-label="${label}" title="${label}">${icon("caret")}</button>`;
  };
  const head = ({ intro = "", q, tools = "", st }) => `<div class="sheet-head${st.folded ? " is-folded" : ""}">
    <div class="sheet-q">${intro && !st.folded ? `<p class="sheet-intro">${esc(intro)}</p>` : ""}<p>${esc(q)}</p></div>
    <div class="sheet-tools">${tools}${foldKey(st)}</div></div>`;
  const cap = (on, n) => `<kbd${on ? ' class="is-on"' : ""}>${on ? icon("check") : n}</kbd>`;
  const opt = ({ act, data, n, on, label, disabled = false }) =>
    `<button type="button" class="sheet-opt" data-act="${act}" ${data} aria-pressed="${on}" ${disabled ? "disabled" : ""}>${cap(on, n)}<span>${esc(label)}</span></button>`;
  // 卡的最后一行：你自己写的话，和那颗发送键。有选项时它也是其中一格，行首是下一个数字。
  const write = ({ value, placeholder, send, n = 0, disabled = false }) => `<div class="sheet-write">${n ? cap(!!value.trim(), n) : ""}${text(value, placeholder, { disabled, min: 22 })}${send}</div>`;
  // 收起：只留题目一行，下面是平常的回复框。
  const folded = (top, value, send, agent) => sheet(`${top}${text(value, "回复…")}${bar({ send, agent })}`);

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
    if (st.folded) return folded(top, st.notes[st.index], send, q.agent.startsWith("codex") ? "codex · xhigh" : undefined);
    const count = item.options.length;
    const opts = count ? `<div class="sheet-opts" role="group" aria-label="建议答案">${item.options.map((label, i) =>
      opt({ act: "opt", data: `data-i="${i}"`, n: i + 1, on: st.picks[st.index].has(i), label, disabled: settling })).join("")}</div>` : "";
    const placeholder = settling ? "这一轮结束后就能答" : count ? "自己写，或者补一句…" : "写下你的答案…";
    return sheet(`${top}${opts}${write({ value: st.notes[st.index], placeholder, send, n: count ? count + 1 : 0, disabled: settling })}`);
  }

  window.Sheet = { ask, answered };
})();
