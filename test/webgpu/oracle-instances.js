// ============================================================
// Two-instance oracle — browser half.
//
// createBrush() gives each painting its own state, seed stream, flow-field
// grids, stroke batch and GPU host. The proof is that INTERLEAVING two
// paintings call by call produces exactly the images each program produces
// on a page of its own — no state leaking through a shared module.
//
// Modes, selected by ?mode= (the driver opens a FRESH page per mode, so
// nothing carries over):
//
//   interleaved  A (300x200, seed "a", flow field, no fill) and B
//                (200x300, seed "b", watercolor fill, no field) built
//                together and stepped alternately. Also checks that the
//                module-level default painting still works alongside them,
//                and that disposing A leaves B drawing while A's own
//                methods throw.
//   soloA/soloB  one painting, the identical step list, nothing else on the
//                page.
//   shared       A owns a device; B adopts it (`device: A.gpu().device`).
//                Interleaved again — two paintings, one device, one stroke
//                walker.
//
// The driver (scripts/oracle-instances.mjs) gates the pixel hashes pairwise
// against the solo runs and compares the post-seed random() sequences.
// ============================================================

const status = document.getElementById("status");
const host = document.getElementById("host");
const tests = [];
const mode = new URLSearchParams(location.search).get("mode") ?? "interleaved";

const A = { width: 300, height: 200, seed: "a" };
const B = { width: 200, height: 300, seed: "b" };

function log(line) {
  status.textContent += `\n${line}`;
}

function record(name, pass, detail) {
  tests.push({ name, pass, detail });
  log(`${pass ? "PASS" : "FAIL"} ${name} — ${detail}`);
}

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function countInk(pixels, threshold = 200) {
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] < threshold || pixels[i + 1] < threshold || pixels[i + 2] < threshold) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The two programs, as step lists so the interleaved and solo runs make the
// SAME calls on each painting in the SAME per-painting order — only the
// interleaving differs.
// ---------------------------------------------------------------------------

/** A: flow field, both stroke producers, hatch, a Plot, transforms. */
function stepsA(b) {
  return [
    () => b.angleMode("degrees"),
    () => b.clear("#ffffff"),
    () => b.seed(A.seed),
    // The noise fields are seeded separately from the sequential stream, and
    // the "hand" field wiggle() switches to reads noise2().
    () => b.noiseSeed(A.seed),
    () => b.noFill(),
    () => b.noHatch(),
    () => b.set("2B", "#1c1a17", 1.5),
    () => b.line(-130, -70, 130, -50),
    () => b.field("seabed"),
    () => b.set("marker", "#c0392b", 2),
    () => b.flowLine(-120, 0, 220, 0),
    () => b.wiggle(1.2),
    () => b.flowLine(-120, 30, 200, 10),
    () => b.noField(),
    () => b.hatchStyle("rotring", "#1c1a17", 0.6),
    () => b.hatch(7, 30, { rand: 0.2 }),
    () => b.rect(-130, 30, 90, 50),
    () => b.noHatch(),
    () => b.push(),
    () => b.translate(90, 55),
    () => b.rotate(25),
    () => b.set("pen", "#000000", 1),
    () => b.circle(0, 0, 20),
    () => b.pop(),
    () => b.set("cpencil", "#1c1a17", 1),
    () =>
      new b.Polygon([
        [40, -70],
        [110, -80],
        [100, -20],
      ]).show(),
    () => b.noStroke(),
    () => b.render(),
  ];
}

/** B: watercolor fill, a wash, a spline, a mass — no field at all. */
function stepsB(b) {
  return [
    () => b.angleMode("degrees"),
    () => b.clear("#ffffff"),
    () => b.seed(B.seed),
    () => b.noiseSeed(B.seed),
    () => b.noField(),
    () => b.noStroke(),
    () => b.fill("#2c6fbb", 90),
    () => b.fillBleed(0.35, "out"),
    () => b.fillTexture(0.6, 0.4),
    () =>
      b.polygon([
        [-70, -110],
        [70, -120],
        [55, -20],
        [-60, -30],
      ]),
    () => b.noFill(),
    () => b.set("HB", "#101020", 1),
    () => b.spline([
      [-70, 20, 1],
      [0, 60, 1],
      [70, 30, 1],
    ]),
    () => b.hatchStyle("2B", "#8e44ad", 0.8),
    () => b.hatch(5, 60, { rand: 0.3 }),
    () => b.circle(0, 95, 45),
    () => b.noHatch(),
    () => b.set("marker", "#1c1a17", 1.2),
    () => b.line(-80, 130, 80, 120),
    () => b.noStroke(),
    () => b.render(),
  ];
}

/** Runs two step lists alternately, one call each, to exhaustion. */
function interleave(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    a[i]?.();
    b[i]?.();
  }
}

/** The seeded stream after the program — must not depend on the other painting. */
function streamAfter(b, seed) {
  b.seed(seed);
  return [b.random(), b.random(), b.random()];
}

async function capture(instance, label) {
  const { pixels } = await instance.readPixels();
  const hash = fnv1a(pixels);
  const ink = countInk(pixels);
  record(`inked-${label}`, ink > 300, `${ink} non-background pixels, hash ${hash}`);
  return { hash, ink };
}

try {
  const brush = await import("/dist/brush.esm.js");
  const results = { mode, tests };

  const makeA = (options) =>
    brush.createBrush({ ...A, parent: host, pixelDensity: 1, id: "paint-a", ...options });
  const makeB = (options) =>
    brush.createBrush({ ...B, parent: host, pixelDensity: 1, id: "paint-b", ...options });

  if (mode === "soloA") {
    const a = makeA();
    for (const step of stepsA(a)) step();
    results.a = await capture(a, "a");
    results.streamA = streamAfter(a, A.seed);
  } else if (mode === "soloB") {
    const b = makeB();
    for (const step of stepsB(b)) step();
    results.b = await capture(b, "b");
    results.streamB = streamAfter(b, B.seed);
  } else if (mode === "shared") {
    // One device, two paintings. A owns it, so it has to be up before B can
    // adopt it — B is therefore built after A's device resolves, and A's own
    // program still runs interleaved with B's.
    const a = makeA();
    await a.ready();
    const gpu = a.gpu();
    const b = makeB({ device: gpu.device, adapter: gpu.adapter });
    interleave(stepsA(a), stepsB(b));
    results.a = await capture(a, "a");
    results.b = await capture(b, "b");
    results.streamA = streamAfter(a, A.seed);
    results.streamB = streamAfter(b, B.seed);
    const shared = b.gpu().device === gpu.device;
    record("one-device", shared, shared ? "both paintings report the same GPUDevice" : "devices differ");
  } else {
    // interleaved: two independent devices, no await before the drawing.
    let err = null;
    const a = makeA();
    const b = makeB();
    try {
      interleave(stepsA(a), stepsB(b));
    } catch (e) {
      err = e;
    }
    record(
      "no-throw",
      err === null,
      err === null ? "both programs ran interleaved before ready(), no throw" : String(err),
    );

    results.a = await capture(a, "a");
    results.b = await capture(b, "b");
    results.streamA = streamAfter(a, A.seed);
    results.streamB = streamAfter(b, B.seed);

    // Sizes stay per painting.
    const sizesOk =
      a.canvas.width === A.width &&
      a.canvas.height === A.height &&
      b.canvas.width === B.width &&
      b.canvas.height === B.height;
    record(
      "sizes",
      sizesOk,
      `A ${a.canvas.width}x${a.canvas.height}, B ${b.canvas.width}x${b.canvas.height}`,
    );

    // The module-level default painting is a third instance and still works.
    brush.createCanvas(160, 120, { parent: host, pixelDensity: 1 });
    brush.clear("#ffffff");
    brush.set("HB", "#000000", 2);
    brush.line(-60, -30, 60, 30);
    brush.render();
    const dflt = await brush.readPixels();
    const defaultInk = countInk(dflt.pixels, 128);
    record(
      "default-api",
      defaultInk > 30,
      `${defaultInk} ink pixels drawn through the module-level exports`,
    );

    // Disposing A must not touch B, and must make A inert.
    a.dispose();
    let disposedThrew = false;
    try {
      a.line(0, 0, 10, 10);
    } catch {
      disposedThrew = true;
    }
    record("dispose-throws", disposedThrew, "A.line() after A.dispose() throws");

    b.set("HB", "#000000", 3);
    b.line(-80, -140, 80, -140);
    b.render();
    const after = await b.readPixels();
    const inkAfter = countInk(after.pixels);
    record(
      "dispose-isolation",
      inkAfter > results.b.ink,
      `B ink ${results.b.ink} → ${inkAfter} after A was disposed`,
    );
  }

  window.__oracleResults = results;
} catch (err) {
  log(`ERROR ${err?.stack ?? err}`);
  window.__oracleResults = { mode, tests, error: String(err?.stack ?? err) };
}
