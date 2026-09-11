import type { AnnotationReviewStatus } from "@ash/shared/page-annotation-review";

export function createReviewStatusReader(fetchStatus: () => Promise<AnnotationReviewStatus>) {
  let epoch = 0;
  let pending: Promise<AnnotationReviewStatus | null> | null = null;
  return {
    invalidate: () => { epoch++; },
    read: () => {
      if (pending) return pending;
      const version = epoch;
      pending = fetchStatus().then((result) => version === epoch ? result : null)
        .finally(() => { pending = null; });
      return pending;
    },
  };
}
