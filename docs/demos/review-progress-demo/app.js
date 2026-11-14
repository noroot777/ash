// 审查进行中的两种画法，同一份假数据。ui = 样机开关；画面每次整段重画，计时只改自己那几个字。
(() => {
  const feed = document.getElementById("feed");
  const col = document.getElementById("feed-col");
  const bubbleControl = document.getElementById("bubble-control");

  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const icon = (id) => `<svg class="icon" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const span = (seconds) => (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);

  const S1 = "我先核对需求、实际改动和回归登记，再逐面审查。";
  const S2 = "改动面已过一遍；接下来验证配置冲突和启动状态误判。";
  const PASS = "两处入口都按起跑事件判断，配置冲突和启动失败各有一条红线。没有要改的。";
  const FAIL = "有两处要改：codex exec 那条路读不到状态时一句提示都没有；Windows 的 .cmd 启动路径没有用例。";
  const R2 = "先看两条意见对应的改动，再复查上一轮没覆盖的启动路径。";
  const CMD = ["git status --short", "git diff --stat feat/ui-revamp...HEAD", `/bin/zsh -lc "sed -n '288,333p' server/src/executors/mcp-inject.ts"`];

  // 一轮审查在某一刻的样子。items 是摊开后的经过：say = 审查者说的话，ran = 收起来的一串命令，live = 正在跑的那一条。
  const LIVE = [
    { n: 1, at: "16:22", elapsed: 6, cmd: CMD[0], items: [["live", CMD[0]]] },
    { n: 1, at: "16:22", elapsed: 48, cmd: CMD[1], items: [["say", S1], ["live", CMD[1]]] },
    { n: 1, at: "16:22", elapsed: 162, cmd: CMD[2], items: [["say", S1], ["ran", 12], ["say", S2], ["live", CMD[2]]] },
  ];
  const LIVE_R2 = { n: 2, at: "16:41", elapsed: 35, cmd: "npm -w server run test:mcp-inject", items: [["say", R2], ["live", "npm -w server run test:mcp-inject"]] };
  const DONE = {
    pass: { n: 1, text: "第 1 轮审查通过", took: "6m 10s", at: "16:28", items: [["say", S1], ["ran", 12], ["say", S2], ["ran", 9], ["say", PASS]] },
    fail: { n: 1, text: "第 1 轮审查未通过，2 条意见", took: "6m 10s", at: "16:28", items: [["say", S1], ["ran", 12], ["say", S2], ["ran", 9], ["say", FAIL]] },
  };

  const ui = { style: "new", moment: 2, bubble: "round", open: new Set(), cardCollapsed: false, tick: 0 };
  // 上一次画出来的字：只有真换了字的那一处才做换字的小动画，点开收起时别的地方不跟着闪。
  let shown = {};

  const MAIN_TURN = `<article class="msg"><span class="avatar">${icon("burst")}</span><div>
    <header>claude@nodemach</header>
    <div class="fold">${icon("chevron")}跑了 31 条命令，另有 5 步</div>
    <p>MCP 接入已经改成起跑时注入，连没连上从 CLI 的启动事件里读。还有三处没覆盖到：</p>
    <ul>
      <li>Windows 没实测。<code>.cmd</code> 启动和带空格的路径只有测试覆盖，没在真机上跑过。</li>
      <li>codex 走 <code>codex exec</code> 时不报 MCP 启动状态，连接失败不会出红线。</li>
      <li>ash 没连上时这一回合仍会跑完，不会提前停。</li>
    </ul>
    <p>临时实例已停，临时目录和补的 <code>node_modules</code> 软链都清掉了。</p>
  </div></article>`;
  const FIX_TURN = `<article class="msg"><span class="avatar">${icon("burst")}</span><div>
    <header>claude@nodemach</header>
    <div class="fold">${icon("chevron")}跑了 9 条命令</div>
    <p>两条意见都改了：<code>codex exec</code> 那条路读不到状态时会出一句提示；Windows 的启动路径补了一条用例。</p>
  </div></article>`;

  const fresh = (key, text) => (shown[key] !== undefined && shown[key] !== text ? " is-fresh" : "");
  const clock = (round) => `<time data-base="${round.elapsed}">${span(round.elapsed + ui.tick)}</time>`;

  function lane(round, live) {
    return round.items.map(([kind, value]) => kind === "say" ? `<p>${esc(value)}</p>`
      : kind === "ran" ? `<div class="fold">${icon("chevron")}跑了 ${value} 条命令</div>`
        : `<div class="fold">${icon("chevron")}正在跑<span class="cmd">${esc(value)}</span>${live ? clock(round) : ""}</div>`).join("");
  }

  // 方案：进行中的审查就是右边那颗气泡。
  function liveBubble(round, next) {
    const open = ui.open.has(round.n);
    const latest = round.items.filter(([kind]) => kind === "say").at(-1)?.[1];
    const label = `第 ${round.n} 轮审查中`;
    const inBubble = ui.bubble === "say" && latest ? latest : label;
    const below = ui.bubble === "say" || !latest ? `正在跑 <code>${esc(round.cmd)}</code>` : esc(latest);
    next[`b${round.n}`] = inBubble;
    next[`n${round.n}`] = below;
    return `<div class="rv">
      <div class="rv-bubble">
        <header><b>审查者</b><span> · codex@nodemach · gpt-6.1-sol · medium · 最多 7 轮 · 11/14 ${round.at}</span></header>
        <button type="button" class="rv-text" data-act="lane:${round.n}" aria-expanded="${open}" aria-label="${label}，${open ? "收起" : "摊开"}这一轮的经过">
          <i class="run-dot"></i><span class="${inBubble === label ? "" : "rv-say-clamp"}${fresh(`b${round.n}`, inBubble)}">${esc(inBubble)}</span>
        </button>
      </div>
      ${open ? `<div class="lane">${lane(round, true)}</div>`
        : `<p class="rv-now"><span class="${fresh(`n${round.n}`, below).trim()}">${below}</span>${clock(round)}</p>`}
    </div>`;
  }

  // 出了结论的那颗气泡：两种画法里是同一颗（产品现在就是这样）。
  function verdict(round, next) {
    const open = ui.open.has(round.n);
    next[`b${round.n}`] = round.text;
    return `<div class="rv">
      <div class="rv-bubble">
        <header><b>审查者</b><span> · codex@nodemach · ${round.took} · 11/14 ${round.at}</span>
          <button type="button" class="rv-key" aria-label="审查报告" title="审查报告">${icon("file")}</button>
          <button type="button" class="rv-key" data-act="lane:${round.n}" aria-expanded="${open}" aria-label="这一轮的经过" title="这一轮的经过">${icon("steps")}</button>
        </header>
        <button type="button" class="rv-text" title="在右侧「审查」格里打开这一轮（样机里从略）"><span class="${fresh(`b${round.n}`, round.text).trim()}">${esc(round.text)}</span></button>
      </div>
      ${open ? `<div class="lane">${lane(round, false)}</div>` : ""}
    </div>`;
  }

  // 现在：进行中是左边一张卡。
  function liveCard(round) {
    return `<section class="card${ui.cardCollapsed ? " is-collapsed" : ""}">
      <div class="card-head">
        <span class="card-mark">${icon("shield")}</span><b>第 ${round.n}/7 轮审查</b>
        <span class="card-by">codex@nodemach 在审 · gpt-6.1-sol · medium</span><span class="card-state">进行中</span>
        <time>11/14 ${round.at}</time><button type="button" data-act="card">${ui.cardCollapsed ? "展开" : "收起"}</button>
      </div>
      ${ui.cardCollapsed ? "" : `<div class="card-body">${lane(round, true)}</div>`}
    </section>`;
  }

  function render(jump = false) {
    const next = {};
    const live = (round) => (ui.style === "new" ? liveBubble(round, next) : liveCard(round));
    col.innerHTML = MAIN_TURN + (ui.moment <= 2 ? live(LIVE[ui.moment])
      : ui.moment === 3 ? verdict(DONE.pass, next)
        : verdict(DONE.fail, next) + FIX_TURN + live(LIVE_R2));
    shown = next;
    bubbleControl.hidden = ui.style !== "new";
    for (const seg of document.querySelectorAll(".seg")) {
      for (const button of seg.children) button.setAttribute("aria-pressed", String(button.dataset.value === String(ui[seg.dataset.key])));
    }
    if (jump) { feed.style.scrollBehavior = "auto"; feed.scrollTop = feed.scrollHeight; feed.style.scrollBehavior = ""; }
    else feed.scrollTop = feed.scrollHeight;
  }

  let playing = null;
  const stop = () => { window.clearInterval(playing); playing = null; };
  function setMoment(value) {
    ui.moment = value;
    ui.tick = 0;
  }

  document.querySelector(".controls").addEventListener("click", (event) => {
    const button = event.target.closest(".seg button");
    if (!button) return;
    stop();
    const key = button.parentElement.dataset.key;
    if (key === "moment") setMoment(Number(button.dataset.value));
    else ui[key] = button.dataset.value;
    // 换画法、换气泡里写什么不是「字换了」，别放换字动画。
    if (key !== "moment") shown = {};
    render();
  });

  document.getElementById("play").addEventListener("click", () => {
    stop();
    ui.open.clear();
    shown = {};
    setMoment(0);
    render();
    playing = window.setInterval(() => {
      setMoment(ui.moment + 1);
      render();
      if (ui.moment >= 3) stop();
    }, 2600);
  });

  col.addEventListener("click", (event) => {
    const el = event.target.closest("[data-act]");
    if (!el) return;
    const [name, arg] = el.dataset.act.split(":");
    if (name === "card") ui.cardCollapsed = !ui.cardCollapsed;
    if (name === "lane") {
      const n = Number(arg);
      if (ui.open.has(n)) ui.open.delete(n); else ui.open.add(n);
    }
    render();
  });

  window.setInterval(() => {
    ui.tick += 1;
    for (const time of col.querySelectorAll("time[data-base]")) time.textContent = span(Number(time.dataset.base) + ui.tick);
  }, 1000);

  render(true);
})();
