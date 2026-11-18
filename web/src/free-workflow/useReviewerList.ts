// 派出去那几处「谁来审」要的审查者清单（含哪一位是默认）。清单本身只从 reviewerProfilesStore 来，这里只管
// 挂上时读一次、窗口回到前台再读一次（在设置里改了默认，切回来就对上）；不轮询，理由见那边的 `listen`。
// null = 还没读到：这时派出去交「默认」，由服务端按派出那一刻的默认认（shared/src/review-on-create.ts）。
import { useEffect, useState } from "react";
import type { ReviewerProfile } from "@ash/shared";
import { reviewerProfilesStore } from "./reviewerProfilesStore.ts";

export function useReviewerList(active = true): ReviewerProfile[] | null {
  const [list, setList] = useState<ReviewerProfile[] | null>(() => reviewerProfilesStore.current());
  useEffect(() => {
    if (!active) return;
    const sync = () => setList(reviewerProfilesStore.current());
    const read = () => { void reviewerProfilesStore.read().then(sync).catch(() => {}); };
    const onFocus = () => { if (document.visibilityState !== "hidden") read(); };
    const stop = reviewerProfilesStore.listen(sync);
    read();
    window.addEventListener("focus", onFocus);
    return () => {
      stop();
      window.removeEventListener("focus", onFocus);
    };
  }, [active]);
  return list;
}
