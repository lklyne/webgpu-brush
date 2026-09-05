// =============================================================================
// Pipeline / bind-group caches, uniform ring, texture upload (W1a)
//
// Gotcha #8: you own the pipeline cache. Every render pipeline is keyed on
// (shader module, blend state, target format, stencil state) plus the
// vertex layout and topology that also feed pipeline compilation. Get the
// key wrong and pipelines rebuild per draw — the one place raw WebGPU can
// be slower than three.
//
// The cache instruments itself (`stats.pipelines`) so "pipeline count
// stable after warmup" is an assertion, not a hope.
// =============================================================================

// ---------------------------------------------------------------------------
// Stable identity for GPU objects (modules, layouts, views, buffers) so they
// can participate in string cache keys. WeakMap → monotonically increasing id.
// ---------------------------------------------------------------------------

let nextId = 1;
const ids = new WeakMap();

/**
 * @param {object} obj
 * @returns {number} stable id for the object's lifetime
 */
export function idOf(obj) {
  let id = ids.get(obj);
  if (id === undefined) {
    id = nextId++;
    ids.set(obj, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Pipeline cache
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RenderPipelineDesc
 * @property {string} [code]        WGSL source (cached per source string)
 * @property {GPUShaderModule} [module] pre-created module (else `code`)
 * @property {string} [vertexEntry]   default "vs"
 * @property {string} [fragmentEntry] default "fs"; null → no fragment stage
 * @property {GPUVertexBufferLayout[]} [buffers] vertex buffer layouts
 * @property {GPUBlendState|null} [blend]  null → no blending (replace)
 * @property {GPUTextureFormat} [format]   color target format
 * @property {GPUColorWriteFlags} [writeMask]
 * @property {GPUDepthStencilState|null} [stencil] full depthStencil state
 * @property {GPUPrimitiveTopology} [topology] default "triangle-list"
 * @property {GPUCullMode} [cullMode] default "none"
 * @property {string} [label]
 */

/**
 * Creates the shared caches. One instance per GpuContext; pass it around —
 * two instances would compile every pipeline twice.
 *
 * @param {import('./device.js').GpuContext} gpu
 */
export function createPipelineCache(gpu) {
  const { device } = gpu;
  /** @type {Map<string, GPUShaderModule>} */
  const modules = new Map();
  /** @type {Map<string, GPURenderPipeline|GPUComputePipeline>} */
  const pipelines = new Map();
  /** @type {Map<string, GPUBindGroup>} */
  const bindGroups = new Map();

  const stats = {
    modules: 0,
    pipelines: 0,
    pipelineHits: 0,
    bindGroups: 0,
    bindGroupHits: 0,
  };

  /**
   * @param {string} code WGSL source
   * @param {string} [label]
   * @returns {GPUShaderModule}
   */
  function getModule(code, label) {
    let m = modules.get(code);
    if (!m) {
      m = device.createShaderModule({ code, label });
      modules.set(code, m);
      stats.modules++;
    }
    return m;
  }

  /**
   * Render pipeline, cached on (module, blend, format, stencil, vertex
   * layout, topology, cull, write mask).
   * @param {RenderPipelineDesc} desc
   * @returns {GPURenderPipeline}
   */
  function getRenderPipeline(desc) {
    const module = desc.module ?? getModule(desc.code, desc.label);
    const vertexEntry = desc.vertexEntry ?? "vs";
    const fragmentEntry = desc.fragmentEntry ?? "fs";
    const format = desc.format ?? gpu.format;
    const topology = desc.topology ?? "triangle-list";
    const cullMode = desc.cullMode ?? "none";
    const key = [
      "r",
      idOf(module),
      vertexEntry,
      fragmentEntry,
      format,
      JSON.stringify(desc.blend ?? null),
      JSON.stringify(desc.stencil ?? null),
      JSON.stringify(desc.buffers ?? null),
      topology,
      cullMode,
      desc.writeMask ?? GPUColorWrite.ALL,
    ].join("|");

    let p = pipelines.get(key);
    if (p) {
      stats.pipelineHits++;
      return p;
    }
    p = device.createRenderPipeline({
      label: desc.label,
      layout: "auto",
      vertex: { module, entryPoint: vertexEntry, buffers: desc.buffers ?? [] },
      fragment:
        fragmentEntry === null
          ? undefined
          : {
              module,
              entryPoint: fragmentEntry,
              targets: [
                {
                  format,
                  blend: desc.blend ?? undefined,
                  writeMask: desc.writeMask ?? GPUColorWrite.ALL,
                },
              ],
            },
      primitive: { topology, cullMode },
      depthStencil: desc.stencil ?? undefined,
    });
    pipelines.set(key, p);
    stats.pipelines++;
    return p;
  }

  /**
   * Compute pipeline, cached on (module, entry point).
   * @param {{code?: string, module?: GPUShaderModule, entry?: string, label?: string}} desc
   * @returns {GPUComputePipeline}
   */
  function getComputePipeline(desc) {
    const module = desc.module ?? getModule(desc.code, desc.label);
    const entry = desc.entry ?? "main";
    // desc.layout (a GPUPipelineLayout) opts out of 'auto' — needed when the
    // caller wants dynamic-offset uniform bindings, which auto layouts never
    // declare. Keyed by layout identity so the two variants cannot collide.
    const key = `c|${idOf(module)}|${entry}|${desc.layout ? idOf(desc.layout) : "auto"}`;
    let p = pipelines.get(key);
    if (p) {
      stats.pipelineHits++;
      return p;
    }
    p = device.createComputePipeline({
      label: desc.label,
      layout: desc.layout ?? "auto",
      compute: { module, entryPoint: entry },
    });
    pipelines.set(key, p);
    stats.pipelines++;
    return p;
  }

  /**
   * Bind-group cache keyed on layout identity + resource identities (+
   * buffer offset/size). Resources are identified via idOf, so any new
   * texture view or buffer yields a new entry; reused resources hit.
   *
   * NOTE: entries whose resources are destroyed are not evicted — callers
   * that churn resources per frame (e.g. the uniform ring) should pass the
   * ring buffer itself (stable identity) and use dynamic offsets, or accept
   * unbounded growth and skip the cache via device.createBindGroup.
   *
   * CALLER CONTRACT: hold a stable reference to the layout —
   * `pipeline.getBindGroupLayout(0)` returns a NEW wrapper object per
   * call, which would defeat identity keying. Call it once per pipeline
   * and reuse.
   *
   * @param {GPUBindGroupLayout} layout
   * @param {GPUBindGroupEntry[]} entries
   * @param {string} [label]
   * @returns {GPUBindGroup}
   */
  function getBindGroup(layout, entries, label) {
    const key = [
      idOf(layout),
      ...entries.map((e) => {
        const r = e.resource;
        if (r.buffer) return `${e.binding}:b${idOf(r.buffer)}@${r.offset ?? 0}+${r.size ?? -1}`;
        return `${e.binding}:o${idOf(r)}`;
      }),
    ].join("|");
    let bg = bindGroups.get(key);
    if (bg) {
      stats.bindGroupHits++;
      return bg;
    }
    bg = device.createBindGroup({ layout, entries, label });
    bindGroups.set(key, bg);
    stats.bindGroups++;
    return bg;
  }

  return { getModule, getRenderPipeline, getComputePipeline, getBindGroup, stats };
}

// ---------------------------------------------------------------------------
// Uniform buffer ring
// ---------------------------------------------------------------------------

/**
 * A per-frame uniform allocator: one GPUBuffer, 256-byte-aligned slots,
 * written with queue.writeBuffer. Call reset() once per frame; write()
 * returns a { buffer, offset, size } binding for getBindGroup. The buffer
 * identity is stable, so bind groups keyed on (buffer, offset) cache
 * across frames once every slot has been seen.
 *
 * Growth policy matches gl_draw.js: reallocate only when exceeded (the
 * old buffer is destroyed; in-flight frames referencing it are complete
 * because growth happens at write time, before submit).
 *
 * @param {import('./device.js').GpuContext} gpu
 * @param {{slots?: number, slotSize?: number}} [opts]
 */
export function createUniformRing(gpu, opts = {}) {
  const ALIGN = 256;
  let slotSize = Math.ceil((opts.slotSize ?? 256) / ALIGN) * ALIGN;
  let capacity = opts.slots ?? 64;
  let buffer = alloc();
  let cursor = 0;

  function alloc() {
    return gpu.createBuffer({
      label: "uniform-ring",
      size: slotSize * capacity,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  return {
    /** Start of frame. */
    reset() {
      cursor = 0;
    },
    /**
     * Guarantee `n` slots fit without a mid-batch reallocation. Call BEFORE
     * encoding a batch that writes many slots into one command encoder:
     * growth destroys the old buffer, which would invalidate bind groups
     * already recorded against it in that encoder.
     * @param {number} n
     */
    reserve(n) {
      if (n <= capacity) return;
      while (capacity < n) capacity *= 2;
      buffer.destroy();
      buffer = alloc();
      cursor = 0;
    },
    /**
     * @param {ArrayBufferView} data byte length ≤ slotSize
     * @returns {{buffer: GPUBuffer, offset: number, size: number}}
     */
    write(data) {
      if (data.byteLength > slotSize) {
        // Slot too small: grow slot size (rare — uniform structs are static).
        slotSize = Math.ceil(data.byteLength / ALIGN) * ALIGN;
        buffer.destroy();
        buffer = alloc();
        cursor = 0;
      }
      if (cursor >= capacity) {
        // Reallocate only when exceeded.
        capacity *= 2;
        buffer.destroy();
        buffer = alloc();
        cursor = 0;
      }
      const offset = cursor * slotSize;
      gpu.device.queue.writeBuffer(buffer, offset, data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
      cursor++;
      return { buffer, offset, size: data.byteLength };
    },
    get buffer() {
      return buffer;
    },
    destroy() {
      buffer.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Texture upload
// ---------------------------------------------------------------------------

/**
 * Uploads pixels to a new (tracked) texture.
 *
 * @param {import('./device.js').GpuContext} gpu
 * @param {Uint8Array|Uint8ClampedArray|ImageBitmap|HTMLCanvasElement|OffscreenCanvas} source
 *   Typed array → queue.writeTexture (tightly packed rows assumed).
 *   Image-ish → copyExternalImageToTexture.
 * @param {{width: number, height: number, format?: GPUTextureFormat,
 *          usage?: GPUTextureUsageFlags, label?: string,
 *          premultipliedAlpha?: boolean}} opts
 *   width/height required for typed arrays; inferred for images.
 * @returns {GPUTexture}
 */
export function uploadTexture(gpu, source, opts = {}) {
  const isPixels = ArrayBuffer.isView(source);
  const width = opts.width ?? source.width;
  const height = opts.height ?? source.height;
  const format = opts.format ?? "rgba8unorm";
  const texture = gpu.createTexture({
    label: opts.label,
    size: { width, height },
    format,
    usage:
      (opts.usage ?? 0) |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  if (isPixels) {
    const bytesPerPixel = source.byteLength / (width * height);
    gpu.device.queue.writeTexture(
      { texture },
      source,
      { bytesPerRow: width * bytesPerPixel, rowsPerImage: height },
      { width, height },
    );
  } else {
    gpu.device.queue.copyExternalImageToTexture(
      { source },
      { texture, premultipliedAlpha: opts.premultipliedAlpha ?? false },
      { width, height },
    );
  }
  return texture;
}
