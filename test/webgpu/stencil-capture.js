// ============================================================
// stencil-fill fixture capture — browser half (W2).
// Driven by scripts/oracle-stencil.mjs --capture.
//
// Wraps every 2d context handed out by getContext() in a recording proxy
// BEFORE importing the fork's dist build, then runs one seeded
// watercolor fill (brush.fill + rect). Every canvas2d command the fill
// mask receives — polygon paths, per-layer fill/stroke styles,
// destination-out erase circles — is recorded with the live transform
// baked in (mask device-pixel space), giving:
//
//   - a REAL self-intersecting polygon produced by FillPoly.grow()
//     (plan gotcha #5), chosen so it has probe-able single-winding and
//     double-winding interior regions for the overlap-counts-once
//     assertion;
//   - a real border polygon + its per-layer lineWidth (gotcha #6);
//   - real erase circle batches;
//   - the FULL command stream of one createFill() for the whole-fill
//     replay + encoder-overhead measurement.
//
// Exposes window.__fixture (JSON-ready) or window.__fixtureError.
// Deterministic: fixed seed, no Date.now(), no animation.
// ============================================================

const statusEl = document.getElementById("status");

const SEED = "stencil-0";
const CANVAS = 300;

// ---------------------------------------------------------------------------
// Recording 2d-context proxy
// ---------------------------------------------------------------------------

const recorders = [];

function parseAlpha(style) {
  // upstream writes "rgb(255 0 0 / 2.6%)" but the canvas style GETTER
  // returns the normalized serialization "rgba(255, 0, 0, 0.026)".
  const s = String(style);
  const clamp = (v) => Math.min(1, Math.max(0, v));
  let m = /\/\s*([\d.eE+-]+)\s*(%)?\s*\)/.exec(s);
  if (m) return clamp(m[2] ? Number(m[1]) / 100 : Number(m[1]));
  m = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.eE+-]+)\s*\)/.exec(s);
  if (m) return clamp(Number(m[1]));
  return 1; // opaque serializations ("#ff0000", "rgb(255, 0, 0)")
}

function wrapContext(ctx) {
  const rec = { ops: [], canvas: ctx.canvas };
  recorders.push(rec);
  let path = null; // { id, verts: number[], circles: number[][] }
  let nextPathId = 1;

  const round = (v) => Math.round(v * 100) / 100;
  function transformed(x, y) {
    const m = ctx.getTransform();
    return [round(m.a * x + m.c * y + m.e), round(m.b * x + m.d * y + m.f)];
  }
  function uniformScale() {
    const m = ctx.getTransform();
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    return (sx + sy) / 2;
  }

  const handler = {
    get(t, prop) {
      const v = t[prop];
      if (typeof v !== "function") return v;
      return function (...args) {
        switch (prop) {
          case "beginPath":
            path = { id: nextPathId++, verts: [], circles: [] };
            break;
          case "moveTo":
          case "lineTo":
            if (path) path.verts.push(...transformed(args[0], args[1]));
            break;
          case "arc":
            if (path) {
              const [cx, cy] = transformed(args[0], args[1]);
              path.circles.push([cx, cy, round(args[2] * uniformScale())]);
            }
            break;
          case "fill":
            rec.ops.push({
              op: "fill",
              pathId: path?.id ?? 0,
              verts: path ? path.verts.slice() : [],
              circles: path ? path.circles.map((c) => c.slice()) : [],
              alpha: round4(parseAlpha(t.fillStyle)),
              gco: t.globalCompositeOperation,
            });
            break;
          case "stroke":
            rec.ops.push({
              op: "stroke",
              pathId: path?.id ?? 0,
              verts: path ? path.verts.slice() : [],
              lineWidth: round4(t.lineWidth * uniformScale()),
              alpha: round4(parseAlpha(t.strokeStyle)),
            });
            break;
        }
        return v.apply(t, args);
      };
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  };
  return new Proxy(ctx, handler);
}

const round4 = (v) => Math.round(v * 10000) / 10000;

for (const C of [
  typeof OffscreenCanvas !== "undefined" ? OffscreenCanvas : null,
  typeof HTMLCanvasElement !== "undefined" ? HTMLCanvasElement : null,
].filter(Boolean)) {
  const orig = C.prototype.getContext;
  C.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest);
    if (type === "2d" && ctx) {
      if (!ctx.__stencilCaptureProxy) ctx.__stencilCaptureProxy = wrapContext(ctx);
      return ctx.__stencilCaptureProxy;
    }
    return ctx;
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers (self-intersection + winding probes)
// ---------------------------------------------------------------------------

function segsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1x = bx - ax, d1y = by - ay;
  const d2x = dx - cx, d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return false;
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
  const s = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
  return t > 1e-9 && t < 1 - 1e-9 && s > 1e-9 && s < 1 - 1e-9;
}

function isSelfIntersecting(verts) {
  const n = verts.length / 2;
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const j2 = (j + 1) % n;
      if (j2 === i) continue; // adjacent (wraps)
      if (
        segsIntersect(
          verts[i * 2], verts[i * 2 + 1], verts[i2 * 2], verts[i2 * 2 + 1],
          verts[j * 2], verts[j * 2 + 1], verts[j2 * 2], verts[j2 * 2 + 1],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function windingAt(verts, px, py) {
  const n = verts.length / 2;
  let w = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const y0 = verts[i * 2 + 1], y1 = verts[j * 2 + 1];
    const x0 = verts[i * 2], x1 = verts[j * 2];
    if (y0 <= py) {
      if (y1 > py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0) w++;
    } else if (y1 <= py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0) {
      w--;
    }
  }
  return w;
}

function distToEdges(verts, px, py) {
  const n = verts.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = verts[i * 2], y0 = verts[i * 2 + 1];
    const x1 = verts[j * 2], y1 = verts[j * 2 + 1];
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = x0 + t * dx - px, ey = y0 + t * dy - py;
    const d = Math.hypot(ex, ey);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Grid-scans for one interior point with |winding| == 1 and one with
 * |winding| >= 2, both at least minDist px from every edge.
 */
export function findWindingProbes(verts, minDist = 3) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < verts.length; i += 2) {
    minX = Math.min(minX, verts[i]);
    maxX = Math.max(maxX, verts[i]);
    minY = Math.min(minY, verts[i + 1]);
    maxY = Math.max(maxY, verts[i + 1]);
  }
  let single = null;
  let overlap = null;
  let singleBest = 0, overlapBest = 0;
  for (let y = Math.ceil(minY); y < maxY; y += 1) {
    for (let x = Math.ceil(minX); x < maxX; x += 1) {
      const w = Math.abs(windingAt(verts, x + 0.5, y + 0.5));
      if (w === 0) continue;
      const d = distToEdges(verts, x + 0.5, y + 0.5);
      if (d < minDist) continue;
      if (w === 1 && d > singleBest) {
        singleBest = d;
        single = { x: x + 0.5, y: y + 0.5, winding: 1, edgeDist: round4(d) };
      } else if (w >= 2 && d > overlapBest) {
        overlapBest = d;
        overlap = { x: x + 0.5, y: y + 0.5, winding: w, edgeDist: round4(d) };
      }
    }
  }
  return { single, overlap };
}

// ---------------------------------------------------------------------------
// Run one seeded fill and build the fixture
// ---------------------------------------------------------------------------

try {
  const brushUrl =
    new URLSearchParams(location.search).get("module") ?? "/dist/brush.esm.js";
  const brush = await import(brushUrl);

  brush.createCanvas(CANVAS, CANVAS, {
    parent: document.getElementById("host"),
    pixelDensity: 1,
    id: "stencil-capture",
  });
  brush.angleMode("degrees");
  brush.seed(SEED);
  brush.noiseSeed(SEED);
  brush.noStroke();
  brush.noHatch?.();

  // Several fills at increasing bleed: bigger wobble -> deeper
  // self-intersection slivers. Segment boundaries are recorded so the
  // full-replay stream stays a SINGLE createFill(). All center-origin coords.
  const segments = [];
  const draws = [
    { bleed: 0.12, rect: [-62, -58, 130, 120] },
    { bleed: 0.3, rect: [-60, -60, 125, 125] },
    { bleed: 0.45, rect: [-55, -55, 115, 115] },
  ];
  const allRecs = recorders;
  const opCount = () =>
    allRecs.reduce((n, r) => Math.max(n, r.ops.length), 0);
  for (const d of draws) {
    const start = opCount();
    brush.seed(SEED);
    brush.noiseSeed(SEED);
    brush.fill("#4a7cb8", 150);
    brush.fillBleed(d.bleed, "out");
    brush.fillTexture(0.8, 0.6);
    brush.rect(...d.rect);
    segments.push({ bleed: d.bleed, start, end: opCount() });
  }
  brush.render?.();

  // The mask recorder is the one that saw polygon fills.
  const rec = recorders
    .slice()
    .sort(
      (a, b) =>
        b.ops.filter((o) => o.op === "fill" && o.verts.length >= 6).length -
        a.ops.filter((o) => o.op === "fill" && o.verts.length >= 6).length,
    )[0];
  if (!rec) throw new Error("no 2d context recorded any fill ops");

  // Normalize a raw op slice: polygon fill + following stroke on the same
  // path become one layer op; consecutive destination-out circle fills
  // become one erase op.
  function normalize(rawOps) {
    const out = [];
    let eraseGroup = null;
    for (let i = 0; i < rawOps.length; i++) {
      const o = rawOps[i];
      if (o.op === "fill" && o.gco === "destination-out" && o.circles.length > 0) {
        if (!eraseGroup || eraseGroup.alpha !== o.alpha) {
          eraseGroup = { kind: "erase", circles: [], alpha: o.alpha };
          out.push(eraseGroup);
        }
        for (const c of o.circles) eraseGroup.circles.push(...c);
        continue;
      }
      eraseGroup = null;
      if (o.op === "fill" && o.verts.length >= 6) {
        const layerOp = {
          kind: "layer",
          verts: o.verts,
          fillAlpha: o.alpha,
          lineWidth: 0,
          strokeAlpha: 0,
        };
        const next = rawOps[i + 1];
        if (next && next.op === "stroke" && next.pathId === o.pathId) {
          layerOp.lineWidth = next.lineWidth;
          layerOp.strokeAlpha = next.alpha;
          i++;
        }
        out.push(layerOp);
      }
    }
    return out;
  }

  // Replay stream: the FIRST segment only (one createFill at realistic bleed).
  const ops = normalize(rec.ops.slice(segments[0].start, segments[0].end));
  const layerOps = ops.filter((o) => o.kind === "layer");
  const eraseOps = ops.filter((o) => o.kind === "erase");
  if (layerOps.length === 0) throw new Error("no polygon layers captured");

  // Self-intersecting polygon search across ALL segments; prefer the
  // deepest probe-able overlap region.
  const allLayerOps = [];
  for (const seg of segments) {
    for (const op of normalize(rec.ops.slice(seg.start, seg.end))) {
      if (op.kind === "layer") allLayerOps.push({ ...op, bleed: seg.bleed });
    }
  }
  let selfx = null;
  const selfxCandidates = allLayerOps.filter((o) => isSelfIntersecting(o.verts));
  for (const minDist of [3, 1.5]) {
    for (const op of selfxCandidates) {
      const probes = findWindingProbes(op.verts, minDist);
      if (!probes.single || !probes.overlap) continue;
      if (!selfx || probes.overlap.edgeDist > selfx.probes.overlap.edgeDist) {
        selfx = { verts: op.verts, alpha: op.fillAlpha, probes, scaled: 1, bleed: op.bleed };
      }
    }
    if (selfx) break;
  }
  if (!selfx) {
    // Fallback: scale a REAL self-intersecting grow() polygon about its
    // centroid until the overlap sliver is deep enough to probe. The shape
    // (and its winding structure) is unchanged — only the fixture's scale.
    outer: for (const scale of [2, 3, 4, 6]) {
      for (const op of selfxCandidates) {
        let cx = 0, cy = 0;
        const n = op.verts.length / 2;
        for (let i = 0; i < n; i++) {
          cx += op.verts[i * 2] / n;
          cy += op.verts[i * 2 + 1] / n;
        }
        const scaled = op.verts.map((v, i) =>
          Math.round(((i % 2 === 0 ? cx + (v - cx) * scale : cy + (v - cy) * scale)) * 100) / 100,
        );
        // keep it inside the canvas
        if (scaled.some((v, i) => v < 2 || v > (i % 2 === 0 ? CANVAS : CANVAS) - 2)) continue;
        const probes = findWindingProbes(scaled, 3);
        if (probes.single && probes.overlap) {
          selfx = { verts: scaled, alpha: op.fillAlpha, probes, scaled: scale, bleed: op.bleed };
          break outer;
        }
      }
    }
  }
  if (!selfx) {
    throw new Error(
      `no probe-able self-intersecting grow() polygon found ` +
        `(${selfxCandidates.length} self-intersecting candidates)`,
    );
  }

  // Border fixture: the stroked polygon with the largest real lineWidth.
  const border = layerOps
    .filter((o) => o.lineWidth > 0 && o.strokeAlpha > 0)
    .sort((a, b) => b.lineWidth - a.lineWidth)[0];
  if (!border) throw new Error("no stroked layer captured");

  // Convex polygon: synthesized octagon (grow() output is never convex;
  // the convex case tests baseline stencil correctness, not grow realism).
  const convex = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    convex.push(
      round4(150 + Math.cos(a) * 92),
      round4(150 + Math.sin(a) * 88),
    );
  }

  const selfIntersectingCount = selfxCandidates.length;

  window.__fixture = {
    seed: SEED,
    module: brushUrl,
    canvas: { width: CANVAS, height: CANVAS, density: 1 },
    stats: {
      layerOps: layerOps.length,
      eraseOps: eraseOps.length,
      eraseCircles: eraseOps.reduce((n, o) => n + o.circles.length / 3, 0),
      selfIntersectingPolys: selfIntersectingCount,
      totalVerts: layerOps.reduce((n, o) => n + o.verts.length / 2, 0),
    },
    selfx: {
      verts: selfx.verts,
      layerAlpha: selfx.alpha,
      probes: selfx.probes,
      source:
        `FillPoly.grow() layer, seed ${SEED}, bleed ${selfx.bleed}` +
        (selfx.scaled !== 1 ? `, scaled x${selfx.scaled} about centroid` : ""),
    },
    convex: { verts: convex, source: "synthesized octagon" },
    border: {
      verts: border.verts,
      lineWidth: border.lineWidth,
      strokeAlpha: border.strokeAlpha,
      fillAlpha: border.fillAlpha,
    },
    ops,
  };
  statusEl.textContent =
    `ok — ${layerOps.length} layers, ${selfIntersectingCount} self-intersecting, ` +
    `${eraseOps.length} erase groups, overlap probe |w|=${selfx.probes.overlap.winding} ` +
    `at (${selfx.probes.overlap.x}, ${selfx.probes.overlap.y}) d=${selfx.probes.overlap.edgeDist}`;
} catch (err) {
  window.__fixtureError = String(err?.stack ?? err);
  statusEl.textContent = `ERROR: ${window.__fixtureError}`;
}
