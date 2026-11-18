// 派出去那几处「谁来审」要的审查者清单（含哪一位是默认）。清单本身只从 reviewerProfilesStore 来，这里只管
// 挂上时读一次、窗口回到前台再读一次（在设置里改了默认，切回来就对上）；不轮询，理由见那边的 `listen`。
//
// 三种状态都要分得出来：读到了（`reviewers` 是清单）、还在读、读失败了（`reviewers` 都是 null，靠 `failed` 分）。
// 没读到的时候画面上看不出交给谁审，这时只有「不审查」能派（shared/src/review-on-create.ts `concreteReviewChoice`），
// 派出键由 `reviewHold` 说清为什么停着；读失败了胶囊里能重新读（ReviewerChip.tsx）。
import { useCallback, useEffect, useState } from "react";
import type { ReviewerProfile } from "@ash/shared";
import { concreteReviewChoice, type CreateReviewChoice } from "@ash/shared/review-on-create";
import { reviewerProfilesStore } from "./reviewerProfilesStore.ts";

export type ReviewerList = {
  /** null = 还没读到（在读，或读失败了）。 */
  reviewers: ReviewerProfile[] | null;
  /** 读失败了、手里也没有一份旧清单。 */
  failed: boolean;
  retry: () => void;
};

export function useReviewerList(active = true): ReviewerList {
  const [list, setList] = useState<ReviewerProfile[] | null>(() => reviewerProfilesStore.current());
  const [failed, setFailed] = useState(false);
  const read = useCallback(() => {
    setFailed(false);
    void reviewerProfilesStore.read()
      .then(() => setList(reviewerProfilesStore.current()))
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (!active) return;
    const sync = () => setList(reviewerProfilesStore.current());
    const onFocus = () => { if (document.visibilityState !== "hidden") read(); };
    const stop = reviewerProfilesStore.listen(sync);
    read();
    window.addEventListener("focus", onFocus);
    return () => {
      stop();
      window.removeEventListener("focus", onFocus);
    };
  }, [active, read]);
  return { reviewers: list, failed: failed && list === null, retry: read };
}

/** 这个选择现在派不派得出去；派不出去时给一句原因（挂在派出键上）。 */
export function reviewHold(choice: CreateReviewChoice, list: ReviewerList): string | null {
  if (concreteReviewChoice(choice, list.reviewers)) return null;
  return list.failed ? "没读到审查者清单，确认不了交给谁审：在「谁来审」里重新读取，或改成不审查" : "正在读审查者清单";
}
