// BRD-31 Stage 0: snap alignment primitive (Miro-style edge snapping).
//
// computeSnap(targetBbox, neighborBboxes, thresholdWorld) → {dx, dy, guides}.
// - targetBbox: {x, y, w, h} — bbox драгаемого элемента (или union group).
// - neighborBboxes: Array<{x, y, w, h}> — все не-моющиеся элементы.
// - thresholdWorld: max distance для snap (в canvas world units).
//
// Возвращает:
// - dx, dy — коррекция позиции target'а, чтобы прилипнуть.
// - guides: Array<{axis, pos, from, to}> — координаты для рендера guide
//   lines в overlay. `axis: 'x'` — вертикальная линия при x=pos от y=from
//   до y=to. `axis: 'y'` — горизонтальная, y=pos, x∈[from, to].
//
// Snap targets per bbox: L (x), R (x+w), CX (x+w/2), T (y), B (y+h),
// CY (y+h/2). Проверяются все 3×3 = 9 pairs per axis per neighbor.
// Выбирается min-|delta| глобально на каждую ось (X и Y независимо).

function edges(b) {
  return {
    L: b.x,
    R: b.x + b.w,
    CX: b.x + b.w / 2,
    T: b.y,
    B: b.y + b.h,
    CY: b.y + b.h / 2,
  };
}

export function computeSnap(target, neighbors, thresholdWorld) {
  const t = edges(target);
  let bestX = null; // {delta, guide}
  let bestY = null;

  for (const n of neighbors) {
    const e = edges(n);
    // X axis pairs (source: L/R/CX of target vs L/R/CX of neighbor).
    for (const src of ['L', 'R', 'CX']) {
      for (const dst of ['L', 'R', 'CX']) {
        const delta = e[dst] - t[src];
        const abs = Math.abs(delta);
        if (abs < thresholdWorld) {
          if (bestX == null || abs < Math.abs(bestX.delta)) {
            bestX = {
              delta,
              guide: {
                axis: 'x',
                pos: e[dst],
                from: Math.min(t.T + delta * 0, n.y, target.y),
                to: Math.max(t.B + delta * 0, n.y + n.h, target.y + target.h),
              },
            };
          }
        }
      }
    }
    // Y axis pairs.
    for (const src of ['T', 'B', 'CY']) {
      for (const dst of ['T', 'B', 'CY']) {
        const delta = e[dst] - t[src];
        const abs = Math.abs(delta);
        if (abs < thresholdWorld) {
          if (bestY == null || abs < Math.abs(bestY.delta)) {
            bestY = {
              delta,
              guide: {
                axis: 'y',
                pos: e[dst],
                from: Math.min(n.x, target.x),
                to: Math.max(n.x + n.w, target.x + target.w),
              },
            };
          }
        }
      }
    }
  }

  const guides = [];
  if (bestX) guides.push(bestX.guide);
  if (bestY) guides.push(bestY.guide);

  return {
    dx: bestX ? bestX.delta : 0,
    dy: bestY ? bestY.delta : 0,
    guides,
  };
}
