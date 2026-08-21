// 五个方案共用同一份会话 DOM（#feed-template），差别全在 stage 外层的 opt-* 类上：
// 想比较的是「同样的内容换一种区分方式」，任何内容差异都会污染判断。
// opt-0 是对照组 —— 今天线上就是这样，验证段跟普通回合长得一模一样。

const OPTIONS = [
  {
    key: "0",
    cls: "opt-0",
    name: "对照组 · 现状",
    lead: "今天线上的样子：协议正文是系统代写消息，审查者的产出是一条普通 agent 气泡。换了执行器时只有名字不同；同一个执行器自审时，连名字都跟上面那条一样。",
    facts: [
      ["边界", "看不出起止，只能靠读旁注文字", "risk"],
      ["中段", "完全认不出还在验证里", "risk"],
      ["重量", "最轻（什么都没加）", "good"],
      ["成本", "0", "good"],
    ],
  },
  {
    key: "A",
    cls: "opt-a",
    name: "A · 身份徽标",
    lead: "只改身份行：头像换成盾形，名字后跟一颗「审查者 · 第 N 轮」徽标，起止旁注改用青色竖条。气泡本体、缩进、宽度全不动。",
    facts: [
      ["边界", "靠两条旁注传达，不算强", "risk"],
      ["中段", "每条气泡自带徽标，认得出", "good"],
      ["重量", "几乎无感，不打断阅读节奏", "good"],
      ["成本", "低 · 只需给单条气泡打「这是验证轮」标记", "good"],
    ],
  },
  {
    key: "B",
    cls: "opt-b",
    name: "B · 验证泳道",
    lead: "整轮验证包进一个段落容器：3px 青色左条 + 极淡底色 + 一行段头（轮次 / 谁在审 / 结论 / 用时）。协议正文与结论旁注都收进段内。",
    facts: [
      ["边界", "最强，起止一目了然", "good"],
      ["中段", "底色与左条一路跟到底", "good"],
      ["重量", "会话里多一块盒子，偏重", "risk"],
      ["成本", "中 · 要模型层给出验证段起止（可由 verifyRound + 起止旁注推导）", ""],
    ],
  },
  {
    key: "C",
    cls: "opt-c",
    name: "C · 缩进旁支",
    lead: "不加底色，只把整段右移一截并挂一条青色虚线：像文档里的旁支，比 B 轻，比 A 强。",
    facts: [
      ["边界", "靠缩进传达，中等", ""],
      ["中段", "虚线一路跟到底，认得出", "good"],
      ["重量", "轻，没有盒子", "good"],
      ["成本", "中 · 同 B，需要段起止", ""],
    ],
    caveat: "注意：现有「系统代写消息」和「旁注」已经各占一条左竖线，同屏三种竖线会互相稀释。",
  },
  {
    key: "D",
    cls: "opt-d",
    name: "D · 折叠结论卡",
    lead: "默认只留一张卡：轮次 · 谁在审 · 结论 · 用时。点「展开」才显示全文（展开态就是方案 B）。这里默认折叠，点一下看展开态。",
    facts: [
      ["边界", "折叠时就是一行，无从谈起", "good"],
      ["中段", "折叠时没有中段", "good"],
      ["重量", "主线最干净，长审查不再淹没正文", "good"],
      ["成本", "中 · B 的成本 + 一条折叠规则", ""],
    ],
    caveat: "正在跑的那一轮必须默认展开，否则用户盯着一张不动的卡片，不知道里面在干什么。",
    collapsed: true,
  },
  {
    key: "E",
    cls: "opt-e",
    name: "E · 泳道 + 吸顶段头",
    lead: "B 再加一条：段头在会话滚动时吸顶。这一格的验证正文特意加长了，往下滚就能看到段头钉在顶上。",
    facts: [
      ["边界", "同 B", "good"],
      ["中段", "最强 · 滚多远都知道还在第 2 轮里", "good"],
      ["重量", "同 B，再多一条常驻横条", "risk"],
      ["成本", "中高 · B + 吸顶层级与贴底逻辑要重测", "risk"],
    ],
  },
];

const template = document.getElementById("feed-template");
const stagesRoot = document.querySelector(".demo-stages");
const navList = document.querySelector(".demo-nav-list");

function factsMarkup(facts) {
  return facts
    .map(([label, value, tone]) => {
      const cls = tone === "good" ? " class=\"is-good\"" : tone === "risk" ? " class=\"is-risk\"" : "";
      return `<div><dt>${label}</dt><dd${cls}>${value}</dd></div>`;
    })
    .join("");
}

function buildStage(option) {
  const stage = document.createElement("section");
  stage.className = "demo-stage";
  stage.dataset.key = option.key;
  stage.id = `opt-${option.key.toLowerCase()}`;

  const title = option.name.split(" · ").slice(1).join(" · ") || option.name;
  const head = document.createElement("div");
  head.className = "demo-stage-head";
  head.innerHTML = `
    <div>
      <h2><em>${option.key === "0" ? "○" : option.key}</em>${title}</h2>
      <p>${option.lead}${option.caveat ? `<br><b>${option.caveat}</b>` : ""}</p>
    </div>
    <dl class="demo-facts">${factsMarkup(option.facts)}</dl>`;

  const window_ = document.createElement("div");
  window_.className = `app-window ${option.cls}`;
  window_.innerHTML = `
    <div class="app-topbar">
      <span class="status-pill">进行中</span>
      <div><b>拆分 controls.css</b></div>
      <small>ash · feat/free-pipeline</small>
    </div>
    <div class="task-conversation"></div>`;
  window_.querySelector(".task-conversation").append(template.content.cloneNode(true));

  if (option.collapsed) window_.querySelector(".verify-lane")?.classList.add("is-collapsed");
  // 对照组不该看见任何「未来才有」的零件：段头、徽标、盾形头像全归 CSS 控制，
  // 这里只需要把折叠按钮的初始文案对上。
  syncToggle(window_.querySelector(".verify-lane"));

  stage.append(head, window_);
  return stage;
}

function syncToggle(lane) {
  if (!lane) return;
  const toggle = lane.querySelector(".verify-lane-toggle");
  if (!toggle) return;
  const collapsed = lane.classList.contains("is-collapsed");
  toggle.textContent = collapsed ? "展开" : "收起";
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

for (const option of OPTIONS) stagesRoot.append(buildStage(option));

stagesRoot.addEventListener("click", (event) => {
  const toggle = event.target.closest(".verify-lane-toggle");
  if (!toggle) return;
  const lane = toggle.closest(".verify-lane");
  lane.classList.toggle("is-collapsed");
  syncToggle(lane);
});

// 筛选：全部 / 单个方案。默认全部，方便竖着滚下来比。
const FILTERS = [{ key: "all", label: "全部并排" }, ...OPTIONS.map((o) => ({ key: o.key, label: o.name }))];
let active = "all";

function renderNav() {
  navList.replaceChildren(
    ...FILTERS.map((filter) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = filter.label;
      button.setAttribute("aria-pressed", String(active === filter.key));
      button.addEventListener("click", () => {
        active = filter.key;
        applyFilter();
        renderNav();
      });
      return button;
    }),
  );
}

function applyFilter() {
  for (const stage of stagesRoot.querySelectorAll(".demo-stage")) {
    stage.hidden = active !== "all" && stage.dataset.key !== active;
  }
}

renderNav();
applyFilter();
