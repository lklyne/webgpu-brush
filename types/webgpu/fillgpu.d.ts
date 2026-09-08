/**
 * @param {import('./device.js').GpuContext} gpu
 * @param {ReturnType<import('./pipeline.js').createPipelineCache>} cache
 * @param {ReturnType<import('./fill.js').createFillRenderer>} fillR
 */
export function createGpuFillDriver(gpu: import("./device.js").GpuContext, cache: ReturnType<typeof import("./pipeline.js").createPipelineCache>, fillR: ReturnType<typeof import("./fill.js").createFillRenderer>, opts?: {}): {
    grow: {
        capacity: any;
        indirectByteOffset: number;
        borderIndirectByteOffset: number;
        readonly circleBuffer: any;
        circleRef: {
            buffer: any;
        };
        setState(s?: {
            seed?: number;
            bleedStrength?: number;
            direction?: string;
            growCap?: number;
        }): void;
        uploadPools(poolA: ArrayLike<number>, poolB: ArrayLike<number>): void;
        setPolygon(flatVerts: Float32Array, bbox: {
            minX: any;
            minY: any;
            maxX: any;
            maxY: any;
        }): void;
        ensureCircles(slots: any): void;
        setFill(fillId: any, opCounter?: number): void;
        opInit(pass: any, fillId: any, opCounter: any): void;
        readonly rectBuffer: any;
        setRectTransform(m: any, pad: any): void;
        writeRectCpuHalf(cpuRect: {
            minX: any;
            minY: any;
            maxX: any;
            maxY: any;
        } | null, width: any, height: any): void;
        rectInit(pass: any): void;
        beginBatch(): void;
        uploadBatch(): void;
        readonly opsRecorded: number;
        createPoly(label?: string): {
            buffer: any;
            capacity: any;
            id: number;
        };
        createEraseHandle(label?: string): {
            buffer: any;
            capacity: number;
            id: number;
        };
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
        grow(pass: GPUComputePassEncoder, src: any, dst: any, f?: number, o?: {
            flipDirs?: boolean;
        }): void;
        scatter(pass: any, src: any, dst: any, ratio: any): void;
        erase(pass: any, handle: object, p: {
            countFactor: any;
            halfSizeX: any;
            halfSizeY: any;
            minSizeFactor: any;
            maxSizeFactor: any;
            midX: any;
            midY: any;
        }, outBase: number): void;
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
        readOpCounter(readBuffer: any): Promise<number>;
        readCircles(readBuffer: any, count: any, base?: number): Promise<Float32Array<any>>;
        selfTest(kind: any, dst: any, readBuffer: any, f?: number): Promise<Uint32Array<any>>;
        destroy(): void;
    };
    readonly capacity: any;
    stats: {
        fills: number;
        ops: number;
        polysAllocated: number;
    };
    /** Per-seed(): the gaussian pools are plain data. */
    uploadPools(a: any, b: any): void;
    /** Uploads the pools only when fill.js reports a new seed generation. */
    uploadPoolsIfStale(version: any, a: any, b: any): void;
    /**
     * Opens a fill. Returns the root poly handle.
     * @param {object} o
     * @param {Float32Array} o.rootVerts flat xy, user space
     * @param {ArrayLike<number>} o.rootMods
     * @param {ArrayLike<number>} o.rootDirs
     * @param {{x,y}} o.midP
     * @param {number} o.sizeX
     * @param {number} o.sizeY
     * @param {Float32Array} o.polygonVerts original polygon, flat xy
     * @param {{minX,minY,maxX,maxY}} o.polygonBBox
     * @param {number} o.seed the painting's hash-stream seed word
     * @param {number} o.fillId
     * @param {number} o.opCounter
     * @param {number} o.bleedStrength
     * @param {string} o.direction
     * @param {number} o.growCap
     * @param {{a,b,c,d,e,f}} o.rectMatrix final device px transform
     * @param {number} o.rectPad
     */
    beginFill(o: {
        rootVerts: Float32Array;
        rootMods: ArrayLike<number>;
        rootDirs: ArrayLike<number>;
        midP: {
            x: any;
            y: any;
        };
        sizeX: number;
        sizeY: number;
        polygonVerts: Float32Array;
        polygonBBox: {
            minX: any;
            minY: any;
            maxX: any;
            maxY: any;
        };
        seed: number;
        fillId: number;
        opCounter: number;
        bleedStrength: number;
        direction: string;
        growCap: number;
        rectMatrix: {
            a: any;
            b: any;
            c: any;
            d: any;
            e: any;
            f: any;
        };
        rectPad: number;
    }): {
        buffer: GPUBuffer;
        capacity: number;
        id: number;
    };
    endFill(): void;
    /** Records `src.grow(f)`; returns the destination handle. */
    recordGrow(src: any, f: any, flipDirs: any): {
        buffer: GPUBuffer;
        capacity: number;
        id: number;
    };
    /** Records `src.scatter(ratio)`; returns the destination handle. */
    recordScatter(src: any, ratio: any): {
        buffer: GPUBuffer;
        capacity: number;
        id: number;
    };
    /**
     * Records an erase-circle generation. Returns { handle, base } —
     * the drawIndirect args land in handle at INDIRECT_BYTE_OFFSET.
     * @param {number} maxCircles conservative upper bound (CPU-known: the
     *   count draw is rh(80,110) * countFactor, so 110 * countFactor bounds
     *   it and the arena reservation stays a pure CPU decision)
     */
    recordErase(params: any, maxCircles: number): {
        handle: any;
        base: number;
    };
    /** True when compute work awaits flushCompute(). */
    pending(): boolean;
    /**
     * Encodes every recorded op into ONE compute pass on the caller's
     * encoder, then uploads the uniform arena with a single writeBuffer.
     * Must run before the render pass that consumes the poly buffers.
     */
    flushCompute(encoder: any): void;
    /** Records a layer draw of a GPU-resident polygon. */
    drawLayer(poly: any, matrix: any, fillAlpha: any, lineWidth: any, strokeAlpha: any): void;
    /** Records an erase draw of GPU-generated circles. */
    drawErase(handle: any, base: any, matrix: any, radiusScale: any, alpha: any): void;
    /** CPU-owned half of the dirty-rect buffer (see spectral.wgsl vsRect). */
    writeRectCpuHalf(cpuRect: any, width: any, height: any): void;
    readonly rectBuffer: any;
    destroy(): void;
};
