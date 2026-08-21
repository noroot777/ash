/* 工作流定义层 —— 与外观无关，被 console / line 两套壳子共用（无依赖） */
(function (global) {
  "use strict";

  var seq = 0;
  function nid() { seq += 1; return "s" + seq; }

  // ── 步骤类型 ─────────────────────────────────────────────────────────
  // sentence() 只负责句子形态，list/表格形态从 title/summary 取；三种范式读同一份。
  var KINDS = {
    run: {
      label: "让 AI 干活", code: "RUN", hue: "#7c8cff", tag: "agent.run", hasFail: true,
      make: function () { return { executor: "codex@cpa", model: "gpt-5.6-sol", effort: "xhigh", brief: "按任务描述实现" }; },
      fields: [
        { key: "brief", label: "干什么", type: "select", options: ["按任务描述实现", "只改这一个模块", "先写测试再实现"] },
        { key: "executor", label: "执行器", type: "select", options: ["codex@cpa", "claude@sonnet", "codex@review", "gemini@fast"] },
        { key: "model", label: "模型", type: "select", options: ["gpt-5.6-sol", "claude-opus-5", "claude-sonnet-5"] },
        { key: "effort", label: "思考强度", type: "seg", options: ["medium", "high", "xhigh"] },
      ],
      title: function (p) { return "让 " + p.executor + " 干活"; },
      summary: function (p) { return p.brief + " · " + p.model + " · " + p.effort; },
      sentence: function (p, s) {
        return "让 " + slot(s, "executor", p.executor) + " " + slot(s, "brief", p.brief);
      },
    },
    verify: {
      label: "自动验证", code: "VER", hue: "#3ddad7", tag: "agent.verify", hasFail: true,
      make: function () { return { executor: "codex@review", checks: ["构建 + 类型检查"] }; },
      fields: [
        { key: "executor", label: "验证执行器", type: "select", options: ["codex@review", "claude@sonnet", "同上一步"] },
        { key: "checks", label: "验什么（全过才算通过）", type: "checks",
          options: ["构建 + 类型检查", "回归测试", "浏览器真实点检", "接口冒烟", "跑一遍 lint"] },
      ],
      title: function () { return "自动验证"; },
      summary: function (p) { return p.checks.length ? p.checks.join(" ／ ") : "还没选验什么"; },
      sentence: function (p, s) {
        return "交给 " + slot(s, "executor", p.executor) + " 验一遍（" +
          slot(s, "checks", p.checks.length ? p.checks.join("、") : "还没选") + "）";
      },
    },
    preview: {
      label: "打开预览", code: "PRE", hue: "#f0b429", tag: "preview.serve", hasFail: false,
      make: function () { return { cmd: "npm -w web run dev", ready: "端口可连 + 日志 ready", life: "下一个人工关口结束时回收" }; },
      fields: [
        { key: "cmd", label: "启动命令", type: "select", options: ["npm -w web run dev", "npm run dev", "npm run preview", "docker compose up web"] },
        { key: "ready", label: "怎么算起来了", type: "select", options: ["端口可连 + 日志 ready", "只要端口可连", "HTTP 200"] },
        { key: "life", label: "什么时候关掉", type: "select", options: ["下一个人工关口结束时回收", "任务结束时回收", "闲置 30 分钟回收"] },
      ],
      title: function () { return "打开预览"; },
      summary: function (p) { return p.cmd + " · " + p.life; },
      sentence: function (p, s) {
        return "起一个预览（" + slot(s, "cmd", p.cmd) + "）让我能点开看，" + slot(s, "life", p.life);
      },
    },
    human: {
      label: "等我点头", code: "GATE", hue: "#ff8fa3", tag: "human.gate", hasFail: true,
      make: function () { return { notify: "落「需处理」+ 推送通知", show: "diff + 验证报告 + 截图" }; },
      fields: [
        { key: "show", label: "给我看什么", type: "select", options: ["diff + 验证报告 + 截图", "只看 diff", "只看验证报告"] },
        { key: "notify", label: "怎么叫我", type: "select", options: ["落「需处理」+ 推送通知", "只落「需处理」", "推送 + 邮件"] },
      ],
      title: function () { return "等我点头"; },
      summary: function (p) { return p.show + " · " + p.notify; },
      sentence: function (p, s) { return "停下来等我点头，给我看 " + slot(s, "show", p.show); },
    },
    command: {
      label: "跑一条命令", code: "CMD", hue: "#9aa4b2", tag: "shell.run", hasFail: true,
      make: function () { return { cmd: "npm run lint", where: "任务工作区" }; },
      fields: [
        { key: "cmd", label: "命令", type: "select", options: ["npm run lint", "npm test", "npm run build", "./scripts/deploy.sh", "git push origin HEAD"] },
        { key: "where", label: "在哪跑", type: "seg", options: ["任务工作区", "项目根目录"] },
      ],
      title: function (p) { return "跑 " + p.cmd; },
      summary: function (p) { return "在" + p.where + "执行，非 0 退出码算失败"; },
      sentence: function (p, s) { return "跑一条命令 " + slot(s, "cmd", p.cmd); },
    },
    accept: {
      label: "合并并清理", code: "MRG", hue: "#5ee39b", tag: "repo.accept", hasFail: true,
      make: function () { return { strategy: "Ash 安全合并（仓库锁内）", clean: "删除 worktree 与任务分支" }; },
      fields: [
        { key: "strategy", label: "怎么合", type: "select", options: ["Ash 安全合并（仓库锁内）", "squash 合并", "只打标签不合并"] },
        { key: "clean", label: "合完清理", type: "select", options: ["删除 worktree 与任务分支", "只删 worktree", "都留着"] },
      ],
      title: function () { return "合并并清理"; },
      summary: function (p) { return p.strategy + " · " + p.clean; },
      sentence: function (p, s) { return "把改动 " + slot(s, "strategy", p.strategy) + "，然后 " + slot(s, "clean", p.clean); },
    },
  };

  function slot(step, field, text) {
    return '<button class="slot" data-edit="' + step.id + '" data-field="' + field + '">' + esc(text) + "</button>";
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var FAIL_MODES = [
    ["stop", "停下等人"],
    ["ask", "问我一句"],
    ["back", "回到某一步重做"],
  ];

  // ── 状态 ─────────────────────────────────────────────────────────────
  var state = { workspace: "isolated", steps: [] };

  function makeStep(kind) {
    var k = KINDS[kind], step = { id: nid(), kind: kind, p: k.make() };
    if (k.hasFail) step.fail = { mode: "stop", backTo: null, max: 2 };
    return step;
  }

  function indexOf(id) {
    for (var i = 0; i < state.steps.length; i += 1) if (state.steps[i].id === id) return i;
    return -1;
  }
  function get(id) { var i = indexOf(id); return i < 0 ? null : state.steps[i]; }

  function insert(kind, at) {
    var step = makeStep(kind);
    state.steps.splice(at == null ? state.steps.length : at, 0, step);
    return step;
  }
  function remove(id) {
    var i = indexOf(id);
    if (i < 0) return;
    var gone = state.steps.splice(i, 1)[0];
    state.steps.forEach(function (s) {           // 别留下指向已删步骤的失败跳转
      if (s.fail && s.fail.backTo === gone.id) { s.fail.mode = "stop"; s.fail.backTo = null; }
    });
  }
  function move(id, dir) {
    var i = indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= state.steps.length) return;
    var t = state.steps[i]; state.steps[i] = state.steps[j]; state.steps[j] = t;
  }

  // ── 模板只是起手式，选完随便改 ────────────────────────────────────────
  var TEMPLATES = {
    blank: { name: "空白", desc: "从一步开始，自己搭", build: function () { return [["run"]]; } },
    fast: { name: "极速原型", desc: "干完就算完", build: function () { return [["run"]]; }, workspace: "shared" },
    standard: { name: "标准交付", desc: "验证 → 人工点头 → 合并",
      build: function () { return [["run"], ["verify"], ["human"], ["accept"]]; } },
    frontend: { name: "前端真实验收", desc: "验证 → 起预览 → 人工点头 → 合并",
      build: function () { return [["run"], ["verify", { checks: ["构建 + 类型检查", "浏览器真实点检"] }], ["preview"], ["human"], ["accept"]]; } },
    release: { name: "发布流水", desc: "验证 → 人工点头 → 合并 → 跑发布脚本",
      build: function () { return [["run"], ["verify", { checks: ["构建 + 类型检查", "回归测试"] }], ["human"], ["accept"], ["command", { cmd: "./scripts/deploy.sh" }]]; } },
  };

  function loadTemplate(key) {
    var t = TEMPLATES[key];
    state.workspace = t.workspace || "isolated";
    state.steps = t.build().map(function (row) {
      var step = makeStep(row[0]);
      if (row[1]) Object.keys(row[1]).forEach(function (k) { step.p[k] = row[1][k]; });
      return step;
    });
    // 验证失败默认回到第一步重做，这是绝大多数人想要的语义
    var first = state.steps[0];
    state.steps.forEach(function (s) {
      if (s.kind === "verify" || s.kind === "human") {
        s.fail = { mode: "back", backTo: first.id, max: 2 };
      }
    });
  }

  // ── 编译闸：放开编排的前提，是能拒绝的一律拒绝 ──────────────────────
  function compile() {
    var rows = [], denied = false, steps = state.steps;
    function deny(msg) { rows.push(["deny", msg]); denied = true; }
    function warn(msg) { rows.push(["warn", msg]); }

    var kinds = steps.map(function (s) { return s.kind; });
    if (kinds.indexOf("run") < 0) deny("整条流程里没有一步是让 AI 干活的 —— 这样跑起来什么也不会发生。");

    steps.forEach(function (s, i) {
      if (s.kind === "accept") {
        var humanBefore = kinds.slice(0, i).indexOf("human") >= 0;
        if (!humanBefore) deny("第 " + (i + 1) + " 步「合并并清理」前面没有任何人工关口 —— 不可逆动作不允许自动跨过人。");
        if (kinds.indexOf("accept") !== i) deny("出现了不止一个「合并并清理」—— 合并只能有一次。");
      }
      if (s.kind === "preview") {
        var humanAfter = kinds.slice(i + 1).indexOf("human") >= 0;
        if (!humanAfter) deny("第 " + (i + 1) + " 步起了预览，但后面没有人工关口 —— 这个服务没有明确的关闭时刻，只会变成又一个没人记得停的端口。");
      }
      if (s.fail && s.fail.mode === "back") {
        var j = indexOf(s.fail.backTo);
        if (j < 0) deny("第 " + (i + 1) + " 步的失败去向指向了一个不存在的步骤。");
        else if (j >= i) deny("第 " + (i + 1) + " 步失败后要回到第 " + (j + 1) + " 步 —— 只能往回跳，往前跳等于死循环。");
      }
      if (s.kind === "verify" && s.p.checks.length === 0) {
        warn("第 " + (i + 1) + " 步的验证没有勾任何检查项，等于一个必然通过的空关口。");
      }
    });

    if (state.workspace === "shared" && kinds.indexOf("accept") >= 0) {
      warn("在项目目录里直接干活，没有独立分支可合 —— 「合并并清理」会退化成「只提交，不合并」。");
    }
    if (!denied) {
      var loops = steps.filter(function (s) { return s.fail && s.fail.mode === "back"; }).length;
      rows.push(["ok", steps.length + " 步全部可达；" + (loops ? "回路 " + loops + " 处，各自有轮数上限；" : "无回路；") +
        (kinds.indexOf("human") >= 0 ? "不可逆动作前有人把关。" : "全自动，没有人工关口。")]);
    }
    return { rows: rows, denied: denied };
  }

  // 一句话摘要：三种范式共用，也是保存后列表里显示的那行
  function digest() {
    if (!state.steps.length) return "空的";
    return state.steps.map(function (s) { return KINDS[s.kind].label; }).join(" → ");
  }

  global.WF = {
    KINDS: KINDS, FAIL_MODES: FAIL_MODES, TEMPLATES: TEMPLATES,
    state: state, esc: esc,
    indexOf: indexOf, get: get, insert: insert, remove: remove, move: move,
    loadTemplate: loadTemplate, compile: compile, digest: digest,
  };
})(window);
