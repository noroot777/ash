// 开关、重画、点击分发。画面分三块重画（任务头的键、会话、回复框），会话的滚动位置因此不动。
(() => {
  const { esc, icon } = window.P;
  const SCENES = window.SCENES;
  const stage = document.getElementById("stage");
  const moves = document.getElementById("moves");
  const ui = { scene: "rule", style: "new", askKind: "one", moment: "open", notice: "plan" };
  let st = null;
  let timers = [];
  let wantFocus = false;
  let wantBottom = false;

  const scene = () => SCENES[ui.scene];
  const api = {
    later(fn, ms) { timers.push(setTimeout(fn, ms)); },
    render: () => { wantBottom = true; paint(); },
    focus() { wantFocus = true; },
  };

  function reset() {
    timers.forEach(clearTimeout);
    timers = [];
    st = scene().init(ui, api);
    if (!st.open) st.open = new Set();
    stage.innerHTML = "";
    wantBottom = true;
    paint();
    table();
  }

  const headTools = () => `${scene().head ? scene().head(st) : `<span class="head-icon">${icon("dots")}</span>`}<span class="head-icon">${icon("panel")}</span>`;

  function frame(old) {
    return `<div class="app" aria-label="任务界面预览">
      <header class="task-head">${icon("file")}<b>${esc(scene().title(st))}</b><span class="task-head-tools" id="head-tools"></span></header>
      ${old ? old.top : ""}
      <div class="feed" id="feed"><div class="feed-col" id="feed-col"></div></div>
      <div class="reply" id="reply"></div>
    </div>${old && old.note ? `<p class="frame-note">${esc(old.note)}</p>` : ""}`;
  }

  function paint() {
    const isOld = ui.style === "old";
    const old = isOld && scene().oldFrame ? scene().oldFrame(ui) : null;
    if (isOld && !old) { stage.innerHTML = scene().old(ui); return; }
    // 上一次就在的层不重放出现的动画：否则点任何一处，开着的全文和浮层都会跟着闪一下。
    const before = new Set([...stage.querySelectorAll("[data-anim]")].map((el) => el.dataset.anim));
    if (!stage.querySelector(".app") || old) stage.innerHTML = frame(old);
    const feed = document.getElementById("feed");
    document.getElementById("head-tools").innerHTML = headTools();
    document.getElementById("feed-col").innerHTML = scene().feed(st, ui);
    document.getElementById("reply").innerHTML = old ? `${old.rail}${old.dock}` : scene().dock(st, ui);
    stage.querySelectorAll("[data-anim]").forEach((el) => { if (before.has(el.dataset.anim)) el.style.animation = "none"; });
    st.fresh = false;
    st.freshSeg = null;
    if (wantBottom) { feed.scrollTop = feed.scrollHeight; wantBottom = false; }
    const auto = stage.querySelector("[data-autofocus]");
    const text = document.getElementById("rb-text");
    if (auto) auto.focus({ preventScroll: true });
    else if (wantFocus && text && !text.disabled) { text.focus({ preventScroll: true }); text.setSelectionRange(text.value.length, text.value.length); }
    wantFocus = false;
    grow(text);
  }

  const grow = (text) => { if (!text) return; text.style.height = "auto"; text.style.height = `${Math.min(150, Math.max(52, text.scrollHeight))}px`; };

  function table() {
    moves.innerHTML = `<h2>原来的每一样去了哪</h2><table><tbody>${scene().moves.map(([from, to]) => `<tr><th>${esc(from)}</th><td>${esc(to)}</td></tr>`).join("")}</tbody></table>`;
  }

  function act(name, data) {
    const text = document.getElementById("rb-text");
    if (text && scene().sync) scene().sync(st, text.value);
    if (name === "toggle") { if (st.open.has(data.id)) st.open.delete(data.id); else st.open.add(data.id); }
    else if (name !== "noop") {
      if (name === "send") wantBottom = true;
      scene().act(name, data, st, api);
    }
    paint();
  }

  // —— 开关 ——
  function syncControls() {
    document.querySelectorAll(".seg[data-key]").forEach((seg) => seg.querySelectorAll("button").forEach((button) =>
      button.setAttribute("aria-pressed", String(ui[seg.dataset.key] === button.dataset.value))));
    document.querySelectorAll(".control[data-for]").forEach((control) => { control.hidden = control.dataset.for !== ui.scene; });
  }
  document.querySelector(".controls").addEventListener("click", (event) => {
    const button = event.target.closest(".seg[data-key] button");
    if (!button) return;
    ui[button.parentElement.dataset.key] = button.dataset.value;
    syncControls();
    reset();
  });
  document.getElementById("reset").addEventListener("click", reset);

  // —— 画面里的点击、输入、按键 ——
  stage.addEventListener("click", (event) => {
    if (ui.style === "old" && !scene().oldFrame) return;
    if (event.target.closest("a[href='#']")) event.preventDefault();
    const target = event.target.closest("[data-act]");
    if (target && !target.disabled) { act(target.dataset.act, target.dataset); return; }
    if (!event.target.closest(".pop, .rb") && scene().dismiss && scene().dismiss(st)) paint();
  });
  stage.addEventListener("submit", (event) => event.preventDefault());
  stage.addEventListener("input", (event) => {
    if (event.target.id !== "rb-text") return;
    if (scene().sync) scene().sync(st, event.target.value);
    grow(event.target);
    const send = stage.querySelector(".rb-send");
    if (send && !send.classList.contains("has-label")) {
      send.disabled = !(ui.scene === "ask" && !st.sent ? st.answers.some((value) => value.trim()) : event.target.value.trim());
    }
  });
  document.addEventListener("keydown", (event) => {
    if (ui.style === "old" || event.isComposing || !stage.querySelector(".app")) return;
    const inText = event.target.id === "rb-text";
    if (event.key === "Escape" && scene().dismiss) {
      const text = document.getElementById("rb-text");
      if (text && scene().sync) scene().sync(st, text.value);
      if (scene().dismiss(st)) { wantFocus = inText; paint(); }
      return;
    }
    if (event.key === "Enter" && inText && !event.shiftKey) {
      event.preventDefault();
      const send = stage.querySelector(".rb-send");
      if (send && !send.disabled) act("send", {});
      return;
    }
    if (!inText && scene().digit && /^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey && !event.target.closest("input, textarea")) {
      const hit = scene().digit(+event.key, st);
      if (hit) { event.preventDefault(); act(hit.name, hit.data); }
    }
  });

  syncControls();
  reset();
  window.__demo = { ui, get st() { return st; } };
})();
