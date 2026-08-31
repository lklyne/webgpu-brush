// =============================================================================
// CPU half of the W2 spectral component — the reflectance hoist.
//
// The GLSL composite (src/core/gl/shader.frag) recomputes a full 38-band
// linear→reflectance conversion + XYZ integration for BOTH colors, per
// pixel. The blend color derives from the u_color uniform and is constant
// across the pass (outside the darken branch), so its reflectance (R2)
// and luminance are computed here, once, when the color changes, and
// shipped to wgsl/spectral.wgsl in the BlendUniforms block.
//
// Math is a float64 port of shader.frag lines 21–147; the tables between
// the GENERATED markers are transcribed programmatically from the .frag by
// scripts/spectral-gen-tables.mjs — do not hand-edit, rerun the script.
//
// Primary API for W3:
//   packBlendUniforms({ color, isBrush, targetIsFramebuffer }) →
//     Float32Array(48) matching struct BlendUniforms (192 bytes), ready
//     for a uniform-ring write. R2/luminance are memoized on the color.
// =============================================================================

export const SPECTRAL_SIZE = 38;
const SPECTRAL_GAMMA = 2.4;
const SPECTRAL_EPSILON = 0.0001;

// BEGIN GENERATED TABLES (scripts/spectral-gen-tables.mjs — do not hand-edit)

/** 38×7 (w,c,m,y,r,g,b) — shader.frag spectral_linear_to_reflectance. */
export const SPECTRAL_L2R = [
  [1.0011607271876400, 0.9705850013229620, 0.9906735573199880, 0.0210523371789306, 0.0315605737777207, 0.0095560747554212, 0.9794047525020140],
  [1.0011606515972800, 0.9705924981434250, 0.9906715249619790, 0.0210564627517414, 0.0315520718330149, 0.0095581580120851, 0.9794007068431300],
  [1.0011603192274700, 0.9706253487298910, 0.9906625823534210, 0.0210746178695038, 0.0315148215513658, 0.0095673245444588, 0.9793829034702610],
  [1.0011586727078900, 0.9707868061190170, 0.9906181076447950, 0.0211649058448753, 0.0313318044982702, 0.0096129126297349, 0.9792943649455940],
  [1.0011525984455200, 0.9713686732282480, 0.9904514808787100, 0.0215027957272504, 0.0306729857725527, 0.0097837090401843, 0.9789630146085700],
  [1.0011325252899800, 0.9731632306212520, 0.9898710814002040, 0.0226738799041561, 0.0286480476989607, 0.0103786227058710, 0.9778144666940430],
  [1.0010850066332700, 0.9767402231587650, 0.9882866087596400, 0.0258235649693629, 0.0246450407045709, 0.0120026452378567, 0.9747243211338360],
  [1.0009968788945300, 0.9815876054913770, 0.9842906927975040, 0.0334879385639851, 0.0192960753663651, 0.0160977721473922, 0.9671984823439730],
  [1.0008652515227400, 0.9862802656529490, 0.9739349056253060, 0.0519069663740307, 0.0142066612220556, 0.0267061902231680, 0.9490796575305750],
  [1.0006962900094000, 0.9899491476891340, 0.9418178384601450, 0.1007490148334730, 0.0102942608878609, 0.0595555440185881, 0.9008501289409770],
  [1.0005049611488800, 0.9924927015384200, 0.8173903261951560, 0.2391298997068470, 0.0076191460521811, 0.1860398265328260, 0.7631504454622400],
  [1.0003080818799200, 0.9941456804052560, 0.4324728050657290, 0.5348043122727480, 0.0058980410835420, 0.5705798201161590, 0.4659221716493190],
  [1.0001196660201300, 0.9951839750332120, 0.1384539782588700, 0.7978075786430300, 0.0048233247781713, 0.8614677684002920, 0.2012632804510050],
  [0.9999527659684070, 0.9957567501108180, 0.0537347216940033, 0.9114498940673840, 0.0042298748350633, 0.9458790897676580, 0.0877524413419623],
  [0.9998218368992970, 0.9959128182867100, 0.0292174996673231, 0.9537979630045070, 0.0040599171299341, 0.9704654864743050, 0.0457176793291679],
  [0.9997386095575930, 0.9956061578345280, 0.0213136517508590, 0.9712416154654290, 0.0043533695594676, 0.9784136302844500, 0.0284706050521843],
  [0.9997095516396120, 0.9945976009618540, 0.0201349530181136, 0.9793031238075880, 0.0053434425970201, 0.9795890314112240, 0.0205271767569850],
  [0.9997319302106270, 0.9922157154923700, 0.0241323096280662, 0.9833801195075750, 0.0076917201010463, 0.9755335369086320, 0.0165302792310211],
  [0.9997994363461950, 0.9862364527832490, 0.0372236145223627, 0.9854612465677550, 0.0135969795736536, 0.9622887553978130, 0.0145135107212858],
  [0.9999003303166710, 0.9679433372645410, 0.0760506552706601, 0.9864350469766050, 0.0316975442661115, 0.9231215745131200, 0.0136003508637687],
  [1.0000204065261100, 0.8912850042449430, 0.2053754719423990, 0.9867382506701410, 0.1078611963552490, 0.7934340189431110, 0.0133604258769571],
  [1.0001447879365800, 0.5362024778620530, 0.5412689034604390, 0.9866178824450320, 0.4638126031687040, 0.4592701359024290, 0.0135488943145680],
  [1.0002599790341200, 0.1541081190018780, 0.8158416850864860, 0.9862777767586430, 0.8470554052720110, 0.1855741036663030, 0.0139594356366992],
  [1.0003557969708900, 0.0574575093228929, 0.9128177041239760, 0.9858605924440560, 0.9431854093939180, 0.0881774959955372, 0.0144434255753570],
  [1.0004275378026900, 0.0315349873107007, 0.9463398301669620, 0.9854749276762100, 0.9688621506965580, 0.0543630228766700, 0.0148854440621406],
  [1.0004762334488800, 0.0222633920086335, 0.9599276963319910, 0.9851769347655580, 0.9780306674736030, 0.0406288447060719, 0.0152254296999746],
  [1.0005072096750800, 0.0182022841492439, 0.9662605952303120, 0.9849715740141810, 0.9820436438543060, 0.0342215204316970, 0.0154592848180209],
  [1.0005251915637300, 0.0162990559732640, 0.9693259700584240, 0.9848463034157120, 0.9839236237187070, 0.0311185790956966, 0.0156018026485961],
  [1.0005350960689600, 0.0153656239334613, 0.9708545367213990, 0.9847753518111990, 0.9848454841543820, 0.0295708898336134, 0.0156824871281936],
  [1.0005402209748200, 0.0149111568733976, 0.9716050665281280, 0.9847380666252650, 0.9852942758145960, 0.0288108739348928, 0.0157248764360615],
  [1.0005427281678400, 0.0146954339898235, 0.9719627697573920, 0.9847196483117650, 0.9855072952198250, 0.0284486271324597, 0.0157458108784121],
  [1.0005438956908700, 0.0145964146717719, 0.9721272722745090, 0.9847110233919390, 0.9856050715398370, 0.0282820301724731, 0.0157556123350225],
  [1.0005444821215100, 0.0145470156699655, 0.9722094177458120, 0.9847066833006760, 0.9856538499335780, 0.0281988376490237, 0.0157605443964911],
  [1.0005447695999200, 0.0145228771899495, 0.9722495776784240, 0.9847045543930910, 0.9856776850338830, 0.0281581655342037, 0.0157629637515278],
  [1.0005448988776200, 0.0145120341118965, 0.9722676219987420, 0.9847035963093700, 0.9856883918061220, 0.0281398910216386, 0.0157640525629106],
  [1.0005449625468900, 0.0145066940939832, 0.9722765094621500, 0.9847031240775520, 0.9856936646900310, 0.0281308901665811, 0.0157645892329510],
  [1.0005449892705800, 0.0145044507314479, 0.9722802433068740, 0.9847029256150900, 0.9856958798482050, 0.0281271086805816, 0.0157648147772649],
  [1.0005449969930000, 0.0145038009464639, 0.9722813248265600, 0.9847028681227950, 0.9856965214637620, 0.0281260133612096, 0.0157648801149616],
];

/** 38×3 CIE weights — shader.frag spectral_reflectance_to_xyz. */
export const SPECTRAL_R_TO_XYZ = [
  [0.0000646919989576, 0.0000018442894440, 0.0003050171476380],
  [0.0002194098998132, 0.0000062053235865, 0.0010368066663574],
  [0.0011205743509343, 0.0000310096046799, 0.0053131363323992],
  [0.0037666134117111, 0.0001047483849269, 0.0179543925899536],
  [0.0118805536037990, 0.0003536405299538, 0.0570775815345485],
  [0.0232864424191771, 0.0009514714056444, 0.1136516189362870],
  [0.0345594181969747, 0.0022822631748318, 0.1733587261835500],
  [0.0372237901162006, 0.0042073290434730, 0.1962065755586570],
  [0.0324183761091486, 0.0066887983719014, 0.1860823707062960],
  [0.0212332056093810, 0.0098883960193565, 0.1399504753832070],
  [0.0104909907685421, 0.0152494514496311, 0.0891745294268649],
  [0.0032958375797931, 0.0214183109449723, 0.0478962113517075],
  [0.0005070351633801, 0.0334229301575068, 0.0281456253957952],
  [0.0009486742057141, 0.0513100134918512, 0.0161376622950514],
  [0.0062737180998318, 0.0704020839399490, 0.0077591019215214],
  [0.0168646241897775, 0.0878387072603517, 0.0042961483736618],
  [0.0286896490259810, 0.0942490536184085, 0.0020055092122156],
  [0.0426748124691731, 0.0979566702718931, 0.0008614711098802],
  [0.0562547481311377, 0.0941521856862608, 0.0003690387177652],
  [0.0694703972677158, 0.0867810237486753, 0.0001914287288574],
  [0.0830531516998291, 0.0788565338632013, 0.0001495555858975],
  [0.0861260963002257, 0.0635267026203555, 0.0000923109285104],
  [0.0904661376847769, 0.0537414167568200, 0.0000681349182337],
  [0.0850038650591277, 0.0426460643574120, 0.0000288263655696],
  [0.0709066691074488, 0.0316173492792708, 0.0000157671820553],
  [0.0506288916373645, 0.0208852059213910, 0.0000039406041027],
  [0.0354739618852640, 0.0138601101360152, 0.0000015840125870],
  [0.0214682102597065, 0.0081026402038399, 0.0000000000000000],
  [0.0125164567619117, 0.0046301022588030, 0.0000000000000000],
  [0.0068045816390165, 0.0024913800051319, 0.0000000000000000],
  [0.0034645657946526, 0.0012593033677378, 0.0000000000000000],
  [0.0014976097506959, 0.0005416465221680, 0.0000000000000000],
  [0.0007697004809280, 0.0002779528920067, 0.0000000000000000],
  [0.0004073680581315, 0.0001471080673854, 0.0000000000000000],
  [0.0001690104031614, 0.0000610327472927, 0.0000000000000000],
  [0.0000952245150365, 0.0000343873229523, 0.0000000000000000],
  [0.0000490309872958, 0.0000177059860053, 0.0000000000000000],
  [0.0000199961492222, 0.0000072209749130, 0.0000000000000000],
];

/** 3×3 XYZ→linear-sRGB rows — shader.frag XYZ_RGB. */
export const SPECTRAL_XYZ_TO_RGB = [
  [3.2409699419045200, -1.537383177570090, -0.4986107602930030],
  [-0.9692436362808790, 1.875967501507720, 0.0415550574071756],
  [0.0556300796969936, -0.203976958888976, 1.0569715142428700],
];

// END GENERATED TABLES

/** @param {number} x sRGB channel in [0,1] @returns {number} linear */
export function spectralUncompand(x) {
  return x < 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, SPECTRAL_GAMMA);
}

/** @param {number} x linear channel @returns {number} sRGB, clamped [0,1] */
export function spectralCompand(x) {
  const v = x < 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / SPECTRAL_GAMMA) - 0.055;
  return Math.min(1, Math.max(0, v));
}

/**
 * shader.frag spectral_linear_to_reflectance.
 * @param {[number, number, number]|number[]} lrgb linear rgb
 * @returns {Float64Array} 38-band reflectance
 */
export function linearToReflectance(lrgb) {
  const w = Math.min(lrgb[0], lrgb[1], lrgb[2]);
  const lr = lrgb[0] - w;
  const lg = lrgb[1] - w;
  const lb = lrgb[2] - w;

  const c = Math.min(lg, lb);
  const m = Math.min(lr, lb);
  const y = Math.min(lr, lg);

  const r = Math.min(Math.max(0, lr - lb), Math.max(0, lr - lg));
  const g = Math.min(Math.max(0, lg - lb), Math.max(0, lg - lr));
  const b = Math.min(Math.max(0, lb - lg), Math.max(0, lb - lr));

  const R = new Float64Array(SPECTRAL_SIZE);
  for (let i = 0; i < SPECTRAL_SIZE; i++) {
    const row = SPECTRAL_L2R[i];
    R[i] = Math.max(
      SPECTRAL_EPSILON,
      w * row[0] + c * row[1] + m * row[2] + y * row[3] + r * row[4] + g * row[5] + b * row[6],
    );
  }
  return R;
}

/**
 * shader.frag spectral_reflectance_to_xyz.
 * @param {ArrayLike<number>} R 38-band reflectance
 * @returns {[number, number, number]} XYZ
 */
export function reflectanceToXYZ(R) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < SPECTRAL_SIZE; i++) {
    const row = SPECTRAL_R_TO_XYZ[i];
    x += R[i] * row[0];
    y += R[i] * row[1];
    z += R[i] * row[2];
  }
  return [x, y, z];
}

/**
 * Precomputes the hoisted half of spectral_mix for one sRGB color:
 * its 38-band reflectance packed vec4-wide (40 floats, last 2 zero —
 * matching `array<vec4f, 10>` uniform stride) and its XYZ luminance.
 *
 * Memoized on the last color seen — "compute once when the blend color
 * changes" — so W3 can call this per composite without bookkeeping.
 *
 * @param {[number, number, number]|number[]} color sRGB in [0,1]
 * @returns {{r2: Float32Array, luminance: number}} shared, do not mutate
 */
export function precomputeReflectance(color) {
  if (
    cached &&
    cachedColor[0] === color[0] &&
    cachedColor[1] === color[1] &&
    cachedColor[2] === color[2]
  ) {
    return cached;
  }
  const lrgb = [
    spectralUncompand(color[0]),
    spectralUncompand(color[1]),
    spectralUncompand(color[2]),
  ];
  const R = linearToReflectance(lrgb);
  const r2 = new Float32Array(40);
  r2.set(R);
  cached = { r2, luminance: reflectanceToXYZ(R)[1] };
  cachedColor = [color[0], color[1], color[2]];
  return cached;
}

/** @type {{r2: Float32Array, luminance: number}|null} */
let cached = null;
/** @type {number[]} */
let cachedColor = [];

// ---------------------------------------------------------------------------
// BlendUniforms packing (must mirror struct BlendUniforms in spectral.wgsl)
// ---------------------------------------------------------------------------

/** Byte size of BlendUniforms. */
export const BLEND_UNIFORM_BYTES = 192;
/** Float32 offsets into the packed array. */
export const BLEND_UNIFORM_OFFSETS = {
  r2: 0, // 40 floats (array<vec4f, 10>)
  lum2: 40,
  isBrush: 41, // u32
  targetIsFramebuffer: 42, // u32
  color: 44, // vec4f
};

/**
 * Packs the composite pass uniform block.
 *
 * @param {{color: number[], isBrush?: boolean, targetIsFramebuffer?: boolean}} opts
 *   color: blend color, sRGB [0,1] (shader.frag u_color)
 * @param {Float32Array} [out] length ≥ 48; allocated when omitted
 * @returns {Float32Array} out — pass to uniformRing.write()
 */
export function packBlendUniforms(opts, out = new Float32Array(48)) {
  const { r2, luminance } = precomputeReflectance(opts.color);
  out.set(r2, BLEND_UNIFORM_OFFSETS.r2);
  out[BLEND_UNIFORM_OFFSETS.lum2] = luminance;
  const u32 = new Uint32Array(out.buffer, out.byteOffset, 48);
  u32[BLEND_UNIFORM_OFFSETS.isBrush] = opts.isBrush ? 1 : 0;
  u32[BLEND_UNIFORM_OFFSETS.targetIsFramebuffer] = opts.targetIsFramebuffer ? 1 : 0;
  out[43] = 0;
  out[BLEND_UNIFORM_OFFSETS.color + 0] = opts.color[0];
  out[BLEND_UNIFORM_OFFSETS.color + 1] = opts.color[1];
  out[BLEND_UNIFORM_OFFSETS.color + 2] = opts.color[2];
  out[BLEND_UNIFORM_OFFSETS.color + 3] = 1;
  return out;
}

// ---------------------------------------------------------------------------
// CPU reference mix (tests / oracle cross-checks; not a frame-path API)
// ---------------------------------------------------------------------------

/**
 * Full CPU port of GLSL spectral_mix(color1, color2, factor)
 * (tintingStrength = 1). Float64 throughout.
 *
 * @param {number[]} color1 sRGB [0,1]
 * @param {number[]} color2 sRGB [0,1]
 * @param {number} t mix factor toward color2
 * @returns {[number, number, number]} sRGB [0,1]
 */
export function spectralMix(color1, color2, t) {
  const R1 = linearToReflectance(color1.map(spectralUncompand));
  const R2 = linearToReflectance(color2.map(spectralUncompand));
  const luminance1 = reflectanceToXYZ(R1)[1];
  const luminance2 = reflectanceToXYZ(R2)[1];

  const f1 = 1 - t;
  const concentration1 = f1 * f1 * luminance1;
  const concentration2 = t * t * luminance2;
  const total = concentration1 + concentration2;

  const KS = (R) => ((1 - R) * (1 - R)) / (2 * R);
  const KM = (ks) => 1 + ks - Math.sqrt(ks * ks + 2 * ks);

  const R = new Float64Array(SPECTRAL_SIZE);
  for (let i = 0; i < SPECTRAL_SIZE; i++) {
    R[i] = KM((KS(R1[i]) * concentration1 + KS(R2[i]) * concentration2) / total);
  }
  const xyz = reflectanceToXYZ(R);
  return [
    spectralCompand(
      SPECTRAL_XYZ_TO_RGB[0][0] * xyz[0] + SPECTRAL_XYZ_TO_RGB[0][1] * xyz[1] + SPECTRAL_XYZ_TO_RGB[0][2] * xyz[2],
    ),
    spectralCompand(
      SPECTRAL_XYZ_TO_RGB[1][0] * xyz[0] + SPECTRAL_XYZ_TO_RGB[1][1] * xyz[1] + SPECTRAL_XYZ_TO_RGB[1][2] * xyz[2],
    ),
    spectralCompand(
      SPECTRAL_XYZ_TO_RGB[2][0] * xyz[0] + SPECTRAL_XYZ_TO_RGB[2][1] * xyz[1] + SPECTRAL_XYZ_TO_RGB[2][2] * xyz[2],
    ),
  ];
}
