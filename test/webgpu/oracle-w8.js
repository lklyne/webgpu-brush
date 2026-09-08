// ============================================================
// W8 deferred-call oracle — browser half.
//
// The standalone build records stateful calls made between createCanvas()
// and the device resolving, then replays them in order (adapters/standalone/
// deferred.js). This page runs ONE program in one of two modes, selected by
// ?mode=deferred|sync, and reports a pixel hash plus the user random()
// values it read. The driver (scripts/oracle-w8.mjs) opens a FRESH page per
// mode — a fresh module instance, device, and field cache — and compares:
//
//   deferred: createCanvas() then the program immediately, no await before
//             readPixels(). Also asserts nothing threw (no-await) and that a
//             stroke after the flush lands in the next read (post-flush).
//   sync:     createCanvas(), await ready(), then the identical program.
//
// Cross-page gates (driver): pixel hash identical; the user random() values
// read before any seed and the first value read after the flush equal the
// synchronous run's. The one value read pre-ready AFTER the program's seeds
// is the documented exception (the stream's first draw, where the sync run
// consumed the intervening drawing first) and is reported but not gated.
//
// Two pages rather than two passes on one page: field generation is lazy
// and cached per module, so the first pass on a page consumes stream draws
// the second never does — a run-order effect upstream has too, and not
// what this oracle measures.
// ============================================================

const status = document.getElementById("status");
const tests = [];
const SEED = "w8-0";
const W = 320;
const H = 320;
const BG = "#ffffff";
const mode = new URLSearchParams(location.search).get("mode") ?? "deferred";

function log(line) {
  status.textContent += `\n${line}`;
}

function record(name, pass, detail) {
  tests.push({ name, pass, detail });
  log(`${pass ? "PASS" : "FAIL"} ${name} — ${detail}`);
}

// The program: strokes on both producers (GPU walk + CPU plot), a field-bent
// line, a watercolor fill, hatching, transforms, and a Polygon#show — every
// export group the recorder wraps. Center-origin coordinates.
function program(b, out) {
  b.angleMode("degrees");
  b.clear(BG);
  b.seed("user-stream");
  out.push(b.random(), b.random()); // before any drawing: must match sync
  b.set("HB", "#000000", 1);
  b.line(-150, -150, -140, -140);
  b.seed(SEED);
  b.noiseSeed(SEED);
  b.noField();
  b.noFill();
  b.noHatch();
  b.set("2B", "#1c1a17", 1.5);
  b.line(-120, -100, 120, -60);
  b.seed(`${SEED}:b`); // a mid-program reseed must replay in place
  b.field("seabed");
  b.set("marker", "#c0392b", 2);
  b.flowLine(-120, 0, 240, 0);
  b.noField();
  b.noStroke();
  b.fill("#2c6fbb", 90);
  b.fillBleed(0.3, "out");
  b.fillTexture(0.6, 0.4);
  b.polygon([
    [-80, 40],
    [80, 30],
    [60, 120],
    [-60, 110],
  ]);
  b.noFill();
  b.hatchStyle("rotring", "#1c1a17", 0.6);
  b.hatch(6, 45, { rand: 0.2 });
  b.rect(-140, -140, 60, 40);
  b.noHatch();
  b.push();
  b.translate(100, -120);
  b.rotate(20);
  b.set("pen", "#000000", 1);
  b.circle(0, 0, 18);
  b.pop();
  b.set("cpencil", "#1c1a17", 1);
  new b.Polygon([
    [90, 90],
    [130, 80],
    [120, 130],
  ]).show();
  b.noStroke();
  b.render();
  out.push(b.random()); // after the program: exempt in deferred mode
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

try {
  const brush = await import("/dist/brush.esm.js");
  const host = document.getElementById("host");
  brush.createCanvas(W, H, { parent: host, pixelDensity: 1 });

  const userDraws = [];
  if (mode === "sync") {
    await brush.ready();
    program(brush, userDraws);
  } else {
    let err = null;
    try {
      program(brush, userDraws); // no await anywhere before readPixels
    } catch (e) {
      err = e;
    }
    record("no-await", err === null, err === null ? "full program before ready(), no throw" : String(err));
  }

  const main = await brush.readPixels(); // deferred mode: resolves after replay
  userDraws.push(brush.random()); // post-flush continuation
  const hash = fnv1a(main.pixels);
  const ink = countInk(main.pixels);
  record("inked", ink > 500, `${ink} non-background pixels, hash ${hash}`);

  // A single stroke after ready lands in the very next read.
  brush.clear(BG);
  brush.set("HB", "#000000", 2);
  brush.line(-100, 0, 100, 0);
  brush.render();
  const after = await brush.readPixels();
  const inkAfter = countInk(after.pixels, 128);
  record("post-flush", inkAfter > 50 && inkAfter < ink, `${inkAfter} ink pixels from one post-ready line`);

  window.__oracleResults = { mode, tests, hash, ink, userDraws };
} catch (err) {
  log(`ERROR ${err?.stack ?? err}`);
  window.__oracleResults = { mode, tests, error: String(err?.stack ?? err) };
}
