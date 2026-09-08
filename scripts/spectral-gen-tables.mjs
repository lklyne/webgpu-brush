// =============================================================================
// Transcribes the spectral constant tables from test/reference/glsl/spectral.frag
// (upstream's GLSL blend shader, kept only as the source of truth for these
// tables) into src/webgpu/wgsl/spectral.wgsl.js and src/webgpu/spectral.js, between
// their "BEGIN/END GENERATED TABLES" markers. The plan mandates
// programmatic transcription — the literal digit strings are copied
// verbatim from the .frag, never reparsed through a float.
//
//   node scripts/spectral-gen-tables.mjs          # rewrite both files
//   node scripts/spectral-gen-tables.mjs --check  # exit 1 if out of date
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const FRAG = resolve(ROOT, "test/reference/glsl/spectral.frag");
const TARGETS = [
  { path: resolve(ROOT, "src/webgpu/wgsl/spectral.wgsl.js"), lang: "wgsl" },
  { path: resolve(ROOT, "src/webgpu/spectral.js"), lang: "js" },
];

const frag = readFileSync(FRAG, "utf8");
const NUM = String.raw`(-?[0-9]+\.[0-9]+)`;

function matchAll(re, expected, label) {
  const rows = [...frag.matchAll(re)].map((m) => m.slice(1));
  if (rows.length !== expected) {
    throw new Error(`${label}: expected ${expected} rows, matched ${rows.length}`);
  }
  return rows;
}

// R[ i] = max(SPECTRAL_EPSILON, w * … + c * … + m * … + y * … + r * … + g * … + b * …);
const l2r = matchAll(
  new RegExp(
    String.raw`R\[\s*\d+\] = max\(SPECTRAL_EPSILON, w \* ${NUM} \+ c \* ${NUM} \+ m \* ${NUM} \+ y \* ${NUM} \+ r \* ${NUM} \+ g \* ${NUM} \+ b \* ${NUM}\);`,
    "g",
  ),
  38,
  "spectral_linear_to_reflectance",
);

// xyz += R[ i] * vec3(…, …, …);
const r2xyz = matchAll(
  new RegExp(String.raw`xyz \+= R\[\s*\d+\] \* vec3\(${NUM}, ${NUM}, ${NUM}\);`, "g"),
  38,
  "spectral_reflectance_to_xyz",
);

// XYZ_RGB[i] = vec3( …, …, …);
const xyz2rgb = matchAll(
  new RegExp(String.raw`XYZ_RGB\[\d\] = vec3\(\s*${NUM},\s*${NUM},\s*${NUM}\);`, "g"),
  3,
  "XYZ_RGB",
);

function wgslBlock() {
  const lines = [];
  lines.push("// spectral_linear_to_reflectance coefficients, split (w,c,m,y) | (r,g,b).");
  lines.push("const SPECTRAL_L2R_WCMY = array<vec4f, 38>(");
  for (const row of l2r) lines.push(`  vec4f(${row.slice(0, 4).join(", ")}),`);
  lines.push(");");
  lines.push("");
  lines.push("const SPECTRAL_L2R_RGB = array<vec3f, 38>(");
  for (const row of l2r) lines.push(`  vec3f(${row.slice(4).join(", ")}),`);
  lines.push(");");
  lines.push("");
  lines.push("// spectral_reflectance_to_xyz CIE weights.");
  lines.push("const SPECTRAL_R_TO_XYZ = array<vec3f, 38>(");
  for (const row of r2xyz) lines.push(`  vec3f(${row.join(", ")}),`);
  lines.push(");");
  lines.push("");
  lines.push("// XYZ→linear-sRGB rows (GLSL XYZ_RGB, used row-wise with dot()).");
  lines.push("const SPECTRAL_XYZ_TO_RGB = array<vec3f, 3>(");
  for (const row of xyz2rgb) lines.push(`  vec3f(${row.join(", ")}),`);
  lines.push(");");
  return lines.join("\n");
}

function jsBlock() {
  const lines = [];
  lines.push("/** 38×7 (w,c,m,y,r,g,b) — spectral.frag spectral_linear_to_reflectance. */");
  lines.push("export const SPECTRAL_L2R = [");
  for (const row of l2r) lines.push(`  [${row.join(", ")}],`);
  lines.push("];");
  lines.push("");
  lines.push("/** 38×3 CIE weights — spectral.frag spectral_reflectance_to_xyz. */");
  lines.push("export const SPECTRAL_R_TO_XYZ = [");
  for (const row of r2xyz) lines.push(`  [${row.join(", ")}],`);
  lines.push("];");
  lines.push("");
  lines.push("/** 3×3 XYZ→linear-sRGB rows — spectral.frag XYZ_RGB. */");
  lines.push("export const SPECTRAL_XYZ_TO_RGB = [");
  for (const row of xyz2rgb) lines.push(`  [${row.join(", ")}],`);
  lines.push("];");
  return lines.join("\n");
}

const BEGIN = /^.*BEGIN GENERATED TABLES.*$/m;
const END = /^.*END GENERATED TABLES.*$/m;
const check = process.argv.includes("--check");
let stale = false;

for (const { path, lang } of TARGETS) {
  const src = readFileSync(path, "utf8");
  const begin = src.match(BEGIN);
  const end = src.match(END);
  if (!begin || !end) throw new Error(`${path}: GENERATED TABLES markers missing`);
  const head = src.slice(0, begin.index + begin[0].length);
  const tail = src.slice(end.index);
  const block = lang === "wgsl" ? wgslBlock() : jsBlock();
  const next = `${head}\n\n${block}\n\n${tail}`;
  if (next !== src) {
    if (check) {
      console.error(`STALE ${path}`);
      stale = true;
    } else {
      writeFileSync(path, next);
      console.log(`wrote ${path} (${l2r.length}+${r2xyz.length}+${xyz2rgb.length} rows)`);
    }
  } else {
    console.log(`up to date ${path}`);
  }
}

process.exit(stale ? 1 : 0);
