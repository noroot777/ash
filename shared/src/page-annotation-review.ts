import type { PreviewElementCard, PreviewPageContext } from "./page-annotation.ts";

export type AnnotationVerdict = "satisfied" | "continue";
export interface AnnotationReview {
  releasedAt: string | null;
  roundStatus: string | null;
  decisions: Array<{ itemId: string; verdict: AnnotationVerdict; savedAt: string; gen: string }>;
}
export interface AnnotationReviewStatus {
  canReopen: boolean;
  reason: string;
  taskStatus: string;
  previewKind: "free" | "workflow";
}
export interface AnnotationMatch {
  id: string;
  requestId: string;
  reliable: boolean;
  score: number;
  reason: string;
  element: PreviewElementCard | null;
}
export type MatchFeatures = Pick<PreviewElementCard, "text" | "tag" | "role" | "rect">;

// This function is also embedded in the preview runtime, so it has no module dependencies.
export function scoreAnnotationCandidate(target: MatchFeatures, candidate: MatchFeatures,
  before: PreviewPageContext, after: PreviewPageContext, selectorMatch: boolean): number {
  const a = target.text.toLowerCase().replace(/\s+/g, " ").trim();
  const b = candidate.text.toLowerCase().replace(/\s+/g, " ").trim();
  let textScore = 0;
  if (a && b) {
    if (a === b) textScore = 1;
    else {
      const left = new Set(Array.from(a, (_, i) => a.slice(i, i + 2)));
      const right = new Set(Array.from(b, (_, i) => b.slice(i, i + 2)));
      textScore = 2 * [...left].filter((part) => right.has(part)).length / (left.size + right.size);
    }
  }
  const role = !!target.role && target.role === candidate.role;
  const tag = target.tag === candidate.tag;
  const x = (target.rect.x + before.scroll.x + target.rect.width / 2) / Math.max(1, before.viewport.width);
  const y = (target.rect.y + before.scroll.y + target.rect.height / 2) / Math.max(1, before.viewport.height);
  const cx = (candidate.rect.x + after.scroll.x + candidate.rect.width / 2) / Math.max(1, after.viewport.width);
  const cy = (candidate.rect.y + after.scroll.y + candidate.rect.height / 2) / Math.max(1, after.viewport.height);
  const position = Math.max(0, 1 - Math.hypot(x - cx, y - cy));
  // Reused selectors and generic empty containers are insufficient evidence of identity.
  if (a ? textScore < .55 : !role || !selectorMatch || !tag) return 0;
  return textScore * .4 + (role ? .15 : 0) + (tag ? .1 : 0) + position * .15 + (selectorMatch ? .2 : 0)
    + (!a && role ? .25 : 0);
}

export function reliableAnnotationMatch(scores: number[]): boolean {
  return scores.length > 0 && scores[0] >= .72 && (scores.length === 1 || scores[0] - scores[1] >= .12);
}
