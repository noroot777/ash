// 派出去那几处「谁来审」在审查者清单没读到时的契约（shared/src/review-on-create.ts `concreteReviewChoice`、
// src/free-workflow/useReviewerList.ts `reviewHold`）：
//  · 清单没读到（在读 / 读失败）时，只有「不审查」定得下来、派得出去；默认和指定的一位都给 null、派出键停着，
//    不拿看不出是谁的选择派出去（服务端会照样按默认带预约，用户却没确认过是谁）；
//  · 读失败和还在读说的话不一样：失败要告诉人能重新读、或改成不审查；
//  · 读到了：默认落成那一位，指定的照 id 或唯一的名字，没设默认落成不审查，都不拦；
//  · 读到了、指定的那一位却认不出（接力过来的、删掉了、重名）：不读成不审查——给 null、派出键停着，说清是哪一位。
// 跑：npm -w web run test:review-choice
import assert from "node:assert/strict";
import { concreteReviewChoice, missingReviewer } from "../../shared/src/review-on-create.ts";
import { reviewHold } from "../src/free-workflow/useReviewerList.ts";

const alpha = { id: "a", name: "alpha", isDefault: true };
const beta = { id: "b", name: "beta", isDefault: false };
const loading = { reviewers: null, failed: false, retry() {} };
const failed = { reviewers: null, failed: true, retry() {} };
const loaded = { reviewers: [alpha, beta], failed: false, retry() {} };

for (const list of [loading, failed]) {
  assert.equal(concreteReviewChoice("default", list.reviewers), null, "没读到：默认定不下来");
  assert.equal(concreteReviewChoice({ reviewer: "b" }, list.reviewers), null, "没读到：指定的一位也定不下来");
  assert.equal(concreteReviewChoice("none", list.reviewers), "none", "没读到：不审查照样能派");
  assert.equal(reviewHold("none", list), null);
  assert.ok(reviewHold("default", list), "没读到：派出键停着");
  assert.ok(reviewHold({ reviewer: "b" }, list));
}
assert.match(reviewHold("default", failed), /重新读取/, "读失败：说能重新读");
assert.match(reviewHold("default", failed), /不审查/, "读失败：说能改成不审查");
assert.doesNotMatch(reviewHold("default", loading), /重新读取/, "还在读：不说失败");

assert.deepEqual(concreteReviewChoice("default", loaded.reviewers), { reviewer: "a" });
assert.deepEqual(concreteReviewChoice({ reviewer: "beta" }, loaded.reviewers), { reviewer: "b" }, "名字认唯一那位");
assert.equal(concreteReviewChoice({ reviewer: "gone" }, loaded.reviewers), null, "认不出指定的那一位：不读成不审查，派不出去");
assert.equal(missingReviewer({ reviewer: "gone" }, loaded.reviewers), "gone");
assert.match(reviewHold({ reviewer: "gone" }, loaded), /认不出指定的审查者「gone」/, "派出键说清是哪一位认不出");
assert.equal(concreteReviewChoice({ reviewer: "alpha" }, [alpha, { ...beta, name: "alpha" }]), null, "重名：认不出是哪一位，同样停着");
assert.equal(missingReviewer("default", [beta]), null, "默认那一档不算认不出");
assert.equal(concreteReviewChoice("default", [beta]), "none", "没设默认：不审查");
assert.equal(concreteReviewChoice("default", []), "none");
for (const choice of ["default", "none", { reviewer: "b" }]) assert.equal(reviewHold(choice, loaded), null, "读到了、认得出：都不拦");

console.log("review-choice: ok");
