const cards = [...document.querySelectorAll(".review-card")];
const reviewEvents = [...document.querySelectorAll("[data-review-event]")];
const dock = document.querySelector(".review-dock");
const dockToggle = document.querySelector(".dock-toggle");
const dockBody = document.querySelector(".review-dock-body");
const dockHint = document.querySelector(".dock-hint");
let activeReview = null;

function setCardOpen(card, open) {
  card.classList.toggle("is-open", open);
  const button = card.querySelector(".review-toggle");
  const detail = card.querySelector(".review-detail");
  button.setAttribute("aria-expanded", String(open));
  detail.setAttribute("aria-hidden", String(!open));
}

function setDockOpen(open, reviewNumber = activeReview) {
  activeReview = open ? reviewNumber : null;
  dock.classList.toggle("is-open", open);
  dock.setAttribute("aria-expanded", String(open));
  dockToggle.setAttribute("aria-expanded", String(open));
  dockBody.setAttribute("aria-hidden", String(!open));
  dockBody.inert = !open;
  dockHint.textContent = open && activeReview
    ? `已打开第 ${activeReview} 次审查 · 再点上方同一审查收起`
    : "点上方某个审查查看详情";

  for (const event of reviewEvents) {
    const selected = open && event.dataset.reviewEvent === activeReview;
    event.classList.toggle("is-selected", selected);
    event.querySelector(".review-event-trigger").setAttribute("aria-expanded", String(selected));
  }

  for (const card of cards) {
    setCardOpen(card, open && card.dataset.review === activeReview);
  }
}

for (const event of reviewEvents) {
  const button = event.querySelector(".review-event-trigger");
  button.addEventListener("click", () => {
    const reviewNumber = event.dataset.reviewEvent;
    const isSameOpenReview = dock.classList.contains("is-open") && activeReview === reviewNumber;
    setDockOpen(!isSameOpenReview, reviewNumber);
  });
}

dockToggle.addEventListener("click", () => {
  setDockOpen(!dock.classList.contains("is-open"), activeReview ?? "1");
});

for (const card of cards) {
  const button = card.querySelector(".review-toggle");
  button.addEventListener("click", () => {
    const shouldOpen = !card.classList.contains("is-open");
    activeReview = card.dataset.review;
    for (const other of cards) setCardOpen(other, other === card && shouldOpen);
    for (const event of reviewEvents) {
      const selected = shouldOpen && event.dataset.reviewEvent === activeReview;
      event.classList.toggle("is-selected", selected);
      event.querySelector(".review-event-trigger").setAttribute("aria-expanded", String(selected));
    }
    dockHint.textContent = shouldOpen
      ? `已打开第 ${activeReview} 次审查 · 再点上方同一审查收起`
      : "点上方某个审查查看详情";
    if (shouldOpen) {
      window.setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "nearest" }), 120);
    }
  });
}

const duration = document.querySelector(".live-duration");
const startedAt = Date.now();

function updateDuration() {
  if (!duration) return;
  const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  if (elapsedSeconds < 60) {
    duration.textContent = elapsedSeconds < 5 ? "刚刚开始" : `已运行 ${elapsedSeconds} 秒`;
    return;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  duration.textContent = `已运行 ${minutes} 分钟`;
}

updateDuration();
window.setInterval(updateDuration, 1000);
