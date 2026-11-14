// 验收台各段的画法：只读状态、吐 HTML，不改状态。事件和计时在 app.js。
(() => {
  const { FILES, DIFFS, COMMITS, BRANCHES, LOG_RUNNING, LOG_FAILED } = window.ACC;

  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const icon = (id, cls = "") => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const anchor = (trigger, layer) => `<span class="anchor">${trigger}${layer}</span>`;

  // 红的那几行没了结之前验收点不了；琥珀的只提醒。
  const blocked = (s) => s.rows.some((row) => row.tone === "block" && !row.gone);
  const picked = (s) => s.children.filter((child) => child.checked).length;

  const BASELINES = [
    ["branch", "分支快照", () => "只测任务分支自己"],
    ["contains", "要求已含目标分支", (s) => `任务分支得先含有最新的 ${s.target}`],
    ["preview", "合并预览", (s) => `先把最新的 ${s.target} 合进来，测合并后的结果`],
  ];

  // —— 第一行 ——
  function bar(s, ui) {
    const done = s.accepted;
    const running = s.gate.status === "running";
    const count = picked(s);
    const target = done
      ? `<code>${esc(s.target)}</code>${done.pending ? "" : `<code class="acc-range">afff4893..3cd3961c</code>`}`
      : anchor(
          `<button type="button" class="acc-target" data-act="pop:target" aria-label="合入目标 ${esc(s.target)}，点开更换" aria-expanded="${ui.pop === "target"}"><code>${esc(s.target)}</code>${icon("caret")}</button>`,
          ui.pop === "target" ? targetPop(s) : "",
        );
    const commits = anchor(
      `<button type="button" class="acc-link" data-act="pop:commits" aria-expanded="${ui.pop === "commits"}">${COMMITS.length} 提交</button>`,
      ui.pop === "commits" ? commitsPop(s) : "",
    );
    const decide = done
      // 欠着提交的那一步由下面那一行说，这里不再写一遍。
      ? `<span class="acc-done">${icon("check")}已验收</span>
         ${done.pending ? "" : `<button type="button" class="acc-link" data-act="noop">审查这次合并</button>`}`
      : `${anchor(
          `<button type="button" class="btn" data-act="pop:reject" aria-expanded="${ui.pop === "reject"}">${icon("return")}打回</button>`,
          ui.pop === "reject" ? rejectPop() : "",
        )}${anchor(
          `<button type="button" class="btn primary" data-act="pop:confirm" aria-expanded="${ui.pop === "confirm"}"${blocked(s) || running ? " disabled" : ""}${blocked(s) ? ' title="先了结下面标红的几行"' : ""}>${
            running ? `<i class="spin"></i>验收中` : `${icon("check")}${count ? `验收 ${count + 1} 个任务` : "验收通过"}`
          }</button>`,
          ui.pop === "confirm" ? confirmPop(s) : "",
        )}`;
    return `<header class="acc-bar">
      <div class="acc-route">
        ${icon("branch")}<code class="acc-src" title="基点 ${s.base}">${esc(s.source)}</code>${icon("arrow", "acc-arrow")}${target}
        ${commits}
        <span class="acc-stat">${s.stat.files} 文件 <b class="add">+${s.stat.add}</b> <b class="del">−${s.stat.del}</b></span>
      </div>
      <div class="acc-actions">
        ${decide}
        <button type="button" class="icon-btn" data-act="leave" aria-label="返回对话" title="返回对话">${icon("x")}</button>
      </div>
    </header>`;
  }

  // —— 第二段 ——
  function checks(s, ui) {
    const rows = [];
    if (s.accepted?.pending) {
      rows.push(`<div class="chk is-warn"><i class="glyph warn"></i><span class="chk-text">合并结果还没提交</span><span class="chk-state">${s.stat.files} 个文件暂存在 ${esc(s.target)}</span>
        <span class="chk-tools"><button type="button" class="btn sm" data-act="pending:commit">提交</button></span></div>`);
    }
    for (const row of s.rows) if (!row.gone) rows.push(factRow(row));
    // 没设命令时这一行不在；从确认层点「设一条」时它才出来，好让设置层有地方挂。
    if ((s.gate.command || ui.pop === "gate") && s.accepted?.mode !== "unset") rows.push(gateRow(s, ui));
    if (s.children.length && !s.accepted) rows.push(childRows(s));
    return rows.length ? `<div class="acc-checks">${rows.join("")}</div>` : "";
  }

  function factRow(row) {
    if (row.handed) {
      return `<div class="chk"><i class="glyph live"></i><span class="chk-text">${esc(row.handed)}</span></div>`;
    }
    return `<div class="chk is-${row.tone}"><i class="glyph ${row.tone}"></i><span class="chk-text">${esc(row.text)}</span>${row.code ? `<code>${esc(row.code)}</code>` : ""}
      <span class="chk-tools"><button type="button" class="btn sm" data-act="row:${row.id}">${esc(row.action)}</button></span></div>`;
  }

  const GATE_WORD = {
    idle: () => "验收时运行",
    stopped: () => "已停止",
    running: (gate) => `运行中 <span data-elapsed>${clock(gate.elapsed)}</span>`,
    failed: () => "未通过，已交给任务修复",
    passed: () => "通过 · 8 分钟前",
  };

  function gateRow(s, ui) {
    const gate = s.gate;
    const done = s.accepted;
    const status = done ? (done.mode === "skipped" ? "skipped" : "passed") : gate.status;
    const word = done ? (status === "skipped" ? "已跳过" : "通过") : GATE_WORD[status](gate);
    const hasLog = !["idle", "skipped", "stopped"].includes(status);
    const main = gate.command
      ? `<i class="glyph ${status}"></i><code>${esc(gate.command)}</code><span class="chk-state">${word}</span>`
      : `<i class="glyph idle"></i><span class="chk-state">前置命令</span>`;
    const tools = status === "running"
      ? `<button type="button" class="btn sm" data-act="gate:stop">${icon("stop")}停止</button>`
      : done ? "" : anchor(
          `<button type="button" class="icon-btn sm reveal" data-act="pop:gate" aria-label="前置命令设置" title="前置命令设置" aria-expanded="${ui.pop === "gate"}">${icon("sliders")}</button>`,
          ui.pop === "gate" ? gatePop(s, ui) : "",
        );
    return `<div class="chk is-${status}">
      ${hasLog
        ? `<button type="button" class="chk-main" data-act="gate:toggle" aria-expanded="${gate.open}">${main}${icon("caret", "chk-caret")}</button>`
        : `<span class="chk-main">${main}</span>`}
      <span class="chk-tools">${tools}</span>
    </div>${hasLog && gate.open ? logPanel(status, ui) : ""}`;
  }

  function logPanel(status, ui) {
    const lines = status === "running" ? LOG_RUNNING.slice(0, ui.logAt)
      : status === "failed" ? LOG_FAILED
        : ["✓ test:web  (96 passed)", "", "312 passed · 11m 52s · rc=0"];
    return `<div class="chk-log">
      <div class="chk-log-head"><span>ag_7Qk2 · 14:02 起${status === "running" ? "" : " · 14:14 止"} · macOS 兼容监督</span><button type="button" class="acc-link" data-act="noop">全文</button></div>
      <pre data-log>${esc(lines.join("\n"))}</pre>
    </div>`;
  }

  function childRows(s) {
    return `<div class="chk-lead">派生任务</div>${s.children.map((child, index) => `<label class="chk is-child">
      <input type="checkbox" data-act="child:${index}"${child.checked ? " checked" : ""}>
      <span class="chk-text">${esc(child.title)}</span><code>${esc(child.branch)}</code>
      <span class="chk-tools"><span class="chk-state">${esc(child.stat)}</span><a class="acc-link reveal" href="#" data-act="noop">看改动</a></span>
    </label>`).join("")}`;
  }

  // —— 点出来的层 ——
  // 「这一按会做什么」不写成一段话：一步一行，可以不做的那两步前面带勾，取消了那一行自己说后果。
  function step({ verb, what = "", flag = "", on = true, cls = "" }) {
    const body = `<span class="verb">${verb}</span><span class="what">${what}</span>`;
    return flag
      ? `<li class="${cls}"><label><input type="checkbox" data-act="flag:${flag}"${on ? " checked" : ""}>${body}</label></li>`
      : `<li class="${cls}"><div><i></i>${body}</div></li>`;
  }

  function confirmPop(s) {
    const gate = s.gate;
    const count = picked(s);
    const fresh = gate.status === "passed";
    const runs = fresh ? s.rerun : !s.skip;
    const note = fresh && !runs ? "<em>8 分钟前通过</em>" : gate.status === "failed" ? `<em class="is-amber">上次未通过</em>` : "";
    const first = gate.command
      ? step({ verb: "运行", what: `<code>${esc(gate.command)}</code>${note}`, flag: "run", on: runs, cls: runs || fresh ? "" : "is-off" })
      : "";
    const merge = step({ verb: "合并", what: `${count ? `${count + 1} 个任务` : `<code>${esc(s.source)}</code>`} → <code>${esc(s.target)}</code>` });
    const commit = step({ verb: "提交", what: s.commit ? "" : `<em class="is-amber">改动留在工作区，这个仓库别的验收先被挡住</em>`, flag: "commit", on: s.commit });
    const clean = step({ verb: "清理", what: s.commit ? "worktree 和任务分支" : "worktree，任务分支留着" });
    return `<div class="pop pop-confirm" role="dialog" aria-label="确认验收">
      <ol class="steps">${first}${merge}${commit}${clean}</ol>
      <footer>
        ${gate.command ? "" : `<button type="button" class="acc-link" data-act="pop:gate">设一条前置命令</button>`}
        <button type="button" class="btn" data-act="pop:close">取消</button>
        <button type="button" class="btn primary" data-act="accept" data-autofocus>${gate.command && !runs && !fresh ? "跳过并验收" : s.commit ? "确认验收" : "验收，不提交"}</button>
      </footer>
    </div>`;
  }

  function rejectPop() {
    return `<div class="pop pop-reject" role="dialog" aria-label="打回">
      <textarea data-reject data-autofocus placeholder="哪里要改" aria-label="打回意见"></textarea>
      <footer><button type="button" class="btn primary" data-act="reject">发给任务</button></footer>
    </div>`;
  }

  function targetPop(s) {
    return `<div class="pop pop-menu" role="menu" aria-label="合入目标">${BRANCHES.map((branch) =>
      `<button type="button" role="menuitemradio" aria-checked="${branch === s.target}" data-act="target:${branch}"><code>${branch}</code>${branch === s.target ? icon("check") : ""}</button>`).join("")}</div>`;
  }

  function commitsPop(s) {
    return `<div class="pop pop-commits" role="dialog" aria-label="提交">
      <ul>${COMMITS.map((commit) => `<li><code>${commit.sha}</code><span>${esc(commit.subject)}</span><time>${commit.when}</time></li>`).join("")}</ul>
      <p>基点 ${s.base}</p>
    </div>`;
  }

  function gatePop(s, ui) {
    const draft = ui.draft;
    const effect = BASELINES.find(([id]) => id === draft.baseline)[2](s);
    return `<div class="pop pop-gate" role="dialog" aria-label="前置命令设置">
      <label class="field"><span>前置命令</span><input data-draft="command" data-autofocus value="${esc(draft.command)}" placeholder="例如 npm test，留空就是不设"></label>
      <label class="field"><span>准备命令</span><input data-draft="prepare" value="${esc(draft.prepare)}" placeholder="例如 npm ci --offline，可留空"></label>
      <div class="field"><span>基准</span><div class="seg" role="group" aria-label="基准">${BASELINES.map(([id, label]) =>
        `<button type="button" aria-pressed="${id === draft.baseline}" data-act="baseline:${id}">${label}</button>`).join("")}</div></div>
      <p class="pop-hint">${esc(effect)}</p>
      <footer><span class="pop-note">项目设置，之后每次验收都按它</span><button type="button" class="btn primary" data-act="gate:save">保存</button></footer>
    </div>`;
  }

  // —— diff ——
  function diff(ui) {
    const file = FILES[ui.file];
    const lines = DIFFS[ui.file % DIFFS.length];
    return `<div class="acc-diff">
      <nav class="files" aria-label="改动文件">${FILES.map((item, index) => `<button type="button" data-act="file:${index}" aria-current="${index === ui.file}">
        <span><bdi>${item.path}</bdi></span><b class="add">+${item.add}</b><b class="del">−${item.del}</b></button>`).join("")}</nav>
      <div class="diffv">
        <div class="diffv-head"><span>${file.path}</span><b class="add">+${file.add}</b><b class="del">−${file.del}</b></div>
        <div class="diffv-rows">${lines.map(([from, to, mark, text]) => mark === "…"
          ? `<div class="dl is-gap"><i>⋯</i></div>`
          : `<div class="dl${mark === "+" ? " is-add" : mark === "-" ? " is-del" : ""}"><span>${from ?? ""}</span><span>${to ?? ""}</span><i>${mark === " " ? "" : mark === "-" ? "−" : mark}</i><code>${esc(text)}</code></div>`).join("")}</div>
      </div>
    </div>`;
  }

  // 打回或关掉之后人回到对话：打回的意见就是对话里右边那一句，不另给回执。
  function left(state) {
    return `<div class="acc-left"><p>对话区</p>${state.text ? `<div class="bubble">${esc(state.text)}</div>` : ""}</div>`;
  }

  window.ACC_PARTS = { bar, checks, diff, left, clock };
})();
