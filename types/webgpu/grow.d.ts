/** Total byte size of a poly buffer with the given vertex capacity. */
export function polyByteSize(capacity: any): number;
export function modsByteOffset(capacity: any): number;
export function dirsByteOffset(capacity: any): number;
/** fill.js: GROW_CAP = GROW_MAX_VERTS * Math.max(0.2, 2 * bleed_strength) */
export function computeGrowCap(bleedStrength: any): number;
/** Generated `const STREAM_*` prelude for grow.wgsl. */
export function buildGrowPrelude(): string;
/**
 * Full grow WGSL: prelude + the bundled source (WGSL ships as a .wgsl.js
 * string export so rollup bundles it like any module — no runtime fetch).
 * Kept async for its callers.
 */
export function fetchGrowWgsl(): Promise<string>;
/**
 * The library's hash-stream seed word. utils.js exports it directly
 * (_getSeedU32); the finalizer inversion below survives purely as
 * a cross-check that the hash construction and the export stay in
 * agreement — it fails loudly if either changes.
 * @returns {number} u32
 */
export function deriveSeedU32(): number;
/**
 * Decomposes a positive fraction g <= 1 into { mHi, mLo, shift } with
 * g === (mHi * 2^32 + mLo) * 2^-shift exactly. shift === 0 is the
 * "g <= 0 → result 0" sentinel.
 */
export function decomposeFrac(g: any): {
    mHi: number;
    mLo: number;
    shift: number;
};
/**
 * T[s] (s = 1..STEP_TABLE_LEN) = largest integer idx for which the actual
 * fill.js expression `idx > GROW_CAP ? Math.ceil(idx / GROW_CAP) : 1`
 * yields <= s. Exact by construction: built by evaluating that expression.
 */
export function buildStepTable(growCap: any, maxIdx: any): Uint32Array<ArrayBuffer>;
/** Rebuilds utils.js's trig LUT with the identical expression. */
export function buildTrigTables(): {
    cos: Float32Array<ArrayBuffer>;
    sin: Float32Array<ArrayBuffer>;
};
/**
 * @param {import('./device.js').GpuContext} gpu
 * @param {ReturnType<import('./pipeline.js').createPipelineCache>} cache
 * @param {{capacity?: number, code?: string}} [opts]
 *   capacity — max vertices per poly buffer (default 8192; GROW_CAP bounds
 *   real counts to <= 2 * GROW_MAX_VERTS = 4048, so the default has slack
 *   for trim inserts on top of the cap).
 */
export function createGrowCompute(gpu: import("./device.js").GpuContext, cache: ReturnType<typeof import("./pipeline.js").createPipelineCache>, opts?: {
    capacity?: number;
    code?: string;
}): Promise<{
    capacity: any;
    /** Byte offset of the fill drawIndirect args inside every poly buffer. */
    indirectByteOffset: number;
    /** Byte offset of the border drawIndirect args. */
    borderIndirectByteOffset: number;
    /** The erase circle arena (vec4f per disc). */
    readonly circleBuffer: any;
    /** Stable handle to the arena; `.buffer` follows reallocation. */
    circleRef: {
        buffer: any;
    };
    /**
     * @param {{seed?: number, bleedStrength?: number,
     *          direction?: string, growCap?: number}} s
     * seed defaults to re-deriving from core/utils (call after brush seed()).
     * growCap defaults to the fill.js formula from bleedStrength.
     */
    setState(s?: {
        seed?: number;
        bleedStrength?: number;
        direction?: string;
        growCap?: number;
    }): void;
    /**
     * Gaussian pools are DATA (filled by the seeded sequential generator at
     * seed() time on the CPU) — uploaded, never re-derived on the GPU.
     * @param {ArrayLike<number>} poolA fill.js _gaussians[0] (512)
     * @param {ArrayLike<number>} poolB fill.js _gaussians[1] (512)
     */
    uploadPools(poolA: ArrayLike<number>, poolB: ArrayLike<number>): void;
    /**
     * The ORIGINAL polygon scatter()'s point-in-polygon test runs against
     * (fill.js `_polygon.sides` + `_bbMinX.._bbMaxY`). Uploaded once per
     * createFill().
     * @param {Float32Array} flatVerts xy pairs, user space
     * @param {{minX,minY,maxX,maxY}} bbox
     */
    setPolygon(flatVerts: Float32Array, bbox: {
        minX: any;
        minY: any;
        maxX: any;
        maxY: any;
    }): void;
    /** Ensures the erase circle arena holds at least `slots` vec4f. */
    ensureCircles(slots: any): void;
    /**
     * Per-createFill() scope. saltBase = fillId << 10 (fill.js nextOpSalt).
     * The op counter itself is seeded from inside the compute pass by
     * opInit() so its ordering against the dispatches is structural.
     */
    setFill(fillId: any, opCounter?: number): void;
    /** Records the GPU-resident op-counter reset. */
    opInit(pass: any, fillId: any, opCounter: any): void;
    /** The GPU-resident fill dirty rect (device px). Never read back. */
    readonly rectBuffer: any;
    /**
     * Sets the transform used to project vertex bounds into the shared
     * dirty rect, plus the CPU path's `1 + lineWidth/2` padding rule.
     */
    setRectTransform(m: any, pad: any): void;
    /**
     * Writes the parts of the rect buffer the CPU owns: the retained fill
     * path's own bounds (unioned in by the composite) and the target size.
     * @param {{minX,minY,maxX,maxY}|null} cpuRect device px
     */
    writeRectCpuHalf(cpuRect: {
        minX: any;
        minY: any;
        maxX: any;
        maxY: any;
    } | null, width: any, height: any): void;
    /** Records the dirty-rect reset at the head of a batch. */
    rectInit(pass: any): void;
    /** Reset the uniform ring. Call once per command encoder / batch. */
    beginBatch(): void;
    /** ONE writeBuffer for every uniform slot recorded since beginBatch(). */
    uploadBatch(): void;
    /** Ops recorded in the current batch (test instrumentation). */
    readonly opsRecorded: number;
    /** Allocates a poly buffer (STORAGE + INDIRECT; drawIndirect-ready). */
    createPoly(label?: string): {
        buffer: any;
        capacity: any;
        id: number;
    };
    /** Small handle buffer for an erase draw (header + indirect args only). */
    createEraseHandle(label?: string): {
        buffer: any;
        capacity: number;
        id: number;
    };
    /**
     * Uploads a CPU-side polygon into a poly buffer.
     * @param {{buffer: GPUBuffer}} poly
     * @param {{verts: {x: number, y: number}[]|Float32Array, mods: ArrayLike<number>,
     *          dirs: ArrayLike<boolean|number>, midP?: {x,y}, sizeX?: number,
     *          sizeY?: number}} data
     */
    writePoly(poly: {
        buffer: GPUBuffer;
    }, data: {
        verts: {
            x: number;
            y: number;
        }[] | Float32Array;
        mods: ArrayLike<number>;
        dirs: ArrayLike<boolean | number>;
        midP?: {
            x: any;
            y: any;
        };
        sizeX?: number;
        sizeY?: number;
    }): void;
    /**
     * Records one grow step (fill.js `poly.grow(f)`) on an open compute
     * pass — ONE dispatch of ONE workgroup (see grow.wgsl). src and dst
     * must be distinct poly handles; src is not modified, so DAG patterns
     * (`pol.grow(a)` / `pol.grow(b)` from the same pol) just reuse src.
     * @param {GPUComputePassEncoder} pass
     * @param {{flipDirs?: boolean}} [o] flipDirs applies FillPoly.flipDirs()
     *   to the SOURCE as it is read (the CPU chain always consumes a
     *   flipDirs() result with a grow, so no copy kernel is needed).
     */
    grow(pass: GPUComputePassEncoder, src: any, dst: any, f?: number, o?: {
        flipDirs?: boolean;
    }): void;
    /** Records one FillPoly.scatter(ratio). */
    scatter(pass: any, src: any, dst: any, ratio: any): void;
    /**
     * Records one FillPoly.erase(). Every scalar but the salt is CPU-known;
     * circles land at `outBase` in the circle arena and the instanced
     * drawIndirect args are written into `handle`.
     * @param {object} handle from createEraseHandle()
     * @param {{countFactor,halfSizeX,halfSizeY,minSizeFactor,maxSizeFactor,
     *          midX,midY}} p
     * @param {number} outBase first vec4f slot
     */
    erase(pass: any, handle: object, p: {
        countFactor: any;
        halfSizeX: any;
        halfSizeY: any;
        minSizeFactor: any;
        maxSizeFactor: any;
        midX: any;
        midY: any;
    }, outBase: number): void;
    /**
     * OUT-OF-BAND readback of a poly buffer (oracle / inspection only —
     * never call from a frame path). Needs readback.js.
     */
    readPoly(poly: any, readBuffer: any): Promise<{
        count: number;
        verts: Float32Array<ArrayBuffer>;
        mods: Float32Array<ArrayBuffer>;
        dirs: Uint32Array<ArrayBuffer>;
        midP: {
            x: number;
            y: number;
        };
        sizeX: number;
        sizeY: number;
        indirect: number[];
        borderIndirect: number[];
        bbox: {
            minX: number;
            minY: number;
            maxX: number;
            maxY: number;
        };
    }>;
    /** OUT-OF-BAND: current GPU-resident fill op counter. */
    readOpCounter(readBuffer: any): Promise<number>;
    /** OUT-OF-BAND: erase circles (oracle only). */
    readCircles(readBuffer: any, count: any, base?: number): Promise<Float32Array<any>>;
    /**
     * Oracle-only: dispatches hashSelfTest / intSelfTest into dst and
     * returns the raw result words. n <= capacity.
     */
    selfTest(kind: any, dst: any, readBuffer: any, f?: number): Promise<Uint32Array<any>>;
    destroy(): void;
}>;
/**
 * Synchronous form. The WGSL is a bundled string, so nothing here actually
 * needs to await — and the driver has to be constructible from inside a
 * synchronous draw call so it can be built lazily on the first fill rather
 * than costing every stroke-only sketch its shader compilation at startup.
 * @see createGrowCompute for the parameter contract.
 */
export function createGrowComputeSync(gpu: any, cache: any, opts?: {}): {
    capacity: any;
    /** Byte offset of the fill drawIndirect args inside every poly buffer. */
    indirectByteOffset: number;
    /** Byte offset of the border drawIndirect args. */
    borderIndirectByteOffset: number;
    /** The erase circle arena (vec4f per disc). */
    readonly circleBuffer: any;
    /** Stable handle to the arena; `.buffer` follows reallocation. */
    circleRef: {
        buffer: any;
    };
    /**
     * @param {{seed?: number, bleedStrength?: number,
     *          direction?: string, growCap?: number}} s
     * seed defaults to re-deriving from core/utils (call after brush seed()).
     * growCap defaults to the fill.js formula from bleedStrength.
     */
    setState(s?: {
        seed?: number;
        bleedStrength?: number;
        direction?: string;
        growCap?: number;
    }): void;
    /**
     * Gaussian pools are DATA (filled by the seeded sequential generator at
     * seed() time on the CPU) — uploaded, never re-derived on the GPU.
     * @param {ArrayLike<number>} poolA fill.js _gaussians[0] (512)
     * @param {ArrayLike<number>} poolB fill.js _gaussians[1] (512)
     */
    uploadPools(poolA: ArrayLike<number>, poolB: ArrayLike<number>): void;
    /**
     * The ORIGINAL polygon scatter()'s point-in-polygon test runs against
     * (fill.js `_polygon.sides` + `_bbMinX.._bbMaxY`). Uploaded once per
     * createFill().
     * @param {Float32Array} flatVerts xy pairs, user space
     * @param {{minX,minY,maxX,maxY}} bbox
     */
    setPolygon(flatVerts: Float32Array, bbox: {
        minX: any;
        minY: any;
        maxX: any;
        maxY: any;
    }): void;
    /** Ensures the erase circle arena holds at least `slots` vec4f. */
    ensureCircles(slots: any): void;
    /**
     * Per-createFill() scope. saltBase = fillId << 10 (fill.js nextOpSalt).
     * The op counter itself is seeded from inside the compute pass by
     * opInit() so its ordering against the dispatches is structural.
     */
    setFill(fillId: any, opCounter?: number): void;
    /** Records the GPU-resident op-counter reset. */
    opInit(pass: any, fillId: any, opCounter: any): void;
    /** The GPU-resident fill dirty rect (device px). Never read back. */
    readonly rectBuffer: any;
    /**
     * Sets the transform used to project vertex bounds into the shared
     * dirty rect, plus the CPU path's `1 + lineWidth/2` padding rule.
     */
    setRectTransform(m: any, pad: any): void;
    /**
     * Writes the parts of the rect buffer the CPU owns: the retained fill
     * path's own bounds (unioned in by the composite) and the target size.
     * @param {{minX,minY,maxX,maxY}|null} cpuRect device px
     */
    writeRectCpuHalf(cpuRect: {
        minX: any;
        minY: any;
        maxX: any;
        maxY: any;
    } | null, width: any, height: any): void;
    /** Records the dirty-rect reset at the head of a batch. */
    rectInit(pass: any): void;
    /** Reset the uniform ring. Call once per command encoder / batch. */
    beginBatch(): void;
    /** ONE writeBuffer for every uniform slot recorded since beginBatch(). */
    uploadBatch(): void;
    /** Ops recorded in the current batch (test instrumentation). */
    readonly opsRecorded: number;
    /** Allocates a poly buffer (STORAGE + INDIRECT; drawIndirect-ready). */
    createPoly(label?: string): {
        buffer: any;
        capacity: any;
        id: number;
    };
    /** Small handle buffer for an erase draw (header + indirect args only). */
    createEraseHandle(label?: string): {
        buffer: any;
        capacity: number;
        id: number;
    };
    /**
     * Uploads a CPU-side polygon into a poly buffer.
     * @param {{buffer: GPUBuffer}} poly
     * @param {{verts: {x: number, y: number}[]|Float32Array, mods: ArrayLike<number>,
     *          dirs: ArrayLike<boolean|number>, midP?: {x,y}, sizeX?: number,
     *          sizeY?: number}} data
     */
    writePoly(poly: {
        buffer: GPUBuffer;
    }, data: {
        verts: {
            x: number;
            y: number;
        }[] | Float32Array;
        mods: ArrayLike<number>;
        dirs: ArrayLike<boolean | number>;
        midP?: {
            x: any;
            y: any;
        };
        sizeX?: number;
        sizeY?: number;
    }): void;
    /**
     * Records one grow step (fill.js `poly.grow(f)`) on an open compute
     * pass — ONE dispatch of ONE workgroup (see grow.wgsl). src and dst
     * must be distinct poly handles; src is not modified, so DAG patterns
     * (`pol.grow(a)` / `pol.grow(b)` from the same pol) just reuse src.
     * @param {GPUComputePassEncoder} pass
     * @param {{flipDirs?: boolean}} [o] flipDirs applies FillPoly.flipDirs()
     *   to the SOURCE as it is read (the CPU chain always consumes a
     *   flipDirs() result with a grow, so no copy kernel is needed).
     */
    grow(pass: GPUComputePassEncoder, src: any, dst: any, f?: number, o?: {
        flipDirs?: boolean;
    }): void;
    /** Records one FillPoly.scatter(ratio). */
    scatter(pass: any, src: any, dst: any, ratio: any): void;
    /**
     * Records one FillPoly.erase(). Every scalar but the salt is CPU-known;
     * circles land at `outBase` in the circle arena and the instanced
     * drawIndirect args are written into `handle`.
     * @param {object} handle from createEraseHandle()
     * @param {{countFactor,halfSizeX,halfSizeY,minSizeFactor,maxSizeFactor,
     *          midX,midY}} p
     * @param {number} outBase first vec4f slot
     */
    erase(pass: any, handle: object, p: {
        countFactor: any;
        halfSizeX: any;
        halfSizeY: any;
        minSizeFactor: any;
        maxSizeFactor: any;
        midX: any;
        midY: any;
    }, outBase: number): void;
    /**
     * OUT-OF-BAND readback of a poly buffer (oracle / inspection only —
     * never call from a frame path). Needs readback.js.
     */
    readPoly(poly: any, readBuffer: any): Promise<{
        count: number;
        verts: Float32Array<ArrayBuffer>;
        mods: Float32Array<ArrayBuffer>;
        dirs: Uint32Array<ArrayBuffer>;
        midP: {
            x: number;
            y: number;
        };
        sizeX: number;
        sizeY: number;
        indirect: number[];
        borderIndirect: number[];
        bbox: {
            minX: number;
            minY: number;
            maxX: number;
            maxY: number;
        };
    }>;
    /** OUT-OF-BAND: current GPU-resident fill op counter. */
    readOpCounter(readBuffer: any): Promise<number>;
    /** OUT-OF-BAND: erase circles (oracle only). */
    readCircles(readBuffer: any, count: any, base?: number): Promise<Float32Array<any>>;
    /**
     * Oracle-only: dispatches hashSelfTest / intSelfTest into dst and
     * returns the raw result words. n <= capacity.
     */
    selfTest(kind: any, dst: any, readBuffer: any, f?: number): Promise<Uint32Array<any>>;
    destroy(): void;
};
export const HDR_WORDS: 24;
export const INDIRECT_BYTE_OFFSET: 32;
export const BORDER_INDIRECT_BYTE_OFFSET: 48;
export const BBOX_WORD: 16;
export const VERTS_BYTE_OFFSET: number;
export const POOL_SIZE: 512;
export const GROW_MAX_VERTS: 2024;
/** Words of the shared dirty-rect buffer (see spectral.wgsl vsRect). */
export const RECT_WORDS: 12;
