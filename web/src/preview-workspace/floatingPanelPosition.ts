type Rect = { left: number; top: number; width: number; height: number };

export function floatingPanelPosition(panel: Rect, bounds: Rect, obstacles: Rect[]) {
  const gap = 8;
  const clampX = (x: number) => Math.max(bounds.left, Math.min(x, bounds.left + bounds.width - panel.width));
  const clampY = (y: number) => Math.max(bounds.top, Math.min(y, bounds.top + bounds.height - panel.height));
  const desired = { left: clampX(panel.left), top: clampY(panel.top) };
  const xs = [desired.left, bounds.left, bounds.left + bounds.width - panel.width];
  const ys = [desired.top, bounds.top, bounds.top + bounds.height - panel.height];
  for (const other of obstacles) {
    xs.push(other.left - panel.width - gap, other.left + other.width + gap);
    ys.push(other.top - panel.height - gap, other.top + other.height + gap);
  }
  let best = desired, bestOverlap = Infinity, bestDistance = Infinity;
  for (const left of xs.map(clampX)) for (const top of ys.map(clampY)) {
    const overlap = obstacles.reduce((area, other) => area
      + Math.max(0, Math.min(left + panel.width, other.left + other.width + gap) - Math.max(left, other.left - gap))
      * Math.max(0, Math.min(top + panel.height, other.top + other.height + gap) - Math.max(top, other.top - gap)), 0);
    const distance = (left - desired.left) ** 2 + (top - desired.top) ** 2;
    // Prefer the nearest clear placement. An undersized viewport uses the least covered one.
    if (overlap < bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
      best = { left, top }; bestOverlap = overlap; bestDistance = distance;
    }
  }
  return best;
}
