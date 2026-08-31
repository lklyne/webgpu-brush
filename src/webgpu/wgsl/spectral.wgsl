// =============================================================================
// spectral.wgsl (W2 spectral-wgsl)
//
// WGSL port of src/core/gl/shader.frag lines 15–197 (spectral.js
// Kubelka-Munk pigment mixing) plus the composite entry (shader.frag
// main, lines 204–245).
//
// Differences from the GLSL, all deliberate:
//
// - Reflectance hoist: `spectral_mix_precomputed(bg, r2, lum2, t)` is the
//   primary entry. R2 + luminance2 for the blend color are computed ONCE
//   on the CPU when the color changes (src/webgpu/spectral.js →
//   packBlendUniforms) and passed in the uniform block, halving the
//   per-pixel 38-band work. The full path (`spectral_mix_full`) survives
//   only for the u_isBrush && maskColor.a > DARKEN_THRESHOLD darken
//   branch, where the pigment is perturbed per-pixel.
// - Gotcha #2: the GLSL calls dFdx/dFdy inside `if (!u_isBrush)`, *after*
//   a non-uniform early return on maskColor.a — WGSL rejects derivatives
//   (and textureSample) in non-uniform control flow. The whole blur-edge
//   loop is hoisted above every branch; WGSL spells them dpdx/dpdy.
// - pow(x, 2.0) is spelled x*x. WGSL pow() is exp2(y*log2(x)) — NaN for
//   the negative bases that occur here (1-R is negative for near-white
//   reflectances > 1). GLSL drivers strength-reduce pow(x,2.0); WGSL/Metal
//   must not be trusted to.
// - GLSL's unused `scaledAlpha` local (shader.frag:228, dead code) is
//   dropped.
// - The two constant tables between the GENERATED markers are transcribed
//   programmatically from shader.frag by scripts/spectral-gen-tables.mjs
//   (plan: "transcribe programmatically, not by hand"). Do not hand-edit;
//   rerun the script.
//
// Bindings (composite entry; see spectral.js for the uniform layout):
//   @group(0) @binding(0) uniform BlendUniforms
//   @group(0) @binding(1) u_source texture_2d<f32>
//   @group(0) @binding(2) u_mask   texture_2d<f32>
//   @group(0) @binding(3) sampler
// =============================================================================

const SPECTRAL_SIZE: i32 = 38;
const SPECTRAL_GAMMA: f32 = 2.4;
const SPECTRAL_EPSILON: f32 = 0.0001;

const DARKEN_THRESHOLD: f32 = 0.7;
const EDGE_MIN: f32 = 0.05;
const EDGE_MAX: f32 = 0.35;

fn spectral_uncompand(x: f32) -> f32 {
  return select(pow((x + 0.055) / 1.055, SPECTRAL_GAMMA), x / 12.92, x < 0.04045);
}

fn spectral_compand(x: f32) -> f32 {
  return select(1.055 * pow(x, 1.0 / SPECTRAL_GAMMA) - 0.055, x * 12.92, x < 0.0031308);
}

fn spectral_srgb_to_linear(srgb: vec3f) -> vec3f {
  return vec3f(
    spectral_uncompand(srgb.x),
    spectral_uncompand(srgb.y),
    spectral_uncompand(srgb.z),
  );
}

fn spectral_linear_to_srgb(lrgb: vec3f) -> vec3f {
  return clamp(
    vec3f(spectral_compand(lrgb.x), spectral_compand(lrgb.y), spectral_compand(lrgb.z)),
    vec3f(0.0),
    vec3f(1.0),
  );
}

// BEGIN GENERATED TABLES (scripts/spectral-gen-tables.mjs — do not hand-edit)

// spectral_linear_to_reflectance coefficients, split (w,c,m,y) | (r,g,b).
const SPECTRAL_L2R_WCMY = array<vec4f, 38>(
  vec4f(1.0011607271876400, 0.9705850013229620, 0.9906735573199880, 0.0210523371789306),
  vec4f(1.0011606515972800, 0.9705924981434250, 0.9906715249619790, 0.0210564627517414),
  vec4f(1.0011603192274700, 0.9706253487298910, 0.9906625823534210, 0.0210746178695038),
  vec4f(1.0011586727078900, 0.9707868061190170, 0.9906181076447950, 0.0211649058448753),
  vec4f(1.0011525984455200, 0.9713686732282480, 0.9904514808787100, 0.0215027957272504),
  vec4f(1.0011325252899800, 0.9731632306212520, 0.9898710814002040, 0.0226738799041561),
  vec4f(1.0010850066332700, 0.9767402231587650, 0.9882866087596400, 0.0258235649693629),
  vec4f(1.0009968788945300, 0.9815876054913770, 0.9842906927975040, 0.0334879385639851),
  vec4f(1.0008652515227400, 0.9862802656529490, 0.9739349056253060, 0.0519069663740307),
  vec4f(1.0006962900094000, 0.9899491476891340, 0.9418178384601450, 0.1007490148334730),
  vec4f(1.0005049611488800, 0.9924927015384200, 0.8173903261951560, 0.2391298997068470),
  vec4f(1.0003080818799200, 0.9941456804052560, 0.4324728050657290, 0.5348043122727480),
  vec4f(1.0001196660201300, 0.9951839750332120, 0.1384539782588700, 0.7978075786430300),
  vec4f(0.9999527659684070, 0.9957567501108180, 0.0537347216940033, 0.9114498940673840),
  vec4f(0.9998218368992970, 0.9959128182867100, 0.0292174996673231, 0.9537979630045070),
  vec4f(0.9997386095575930, 0.9956061578345280, 0.0213136517508590, 0.9712416154654290),
  vec4f(0.9997095516396120, 0.9945976009618540, 0.0201349530181136, 0.9793031238075880),
  vec4f(0.9997319302106270, 0.9922157154923700, 0.0241323096280662, 0.9833801195075750),
  vec4f(0.9997994363461950, 0.9862364527832490, 0.0372236145223627, 0.9854612465677550),
  vec4f(0.9999003303166710, 0.9679433372645410, 0.0760506552706601, 0.9864350469766050),
  vec4f(1.0000204065261100, 0.8912850042449430, 0.2053754719423990, 0.9867382506701410),
  vec4f(1.0001447879365800, 0.5362024778620530, 0.5412689034604390, 0.9866178824450320),
  vec4f(1.0002599790341200, 0.1541081190018780, 0.8158416850864860, 0.9862777767586430),
  vec4f(1.0003557969708900, 0.0574575093228929, 0.9128177041239760, 0.9858605924440560),
  vec4f(1.0004275378026900, 0.0315349873107007, 0.9463398301669620, 0.9854749276762100),
  vec4f(1.0004762334488800, 0.0222633920086335, 0.9599276963319910, 0.9851769347655580),
  vec4f(1.0005072096750800, 0.0182022841492439, 0.9662605952303120, 0.9849715740141810),
  vec4f(1.0005251915637300, 0.0162990559732640, 0.9693259700584240, 0.9848463034157120),
  vec4f(1.0005350960689600, 0.0153656239334613, 0.9708545367213990, 0.9847753518111990),
  vec4f(1.0005402209748200, 0.0149111568733976, 0.9716050665281280, 0.9847380666252650),
  vec4f(1.0005427281678400, 0.0146954339898235, 0.9719627697573920, 0.9847196483117650),
  vec4f(1.0005438956908700, 0.0145964146717719, 0.9721272722745090, 0.9847110233919390),
  vec4f(1.0005444821215100, 0.0145470156699655, 0.9722094177458120, 0.9847066833006760),
  vec4f(1.0005447695999200, 0.0145228771899495, 0.9722495776784240, 0.9847045543930910),
  vec4f(1.0005448988776200, 0.0145120341118965, 0.9722676219987420, 0.9847035963093700),
  vec4f(1.0005449625468900, 0.0145066940939832, 0.9722765094621500, 0.9847031240775520),
  vec4f(1.0005449892705800, 0.0145044507314479, 0.9722802433068740, 0.9847029256150900),
  vec4f(1.0005449969930000, 0.0145038009464639, 0.9722813248265600, 0.9847028681227950),
);

const SPECTRAL_L2R_RGB = array<vec3f, 38>(
  vec3f(0.0315605737777207, 0.0095560747554212, 0.9794047525020140),
  vec3f(0.0315520718330149, 0.0095581580120851, 0.9794007068431300),
  vec3f(0.0315148215513658, 0.0095673245444588, 0.9793829034702610),
  vec3f(0.0313318044982702, 0.0096129126297349, 0.9792943649455940),
  vec3f(0.0306729857725527, 0.0097837090401843, 0.9789630146085700),
  vec3f(0.0286480476989607, 0.0103786227058710, 0.9778144666940430),
  vec3f(0.0246450407045709, 0.0120026452378567, 0.9747243211338360),
  vec3f(0.0192960753663651, 0.0160977721473922, 0.9671984823439730),
  vec3f(0.0142066612220556, 0.0267061902231680, 0.9490796575305750),
  vec3f(0.0102942608878609, 0.0595555440185881, 0.9008501289409770),
  vec3f(0.0076191460521811, 0.1860398265328260, 0.7631504454622400),
  vec3f(0.0058980410835420, 0.5705798201161590, 0.4659221716493190),
  vec3f(0.0048233247781713, 0.8614677684002920, 0.2012632804510050),
  vec3f(0.0042298748350633, 0.9458790897676580, 0.0877524413419623),
  vec3f(0.0040599171299341, 0.9704654864743050, 0.0457176793291679),
  vec3f(0.0043533695594676, 0.9784136302844500, 0.0284706050521843),
  vec3f(0.0053434425970201, 0.9795890314112240, 0.0205271767569850),
  vec3f(0.0076917201010463, 0.9755335369086320, 0.0165302792310211),
  vec3f(0.0135969795736536, 0.9622887553978130, 0.0145135107212858),
  vec3f(0.0316975442661115, 0.9231215745131200, 0.0136003508637687),
  vec3f(0.1078611963552490, 0.7934340189431110, 0.0133604258769571),
  vec3f(0.4638126031687040, 0.4592701359024290, 0.0135488943145680),
  vec3f(0.8470554052720110, 0.1855741036663030, 0.0139594356366992),
  vec3f(0.9431854093939180, 0.0881774959955372, 0.0144434255753570),
  vec3f(0.9688621506965580, 0.0543630228766700, 0.0148854440621406),
  vec3f(0.9780306674736030, 0.0406288447060719, 0.0152254296999746),
  vec3f(0.9820436438543060, 0.0342215204316970, 0.0154592848180209),
  vec3f(0.9839236237187070, 0.0311185790956966, 0.0156018026485961),
  vec3f(0.9848454841543820, 0.0295708898336134, 0.0156824871281936),
  vec3f(0.9852942758145960, 0.0288108739348928, 0.0157248764360615),
  vec3f(0.9855072952198250, 0.0284486271324597, 0.0157458108784121),
  vec3f(0.9856050715398370, 0.0282820301724731, 0.0157556123350225),
  vec3f(0.9856538499335780, 0.0281988376490237, 0.0157605443964911),
  vec3f(0.9856776850338830, 0.0281581655342037, 0.0157629637515278),
  vec3f(0.9856883918061220, 0.0281398910216386, 0.0157640525629106),
  vec3f(0.9856936646900310, 0.0281308901665811, 0.0157645892329510),
  vec3f(0.9856958798482050, 0.0281271086805816, 0.0157648147772649),
  vec3f(0.9856965214637620, 0.0281260133612096, 0.0157648801149616),
);

// spectral_reflectance_to_xyz CIE weights.
const SPECTRAL_R_TO_XYZ = array<vec3f, 38>(
  vec3f(0.0000646919989576, 0.0000018442894440, 0.0003050171476380),
  vec3f(0.0002194098998132, 0.0000062053235865, 0.0010368066663574),
  vec3f(0.0011205743509343, 0.0000310096046799, 0.0053131363323992),
  vec3f(0.0037666134117111, 0.0001047483849269, 0.0179543925899536),
  vec3f(0.0118805536037990, 0.0003536405299538, 0.0570775815345485),
  vec3f(0.0232864424191771, 0.0009514714056444, 0.1136516189362870),
  vec3f(0.0345594181969747, 0.0022822631748318, 0.1733587261835500),
  vec3f(0.0372237901162006, 0.0042073290434730, 0.1962065755586570),
  vec3f(0.0324183761091486, 0.0066887983719014, 0.1860823707062960),
  vec3f(0.0212332056093810, 0.0098883960193565, 0.1399504753832070),
  vec3f(0.0104909907685421, 0.0152494514496311, 0.0891745294268649),
  vec3f(0.0032958375797931, 0.0214183109449723, 0.0478962113517075),
  vec3f(0.0005070351633801, 0.0334229301575068, 0.0281456253957952),
  vec3f(0.0009486742057141, 0.0513100134918512, 0.0161376622950514),
  vec3f(0.0062737180998318, 0.0704020839399490, 0.0077591019215214),
  vec3f(0.0168646241897775, 0.0878387072603517, 0.0042961483736618),
  vec3f(0.0286896490259810, 0.0942490536184085, 0.0020055092122156),
  vec3f(0.0426748124691731, 0.0979566702718931, 0.0008614711098802),
  vec3f(0.0562547481311377, 0.0941521856862608, 0.0003690387177652),
  vec3f(0.0694703972677158, 0.0867810237486753, 0.0001914287288574),
  vec3f(0.0830531516998291, 0.0788565338632013, 0.0001495555858975),
  vec3f(0.0861260963002257, 0.0635267026203555, 0.0000923109285104),
  vec3f(0.0904661376847769, 0.0537414167568200, 0.0000681349182337),
  vec3f(0.0850038650591277, 0.0426460643574120, 0.0000288263655696),
  vec3f(0.0709066691074488, 0.0316173492792708, 0.0000157671820553),
  vec3f(0.0506288916373645, 0.0208852059213910, 0.0000039406041027),
  vec3f(0.0354739618852640, 0.0138601101360152, 0.0000015840125870),
  vec3f(0.0214682102597065, 0.0081026402038399, 0.0000000000000000),
  vec3f(0.0125164567619117, 0.0046301022588030, 0.0000000000000000),
  vec3f(0.0068045816390165, 0.0024913800051319, 0.0000000000000000),
  vec3f(0.0034645657946526, 0.0012593033677378, 0.0000000000000000),
  vec3f(0.0014976097506959, 0.0005416465221680, 0.0000000000000000),
  vec3f(0.0007697004809280, 0.0002779528920067, 0.0000000000000000),
  vec3f(0.0004073680581315, 0.0001471080673854, 0.0000000000000000),
  vec3f(0.0001690104031614, 0.0000610327472927, 0.0000000000000000),
  vec3f(0.0000952245150365, 0.0000343873229523, 0.0000000000000000),
  vec3f(0.0000490309872958, 0.0000177059860053, 0.0000000000000000),
  vec3f(0.0000199961492222, 0.0000072209749130, 0.0000000000000000),
);

// XYZ→linear-sRGB rows (GLSL XYZ_RGB, used row-wise with dot()).
const SPECTRAL_XYZ_TO_RGB = array<vec3f, 3>(
  vec3f(3.2409699419045200, -1.537383177570090, -0.4986107602930030),
  vec3f(-0.9692436362808790, 1.875967501507720, 0.0415550574071756),
  vec3f(0.0556300796969936, -0.203976958888976, 1.0569715142428700),
);

// END GENERATED TABLES

fn spectral_linear_to_reflectance(lrgb_in: vec3f) -> array<f32, 38> {
  var lrgb = lrgb_in;
  let w = min(lrgb.r, min(lrgb.g, lrgb.b));

  lrgb -= vec3f(w);

  let c = min(lrgb.g, lrgb.b);
  let m = min(lrgb.r, lrgb.b);
  let y = min(lrgb.r, lrgb.g);

  let r = min(max(0.0, lrgb.r - lrgb.b), max(0.0, lrgb.r - lrgb.g));
  let g = min(max(0.0, lrgb.g - lrgb.b), max(0.0, lrgb.g - lrgb.r));
  let b = min(max(0.0, lrgb.b - lrgb.g), max(0.0, lrgb.b - lrgb.r));

  var R: array<f32, 38>;
  for (var i = 0; i < SPECTRAL_SIZE; i++) {
    R[i] = max(
      SPECTRAL_EPSILON,
      dot(SPECTRAL_L2R_WCMY[i], vec4f(w, c, m, y)) + dot(SPECTRAL_L2R_RGB[i], vec3f(r, g, b)),
    );
  }
  return R;
}

fn spectral_xyz_to_srgb(xyz: vec3f) -> vec3f {
  let r = dot(SPECTRAL_XYZ_TO_RGB[0], xyz);
  let g = dot(SPECTRAL_XYZ_TO_RGB[1], xyz);
  let b = dot(SPECTRAL_XYZ_TO_RGB[2], xyz);
  return spectral_linear_to_srgb(vec3f(r, g, b));
}

fn spectral_reflectance_to_xyz(R: array<f32, 38>) -> vec3f {
  var xyz = vec3f(0.0);
  for (var i = 0; i < SPECTRAL_SIZE; i++) {
    xyz += R[i] * SPECTRAL_R_TO_XYZ[i];
  }
  return xyz;
}

fn spectral_ks(R: f32) -> f32 {
  let t = 1.0 - R;
  return (t * t) / (2.0 * R);
}

fn spectral_km(ks: f32) -> f32 {
  return 1.0 + ks - sqrt(ks * ks + 2.0 * ks);
}

// Full 38-band mix, both colors converted per call. GLSL
// spectral_mix(color1, color2, factor) with tintingStrength = 1.
// Used only by the darken branch, where pigment varies per-pixel.
fn spectral_mix_full(color1: vec3f, color2: vec3f, t: f32) -> vec3f {
  let R1 = spectral_linear_to_reflectance(spectral_srgb_to_linear(color1));
  let R2 = spectral_linear_to_reflectance(spectral_srgb_to_linear(color2));

  let luminance1 = spectral_reflectance_to_xyz(R1).y;
  let luminance2 = spectral_reflectance_to_xyz(R2).y;

  let factor1 = 1.0 - t;
  let concentration1 = factor1 * factor1 * luminance1;
  let concentration2 = t * t * luminance2;
  let totalConcentration = concentration1 + concentration2;

  var R: array<f32, 38>;
  for (var i = 0; i < SPECTRAL_SIZE; i++) {
    let ksMix = spectral_ks(R1[i]) * concentration1 + spectral_ks(R2[i]) * concentration2;
    R[i] = spectral_km(ksMix / totalConcentration);
  }
  return spectral_xyz_to_srgb(spectral_reflectance_to_xyz(R));
}

// Reflectance-hoisted mix: color2's reflectance (r2, packed 4-wide for
// uniform-stride rules; 38 of 40 lanes used) and luminance2 arrive
// precomputed from the CPU (spectral.js). Only the background still pays
// the linear→reflectance conversion per pixel.
fn spectral_mix_precomputed(bg: vec3f, r2: array<vec4f, 10>, luminance2: f32, t: f32) -> vec3f {
  let R1 = spectral_linear_to_reflectance(spectral_srgb_to_linear(bg));
  let luminance1 = spectral_reflectance_to_xyz(R1).y;

  let factor1 = 1.0 - t;
  let concentration1 = factor1 * factor1 * luminance1;
  let concentration2 = t * t * luminance2;
  let totalConcentration = concentration1 + concentration2;

  var R: array<f32, 38>;
  for (var i = 0; i < SPECTRAL_SIZE; i++) {
    let ksMix = spectral_ks(R1[i]) * concentration1 + spectral_ks(r2[i / 4][i % 4]) * concentration2;
    R[i] = spectral_km(ksMix / totalConcentration);
  }
  return spectral_xyz_to_srgb(spectral_reflectance_to_xyz(R));
}

// -----------------------------------------------------------------------------
// Composite entry (shader.frag main). Fullscreen triangle; no vertex buffers.
// -----------------------------------------------------------------------------

// Layout mirrored by packBlendUniforms in src/webgpu/spectral.js.
// r2 @0 (160 B) | lum2 @160 | isBrush @164 | targetIsFramebuffer @168 |
// pad @172 | color @176 (vec4f) | total 192 B.
struct BlendUniforms {
  r2: array<vec4f, 10>,
  lum2: f32,
  isBrush: u32,
  targetIsFramebuffer: u32,
  _pad0: u32,
  color: vec4f,
};

@group(0) @binding(0) var<uniform> u: BlendUniforms;
@group(0) @binding(1) var u_source: texture_2d<f32>;
@group(0) @binding(2) var u_mask: texture_2d<f32>;
@group(0) @binding(3) var u_sampler: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) p: vec2f,
};

// Port of shader.vert: fullscreen triangle, varying p in [-1,1] clip
// space, position y negated exactly as upstream does.
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var v = vec3f(-1.0);
  v[vi] = 3.0;
  var out: VSOut;
  out.p = v.xy;
  out.pos = vec4f(v.x, -v.y, 0.0, 1.0);
  return out;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let uv = 0.5 * in.p + 0.5;
  let sourceUV = vec2f(uv.x, 1.0 - uv.y);
  let maskUV = select(uv, vec2f(uv.x, 1.0 - uv.y), u.targetIsFramebuffer != 0u);

  let source = textureSample(u_source, u_sampler, sourceUV);
  let maskColor = textureSample(u_mask, u_sampler, maskUV);

  // Gotcha #2: the GLSL runs this loop inside `if (!u_isBrush)` and after
  // the maskColor.a early-out. Both the neighbor textureSamples and the
  // dpdx/dpdy require uniform control flow in WGSL, so the whole loop is
  // hoisted above every branch and its result consumed conditionally.
  let texelSize = 1.0 / vec2f(textureDimensions(u_mask, 0));
  var blurEdge = 0.0;
  for (var i = -2; i <= 2; i += 2) {
    for (var j = -2; j <= 2; j += 2) {
      let neighborUV = maskUV + vec2f(f32(i), f32(j)) * texelSize;
      let neighborAlpha = textureSample(u_mask, u_sampler, neighborUV).a * 15.0;
      blurEdge += smoothstep(
        EDGE_MIN,
        EDGE_MAX,
        length(vec2f(dpdx(neighborAlpha), dpdy(neighborAlpha))),
      );
    }
  }
  blurEdge /= 9.0;

  if (maskColor.a == 0.0) {
    return source;
  }

  var mixIntensity = min(maskColor.a, 1.0);
  let bgColor = mix(vec3f(1.0), source.rgb, source.a);

  if (u.isBrush != 0u) {
    if (maskColor.a > DARKEN_THRESHOLD) {
      // Pigment perturbed per-pixel → precomputed R2 no longer matches;
      // the only surviving consumer of the full path.
      let blacken = 0.5 * (min(maskColor.a, 1.0) - DARKEN_THRESHOLD);
      let pigment = max(u.color.rgb * (1.0 - blacken) - vec3f(0.5) * blacken, vec3f(0.0));
      return vec4f(spectral_mix_full(bgColor, pigment, mixIntensity), 1.0);
    }
  } else {
    mixIntensity = clamp(maskColor.a + blurEdge * 0.1, 0.0, 1.0);
  }

  return vec4f(spectral_mix_precomputed(bgColor, u.r2, u.lum2, mixIntensity), 1.0);
}
