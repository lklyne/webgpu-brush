// ============================================================
// Parity tile definitions — brush-gpu vs upstream p5.brush
//
// JS port of the site harness tile list
// (src/content/experiments/2026-08-30-brush-parity/tiles.ts).
// Keep the two in sync: same ids, same coords, same seed scheme,
// or per-tile RMSE stops being comparable across the two harnesses.
//
// Each tile draws one feature into a TILE×TILE box in local coords
// (0..s). The renderer translates into place; tiles never position
// themselves. `draw` receives the brush module, so the same list runs
// against upstream and the fork with no changes.
// ============================================================

const INK = "#1c1a17";
const RED = "#b23a2e";
const BLUE = "#2c4d8e";
const OCHRE = "#c8a24a";

// Reset all optional state so a tile can never inherit from its neighbour.
export function resetState(b) {
  b.noField();
  b.noFill();
  b.noHatch();
  b.noMass();
  b.noWash();
  b.noStroke();
}

// --- brushes: one tile per built-in, enumerated at runtime -------------------
// Never hand-list. A brush added upstream must show up here automatically.
function brushTiles(names) {
  return names.map((name) => ({
    id: `brush-${name}`,
    section: "brushes",
    label: name,
    draw: (b, s) => {
      b.set(name, INK, 1);
      b.line(s * 0.15, s * 0.8, s * 0.85, s * 0.2);
      b.line(s * 0.15, s * 0.55, s * 0.85, s * 0.55);
      b.circle(s * 0.5, s * 0.3, s * 0.13);
    },
  }));
}

// --- fields: one tile per built-in, enumerated at runtime --------------------
function fieldTiles(names) {
  return names.map((name) => ({
    id: `field-${name}`,
    section: "fields",
    label: name,
    draw: (b, s) => {
      b.set("HB", INK, 1);
      b.field(name);
      for (let i = 0; i < 5; i++) {
        b.line(s * 0.12, s * (0.2 + i * 0.15), s * 0.88, s * (0.2 + i * 0.15));
      }
    },
  }));
}

const staticTiles = [
  // --- fill ---------------------------------------------------------------
  {
    id: "fill-basic",
    section: "fill",
    label: "fill",
    draw: (b, s) => {
      b.noStroke();
      b.fill(RED, 80);
      b.rect(s * 0.2, s * 0.2, s * 0.6, s * 0.6);
    },
  },
  {
    id: "fill-bleed-out",
    section: "fill",
    label: "fillBleed out",
    draw: (b, s) => {
      b.noStroke();
      b.fill(BLUE, 90);
      b.fillBleed(0.5, "out");
      b.rect(s * 0.2, s * 0.2, s * 0.6, s * 0.6);
    },
  },
  {
    id: "fill-bleed-in",
    section: "fill",
    label: "fillBleed in",
    draw: (b, s) => {
      b.noStroke();
      b.fill(BLUE, 90);
      b.fillBleed(0.5, "in");
      b.rect(s * 0.2, s * 0.2, s * 0.6, s * 0.6);
    },
  },
  {
    id: "fill-texture",
    section: "fill",
    label: "fillTexture",
    draw: (b, s) => {
      b.noStroke();
      b.fill(OCHRE, 100);
      b.fillTexture(0.8, 0.6, true);
      b.circle(s * 0.5, s * 0.5, s * 0.32);
    },
  },
  {
    id: "fill-stroke-border",
    section: "fill",
    label: "fill + stroke border",
    draw: (b, s) => {
      // gotcha #6 — layer() draws fill AND a per-layer stroke border
      b.set("2B", INK, 0.8);
      b.fill(RED, 70);
      b.rect(s * 0.2, s * 0.2, s * 0.6, s * 0.6);
    },
  },
  {
    id: "wash",
    section: "fill",
    label: "wash",
    draw: (b, s) => {
      b.noStroke();
      b.noFill();
      b.wash(BLUE, 60);
      b.circle(s * 0.5, s * 0.5, s * 0.34);
    },
  },

  // --- hatch --------------------------------------------------------------
  {
    id: "hatch-basic",
    section: "hatch",
    label: "hatch 5/45",
    draw: (b, s) => {
      b.noStroke();
      b.hatchStyle("rotring", INK, 1);
      b.hatch(5, 45);
      b.rect(s * 0.15, s * 0.15, s * 0.7, s * 0.7);
    },
  },
  {
    id: "hatch-dense",
    section: "hatch",
    label: "hatch 2/0",
    draw: (b, s) => {
      b.noStroke();
      b.hatchStyle("rotring", INK, 1);
      b.hatch(2, 0);
      b.rect(s * 0.15, s * 0.15, s * 0.7, s * 0.7);
    },
  },
  {
    id: "hatch-rand",
    section: "hatch",
    label: "hatch rand",
    draw: (b, s) => {
      b.noStroke();
      b.hatchStyle("rotring", INK, 1);
      b.hatch(6, 30, { rand: 0.6 });
      b.rect(s * 0.15, s * 0.15, s * 0.7, s * 0.7);
    },
  },
  {
    id: "hatch-continuous",
    section: "hatch",
    label: "hatch continuous",
    draw: (b, s) => {
      b.noStroke();
      b.hatchStyle("rotring", INK, 1);
      b.hatch(6, 60, { continuous: true });
      b.circle(s * 0.5, s * 0.5, s * 0.34);
    },
  },
  {
    id: "hatch-gradient",
    section: "hatch",
    label: "hatch gradient",
    draw: (b, s) => {
      b.noStroke();
      b.hatchStyle("rotring", INK, 1);
      b.hatch(5, 45, { gradient: 0.6 });
      b.rect(s * 0.15, s * 0.15, s * 0.7, s * 0.7);
    },
  },
  {
    id: "hatch-style",
    section: "hatch",
    label: "hatchStyle marker",
    draw: (b, s) => {
      b.noStroke();
      b.hatchStyle("marker", RED, 1);
      b.hatch(7, 20);
      b.rect(s * 0.15, s * 0.15, s * 0.7, s * 0.7);
    },
  },
  {
    id: "hatch-with-fill",
    section: "hatch",
    label: "hatch + fill",
    draw: (b, s) => {
      b.noStroke();
      b.fill(OCHRE, 70);
      b.hatchStyle("rotring", INK, 1);
      b.hatch(6, 45);
      b.rect(s * 0.15, s * 0.15, s * 0.7, s * 0.7);
    },
  },
  {
    id: "mass",
    section: "hatch",
    label: "mass",
    draw: (b, s) => {
      b.noStroke();
      b.mass("charcoal", INK, {});
      b.rect(s * 0.15, s * 0.15, s * 0.7, s * 0.7);
    },
  },

  // --- geometry -----------------------------------------------------------
  {
    id: "geo-line",
    section: "geometry",
    label: "line",
    draw: (b, s) => {
      b.set("HB", INK, 1);
      b.line(s * 0.15, s * 0.85, s * 0.85, s * 0.15);
    },
  },
  {
    id: "geo-flowline",
    section: "geometry",
    label: "flowLine",
    draw: (b, s) => {
      b.set("HB", INK, 1);
      b.field("seabed");
      b.flowLine(s * 0.2, s * 0.5, s * 0.7, 0);
      b.flowLine(s * 0.2, s * 0.7, s * 0.7, 0);
    },
  },
  {
    id: "geo-spline",
    section: "geometry",
    label: "spline",
    draw: (b, s) => {
      b.set("2B", INK, 1);
      b.spline(
        [
          [s * 0.15, s * 0.7],
          [s * 0.4, s * 0.2],
          [s * 0.6, s * 0.8],
          [s * 0.85, s * 0.3],
        ],
        0.5,
      );
    },
  },
  {
    id: "geo-polygon",
    section: "geometry",
    label: "polygon",
    draw: (b, s) => {
      b.set("pen", INK, 1);
      b.polygon([
        [s * 0.2, s * 0.25],
        [s * 0.8, s * 0.2],
        [s * 0.7, s * 0.8],
        [s * 0.3, s * 0.75],
      ]);
    },
  },
  {
    id: "geo-beginshape",
    section: "geometry",
    label: "beginShape curved",
    draw: (b, s) => {
      b.set("pen", INK, 1);
      b.noFill();
      b.beginShape(0.6);
      b.vertex(s * 0.2, s * 0.3);
      b.vertex(s * 0.8, s * 0.25);
      b.vertex(s * 0.75, s * 0.8);
      b.vertex(s * 0.25, s * 0.7);
      b.endShape(true);
    },
  },
  {
    id: "geo-beginstroke",
    section: "geometry",
    label: "beginStroke/move",
    draw: (b, s) => {
      b.set("2B", INK, 1);
      b.beginStroke("curve", s * 0.2, s * 0.8);
      b.move(45, s * 0.35, 1);
      b.move(-30, s * 0.3, 0.6);
      b.endStroke(20, 0.4);
    },
  },
  {
    id: "geo-rect-circle-arc",
    section: "geometry",
    label: "rect/circle/arc",
    draw: (b, s) => {
      b.set("rotring", INK, 1);
      b.rect(s * 0.1, s * 0.1, s * 0.35, s * 0.3);
      b.circle(s * 0.72, s * 0.28, s * 0.16);
      b.arc(s * 0.5, s * 0.72, s * 0.22, 0, 220);
    },
  },
  {
    id: "geo-transform",
    section: "geometry",
    label: "push/rotate/scale",
    draw: (b, s) => {
      b.set("HB", INK, 1);
      b.push();
      b.translate(s * 0.5, s * 0.5);
      b.rotate(25);
      b.scale(0.8);
      b.rect(-s * 0.3, -s * 0.25, s * 0.6, s * 0.5);
      b.pop();
    },
  },

  // --- color / compositing ------------------------------------------------
  {
    id: "color-multi",
    section: "color",
    label: "multi-color",
    draw: (b, s) => {
      // exercises composite-per-color-change
      b.noStroke();
      b.fill(RED, 90);
      b.circle(s * 0.38, s * 0.4, s * 0.2);
      b.fill(BLUE, 90);
      b.circle(s * 0.62, s * 0.4, s * 0.2);
      b.fill(OCHRE, 90);
      b.circle(s * 0.5, s * 0.65, s * 0.2);
    },
  },
  {
    id: "color-overdraw",
    section: "color",
    label: "heavy overdraw",
    draw: (b, s) => {
      b.set("marker", RED, 2);
      for (let i = 0; i < 12; i++) {
        b.line(s * 0.15, s * (0.2 + i * 0.05), s * 0.85, s * (0.25 + i * 0.05));
      }
    },
  },
  {
    id: "color-darken",
    section: "color",
    label: "darken branch",
    draw: (b, s) => {
      // drives maskColor.a past DARKEN_THRESHOLD in the composite shader
      b.set("charcoal", INK, 3);
      for (let i = 0; i < 8; i++) {
        b.line(s * 0.2, s * 0.25 + i * 4, s * 0.8, s * 0.25 + i * 4);
      }
    },
  },
  {
    id: "color-alpha-low",
    section: "color",
    label: "alpha 5",
    draw: (b, s) => {
      b.noStroke();
      b.fill(BLUE, 5);
      b.rect(s * 0.2, s * 0.2, s * 0.6, s * 0.6);
    },
  },
  {
    id: "color-alpha-full",
    section: "color",
    label: "alpha 255",
    draw: (b, s) => {
      b.noStroke();
      b.fill(BLUE, 255);
      b.rect(s * 0.2, s * 0.2, s * 0.6, s * 0.6);
    },
  },

  // --- edge cases ---------------------------------------------------------
  {
    id: "edge-subpixel",
    section: "edge",
    label: "sub-pixel weight",
    draw: (b, s) => {
      b.set("rotring", INK, 0.05);
      for (let i = 0; i < 6; i++) {
        b.line(s * 0.15, s * (0.2 + i * 0.12), s * 0.85, s * (0.2 + i * 0.12));
      }
    },
  },
  {
    id: "edge-oversize",
    section: "edge",
    label: "exits canvas",
    draw: (b, s) => {
      b.set("2B", INK, 2);
      b.line(-s * 0.5, -s * 0.3, s * 1.5, s * 1.3);
      b.line(s * 1.4, -s * 0.2, -s * 0.4, s * 1.1);
    },
  },
  {
    id: "edge-self-intersect",
    section: "edge",
    label: "self-intersecting fill",
    draw: (b, s) => {
      // gotcha #5 — nonzero winding, overlap must count ONCE
      b.noStroke();
      b.fill(RED, 120);
      b.polygon([
        [s * 0.2, s * 0.2],
        [s * 0.8, s * 0.8],
        [s * 0.8, s * 0.2],
        [s * 0.2, s * 0.8],
      ]);
    },
  },
  {
    id: "edge-zero-length",
    section: "edge",
    label: "zero-length + dot",
    draw: (b, s) => {
      b.set("HB", INK, 1);
      b.line(s * 0.5, s * 0.5, s * 0.5, s * 0.5);
      b.circle(s * 0.3, s * 0.3, 0.5);
    },
  },
  {
    id: "edge-tiny-shape",
    section: "edge",
    label: "tiny fill",
    draw: (b, s) => {
      b.noStroke();
      b.fill(BLUE, 100);
      b.rect(s * 0.48, s * 0.48, s * 0.04, s * 0.04);
    },
  },
  {
    id: "edge-custom-brush",
    section: "edge",
    label: "custom add()",
    draw: (b, s) => {
      b.set("parity-custom", INK, 1);
      b.line(s * 0.15, s * 0.75, s * 0.85, s * 0.3);
      b.circle(s * 0.5, s * 0.4, s * 0.12);
    },
  },
  {
    id: "edge-wiggle",
    section: "edge",
    label: "wiggle field",
    draw: (b, s) => {
      b.set("pen", INK, 1);
      b.wiggle(1.5);
      for (let i = 0; i < 4; i++) {
        b.line(s * 0.15, s * (0.25 + i * 0.17), s * 0.85, s * (0.25 + i * 0.17));
      }
    },
  },
];

// A custom brush so the add() registration path is covered.
// Registered once per module instance, before tiles draw.
export function registerCustomBrush(b) {
  b.add("parity-custom", {
    type: "standard",
    weight: 0.4,
    vibration: 0.3,
    definition: 0.7,
    quality: 8,
    opacity: 180,
    spacing: 0.15,
    blend: true,
    pressure: { curve: [0.2, 0.3], min_max: [1.2, 0.9] },
  });
}

export function buildTiles(b) {
  return [...brushTiles(b.box()), ...fieldTiles(b.listFields()), ...staticTiles];
}
