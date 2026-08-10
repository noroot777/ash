const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  taskStatus: $("#taskStatus"), livePill: $("#livePill"), reviewBadge: $("#reviewBadge"),
  mergedBanner: $("#mergedBanner"), mergeButton: $("#mergeButton"), preReviewButton: $("#preReviewButton"),
  copyCommit: $("#copyCommit"),
  previewButton: $("#previewButton"), postReviewButton: $("#postReviewButton"), postReviewLabel: $("#postReviewLabel"),
  snapshotButton: $("#snapshotButton"), snapshotCard: $("#snapshotCard"), reviewCard: $("#reviewCard"),
  mergeTimelineItem: $("#mergeTimelineItem"), mergeTimelineText: $("#mergeTimelineText"), mergeTimelineTime: $("#mergeTimelineTime"),
  reviewTimelineItem: $("#reviewTimelineItem"), reviewTimelineText: $("#reviewTimelineText"), reviewTimelineTime: $("#reviewTimelineTime"),
  mergeEvent: $("#mergeEvent"), mergeEventTitle: $("#mergeEventTitle"), mergeEventText: $("#mergeEventText"), mergeEventTime: $("#mergeEventTime"),
  reviewEvent: $("#reviewEvent"), reviewEventTitle: $("#reviewEventTitle"), reviewEventText: $("#reviewEventText"), reviewEventTime: $("#reviewEventTime"),
  reviewStatus: $("#reviewStatus"), reviewSubtitle: $("#reviewSubtitle"), reviewRunning: $("#reviewRunning"),
  reviewResult: $("#reviewResult"), resultIcon: $("#resultIcon"), resultTitle: $("#resultTitle"), resultText: $("#resultText"),
  reviewActions: $("#reviewActions"), simulationActions: $("#simulationActions"), repairCard: $("#repairCard"),
  mergeModal: $("#mergeModal"), reviewModal: $("#reviewModal"), toast: $("#toast"),
};

let state = "ready";
let previewOpen = false;
let repairCreated = false;
let toastTimer;

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2200);
}

function openModal(modal) {
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeModal(modal) {
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
}

function mark(item, kind) {
  item.classList.remove("is-done", "is-active", "is-failed");
  if (kind) item.classList.add(kind);
}

function render() {
  const merged = ["merged", "reviewing", "failed", "passed"].includes(state);
  const reviewing = state === "reviewing";
  const failed = state === "failed";
  const passed = state === "passed";

  $$('[data-demo-state]').forEach((button) => button.classList.toggle("is-active", button.dataset.demoState === state));
  els.taskStatus.textContent = failed ? "已合并 · 审查未过" : reviewing ? "已合并 · 审查中" : merged ? "已合并" : state === "merging" ? "合并中" : "实现完成";
  els.taskStatus.className = `task-status${merged && !failed ? " is-merged" : ""}${failed ? " is-warning" : ""}`;
  els.livePill.textContent = reviewing ? "审查运行中" : failed ? "需要处理" : passed ? "全部通过" : merged ? "已合并" : state === "merging" ? "正在合并" : "等待操作";
  els.livePill.className = `live-pill${reviewing || state === "merging" ? " is-live" : ""}${merged && !reviewing && !failed ? " is-done" : ""}`;

  els.mergedBanner.classList.toggle("is-visible", merged);
  els.preReviewButton.style.display = merged ? "none" : "inline-flex";
  els.previewButton.style.display = merged ? "none" : "inline-flex";
  els.mergeButton.style.display = merged ? "none" : "inline-flex";
  els.mergeButton.disabled = state === "merging";
  els.mergeButton.classList.toggle("is-busy", state === "merging");
  els.mergeButton.querySelector("span:last-child").textContent = state === "merging" ? "合并中…" : "合并&清理";
  els.postReviewButton.classList.toggle("is-visible", merged);
  els.snapshotButton.classList.toggle("is-visible", merged);
  els.postReviewButton.disabled = reviewing;
  els.postReviewButton.classList.toggle("is-busy", reviewing);
  els.postReviewLabel.textContent = reviewing ? "基线审查中" : failed || passed ? "再审一轮" : "审查已合并结果";

  mark(els.mergeTimelineItem, state === "merging" ? "is-active" : merged ? "is-done" : "");
  els.mergeTimelineItem.querySelector(".rail-dot").textContent = merged ? "✓" : state === "merging" ? "↗" : "3";
  els.mergeTimelineText.textContent = state === "merging" ? "正在锁定 commit 并清理任务 worktree" : merged ? "main · 5a13d70 → 8f41c2d · 已清理" : "等待你确认不可逆操作";
  els.mergeTimelineTime.textContent = merged ? "10:53" : state === "merging" ? "现在" : "—";

  const reviewMark = reviewing ? "is-active" : failed ? "is-failed" : passed ? "is-done" : "";
  mark(els.reviewTimelineItem, reviewMark);
  els.reviewTimelineItem.querySelector(".rail-dot").textContent = passed ? "✓" : failed ? "!" : reviewing ? "⌕" : "4";
  els.reviewTimelineText.textContent = reviewing ? "正在临时 detached worktree 中检查" : failed ? "发现 1 个集成问题，等待处理" : passed ? "main@8f41c2d 已通过最终审查" : "合并后检查最终集成状态";
  els.reviewTimelineTime.textContent = reviewing ? "进行中" : failed || passed ? "11:06" : "—";

  els.mergeEvent.classList.toggle("is-visible", !merged || state === "merging");
  els.mergeEventTitle.textContent = state === "merging" ? "正在安全合并并清理" : "等待执行“合并&清理”";
  els.mergeEventText.textContent = state === "merging" ? "记录 main 前后 commit · 删除任务 worktree 与分支" : "目标 main · 安全合并 · 清理任务 worktree 与分支";
  els.mergeEventTime.textContent = state === "merging" ? "进行中" : "现在";
  els.reviewEvent.classList.toggle("is-visible", merged);
  els.reviewEventTitle.textContent = reviewing ? "合并后基线审查正在运行" : failed ? "合并后审查发现问题" : passed ? "合并后基线审查通过" : "可以审查已合并结果";
  els.reviewEventText.textContent = reviewing ? "main@8f41c2d · 临时 detached worktree" : failed ? "P1 · 已合并状态保持不变" : passed ? "构建、测试与浏览器点检全部通过" : "对象已锁定为 main@8f41c2d";
  els.reviewEventTime.textContent = reviewing ? "进行中" : failed || passed ? "11:06" : "现在";

  els.snapshotCard.classList.toggle("is-visible", merged);
  els.reviewCard.classList.toggle("is-visible", merged);
  els.reviewRunning.classList.toggle("is-visible", reviewing);
  els.reviewResult.classList.toggle("is-visible", failed || passed);
  els.reviewResult.classList.toggle("is-passed", passed);
  els.reviewActions.classList.toggle("is-visible", failed);
  els.simulationActions.classList.toggle("is-visible", reviewing);
  els.repairCard.classList.toggle("is-visible", repairCreated && failed);
  els.reviewBadge.textContent = failed || passed ? "2" : "1";

  els.reviewStatus.textContent = reviewing ? "运行中" : failed ? "未通过" : passed ? "已通过" : "待开始";
  els.reviewStatus.className = `review-status${reviewing ? " is-running" : ""}${failed ? " is-failed" : ""}${passed ? " is-passed" : ""}`;
  els.reviewSubtitle.textContent = reviewing ? "Codex · 逻辑检查 · main@8f41c2d" : failed ? "第 1 轮 · 发现问题" : passed ? "第 1 轮 · 最终集成验证通过" : "尚未启动";
  if (passed) {
    els.resultIcon.textContent = "✓";
    els.resultTitle.textContent = "最终集成状态符合预期";
    els.resultText.textContent = "构建、测试和浏览器真实点检全部通过；临时审查 worktree 已清理。";
  } else {
    els.resultIcon.textContent = "!";
    els.resultTitle.textContent = "发现 1 个集成问题";
    els.resultText.textContent = "主分支上的清理入口仍引用已经删除的任务 worktree。";
  }
}

function setState(next) {
  state = next;
  if (next !== "failed") repairCreated = false;
  render();
}

$$('[data-demo-state]').forEach((button) => button.addEventListener("click", () => setState(button.dataset.demoState)));
els.mergeButton.addEventListener("click", () => openModal(els.mergeModal));
els.postReviewButton.addEventListener("click", () => openModal(els.reviewModal));
els.snapshotButton.addEventListener("click", () => { els.snapshotCard.scrollIntoView({ behavior: "smooth", block: "center" }); showToast("已定位到不可变审查快照"); });
els.preReviewButton.addEventListener("click", () => showToast("这是合并前的任务产物审查；本 demo 重点展示合并后的第二种审查"));
els.previewButton.addEventListener("click", () => { previewOpen = !previewOpen; els.previewButton.querySelector("span:last-child").textContent = previewOpen ? "关闭预览" : "打开预览"; showToast(previewOpen ? "预览已打开" : "预览已关闭"); });
els.copyCommit.addEventListener("click", () => showToast("已复制 8f41c2d"));

$("#confirmMerge").addEventListener("click", () => {
  closeModal(els.mergeModal);
  setState("merging");
  setTimeout(() => { setState("merged"); showToast("已安全合并到 main，并记录审查快照 8f41c2d"); }, 1100);
});
$("#confirmReview").addEventListener("click", () => {
  closeModal(els.reviewModal);
  setState("reviewing");
  showToast("已在临时 detached worktree 启动基线审查");
});
$$('[data-result]').forEach((button) => button.addEventListener("click", () => setState(button.dataset.result)));
$("#createRepair").addEventListener("click", () => { repairCreated = true; render(); showToast("已基于 main@8f41c2d 创建修复任务 FIX-204"); });
$("#retryReview").addEventListener("click", () => setState("reviewing"));
$("#acceptRisk").addEventListener("click", () => { setState("passed"); showToast("风险已确认；原审查报告仍保留"); });

$$('[data-close-modal]').forEach((button) => button.addEventListener("click", () => closeModal(button.closest(".modal-backdrop"))));
$$('.modal-backdrop').forEach((modal) => modal.addEventListener("click", (event) => { if (event.target === modal) closeModal(modal); }));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") $$('.modal-backdrop.is-open').forEach(closeModal); });

render();
