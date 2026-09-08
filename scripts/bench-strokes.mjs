// ============================================================
// Stroke A/B bench runner — drives test/standalone/stroke_ab.html headlessly
// (real GPU via Metal, same flags as profile-baseline.mjs) across variants
// and prints median to-completion / JS-return times.
//
//   node scripts/bench-strokes.mjs [--runs 3] [--n 320] [--only fork,cycle,gpu]
//
// Requires `npm run build` (dist/).
// ============================================================

import { startServer, launchBrowser } from "./lib/headless.mjs";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const RUNS = opt("runs", "3");
const N = opt("n", "320");
const ONLY = opt("only", null);

const VARIANTS = [
  { impl: "upstream", color: "cycle", walk: "-" },
  { impl: "fork", color: "cycle", walk: "gpu" },
  { impl: "fork", color: "cycle", walk: "cpu" },
  { impl: "upstream", color: "fixed", walk: "-" },
  { impl: "fork", color: "fixed", walk: "gpu" },
  { impl: "fork", color: "fixed", walk: "cpu" },
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const server = await startServer();
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();

console.log(`${"variant".padEnd(28)} ${"total ms".padStart(9)} ${"js ms".padStart(8)}   (median of ${RUNS}, n=${N})`);
try {
  for (const v of VARIANTS) {
    const label = `${v.impl} · ${v.color} · ${v.walk}`;
    if (ONLY && !ONLY.split(",").every((k) => label.includes(k))) continue;
    const page = await browser.newPage();
    let fail;
    const failed = new Promise((res) => (fail = res));
    page.on("pageerror", (err) => {
      console.error(`[${label}] pageerror:`, err.message);
      fail(null);
    });
    const done = new Promise((res) => {
      failed.then(res);
      page.on("console", (msg) => {
        const t = msg.text();
        if (t.startsWith("BENCH ")) res(JSON.parse(t.slice(6)));
        else if (msg.type() === "error") console.error(`[${label}]`, t);
      });
      setTimeout(() => res(null), 120_000);
    });
    const qs = `impl=${v.impl}&color=${v.color}&walk=${v.walk}&n=${N}&runs=${RUNS}`;
    await page.goto(`${baseUrl}/test/standalone/stroke_ab.html?${qs}`, { waitUntil: "load" });
    const r = await done;
    await page.close();
    if (!r) {
      console.log(`${label.padEnd(28)} FAILED`);
      continue;
    }
    const total = median(r.results.map((x) => x.totalMs));
    const js = median(r.results.map((x) => x.jsMs));
    console.log(`${label.padEnd(28)} ${total.toFixed(0).padStart(9)} ${js.toFixed(0).padStart(8)}`);
  }
} finally {
  await browser.close();
  server.close();
}
