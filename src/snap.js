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

// Разные threshold'ы: edge-to-edge и center-to-center (CX-CX, CY-CY).
// Все остальные пары (edge-to-center, center-to-edge) используют edge
// threshold. Причина: центрирование — визуально менее очевидное намерение,
// делаем менее липким (Юрий: «липкость центров на две трети»).
function _pairThreshold(src, dst, thresholds) {
  const bothCenter = (src === dst) && (src === 'CX' || src === 'CY');
  return bothCenter ? thresholds.center : thresholds.edge;
}

export function computeSnap(target, neighbors, thresholds) {
  // thresholds: number (legacy — используем как edge, center=edge/3)
  //        или {edge, center} — обе в world units.
  if (typeof thresholds === 'number') {
    thresholds = { edge: thresholds, center: thresholds / 3 };
  }
  const t = edges(target);
  let bestX = null; // {delta, guide}
  let bestY = null;

  for (const n of neighbors) {
    const e = edges(n);
    for (const src of ['L', 'R', 'CX']) {
      for (const dst of ['L', 'R', 'CX']) {
        const delta = e[dst] - t[src];
        const abs = Math.abs(delta);
        const th = _pairThreshold(src, dst, thresholds);
        if (abs < th) {
          if (bestX == null || abs < Math.abs(bestX.delta)) {
            bestX = {
              delta,
              guide: {
                axis: 'x',
                pos: e[dst],
                from: Math.min(n.y, target.y),
                to: Math.max(n.y + n.h, target.y + target.h),
              },
            };
          }
        }
      }
    }
    for (const src of ['T', 'B', 'CY']) {
      for (const dst of ['T', 'B', 'CY']) {
        const delta = e[dst] - t[src];
        const abs = Math.abs(delta);
        const th = _pairThreshold(src, dst, thresholds);
        if (abs < th) {
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

// BRD-31 Stage 4: snap для resize.
// Для каждой affected edge (перечислены в activeEdges — subset из
// ['left', 'right', 'top', 'bottom']) считаем ближайший neighbor edge
// в пределах threshold и возвращаем corrections.
//
// Return: {snapLeft, snapRight, snapTop, snapBottom, guides} — только
// заданные keys для affected edges.
export function computeResizeSnap(target, activeEdges, neighbors, thresholdWorld) {
  const t = edges(target);
  const result = { guides: [] };
  const active = new Set(activeEdges);

  // Для each active edge — соответствующая source line.
  const axes = [
    { edge: 'left', src: 'L', axis: 'x' },
    { edge: 'right', src: 'R', axis: 'x' },
    { edge: 'top', src: 'T', axis: 'y' },
    { edge: 'bottom', src: 'B', axis: 'y' },
  ];

  for (const spec of axes) {
    if (!active.has(spec.edge)) continue;
    // Ищем ближайший neighbor edge на той же оси (L, R для x; T, B для y).
    // Центры при resize не snap'ятся (визуально бессмысленно).
    const dstNames = spec.axis === 'x' ? ['L', 'R'] : ['T', 'B'];
    let best = null;
    for (const n of neighbors) {
      const e = edges(n);
      for (const dst of dstNames) {
        const delta = e[dst] - t[spec.src];
        const abs = Math.abs(delta);
        if (abs < thresholdWorld) {
          if (best == null || abs < Math.abs(best.delta)) {
            best = {
              delta,
              guide: spec.axis === 'x'
                ? { axis: 'x', pos: e[dst], from: Math.min(n.y, target.y), to: Math.max(n.y + n.h, target.y + target.h) }
                : { axis: 'y', pos: e[dst], from: Math.min(n.x, target.x), to: Math.max(n.x + n.w, target.x + target.w) },
            };
          }
        }
      }
    }
    if (best) {
      result[`snap${spec.edge.charAt(0).toUpperCase()}${spec.edge.slice(1)}`] = best.delta;
      result.guides.push(best.guide);
    }
  }
  return result;
}
