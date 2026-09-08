/**
 * Maps any seed value to a non-zero uint32 — bit-identical to utils.js
 * _hashSeed (which is not exported). Needed to hand the GPU the same seed
 * word the library derives from brush.seed(s).
 * @param {number|string} seed
 * @returns {number} uint32
 */
export function hashSeedU32(seed: number | string): number;
/** Combined trig table for upload: cos[0..1439] ++ sin[1440..2879]. */
export function buildTrigTable(): Float32Array<ArrayBuffer>;
/**
 * Internal-degrees direction of a line — utils.js calcAngle for the
 * degrees angle mode (atan2 with y flipped, normalized to [0, 360)).
 */
export function calcAngleDegrees(x1: any, y1: any, x2: any, y2: any): number;
export function f32ToOrd(f: any): number;
/**
 * @param {{seedU32: number, width: number, height: number}} opts
 *   width/height: logical canvas size (Cwidth/Cheight).
 */
export function createDescriptorBuilder({ seedU32, width, height }: {
    seedU32: number;
    width: number;
    height: number;
}): {
    build: (inp: {
        kind: "default" | "marker" | "spray";
        x: number;
        y: number;
        dir: number;
        length: number;
        brush: any;
        strokeWeight: number;
        matrix?: {
            x: number;
            y: number;
        };
        fieldActive?: boolean;
        wiggle?: number;
        strokeId?: number;
    }) => {
        x0: number;
        y0: number;
        dxc: number;
        dyc: number;
        dir: number;
        dirCos: number;
        dirSin: number;
        stepSize: any;
        len: number;
        strokeWeight: number;
        pWeight: any;
        scatter: any;
        sharpness: any;
        grain: any;
        alpha: any;
        wiggle: number;
        mx: number;
        my: number;
        pmin: any;
        pmax: any;
        cp: any;
        ct: any;
        cs: any;
        ck: any;
        aa: number;
        bb: number;
        ns: number;
        nm: number;
        ne: number;
        phase1P: number;
        totalSteps: number;
        salt: number;
        kind: number;
        flags: number;
        maxStamps: number;
    };
    reset: () => void;
    getChain: () => {
        pc: any;
        cached: any;
    };
    setChain: (chain: any) => void;
};
/** Pack built descriptors into the GPU layout (STROKE_WORDS words each). */
export function packDescriptors(descs: any): ArrayBuffer;
/**
 * @param {import('./device.js').GpuContext} gpu
 * @param {{wgsl?: {walk?: string, scan?: string}}} [opts] inline WGSL sources
 *   (skips fetch — for bundled builds).
 */
export function createStrokeWalker(gpu: import("./device.js").GpuContext, opts?: {
    wgsl?: {
        walk?: string;
        scan?: string;
    };
}): {
    ensureReady: () => any;
    setEnvironment: (e: {
        seedU32: number;
        width: number;
        height: number;
        gaussPool: Float32Array;
        field?: {
            data: Float32Array;
            numColumns: number;
            numRows: number;
            resolution: number;
            leftX: number;
            topY: number;
        } | null;
        density?: number;
    }) => void;
    walk: (descs: any[], groups?: Array<{
        start: number;
        end: number;
    }>) => {
        stampsBuffer: GPUBuffer;
        offsetsBuffer: GPUBuffer;
        countsBuffer: GPUBuffer;
        indirectBuffer: GPUBuffer;
        rectsBuffer: GPUBuffer;
        groupCount: number;
        strokeCount: number;
        capacity: number;
        destroy: () => void;
    };
    readBatch: (batch: any) => Promise<{
        offsets: Uint32Array;
        total: number;
        stamps: Float32Array;
    }>;
    destroy: () => void;
};
export function makeHashU32(seedU32: any): (streamId: any, salt: any, index: any) => number;
export const STROKE_WORDS: 36;
export const RECT_WORDS: 64;
export const RECT_BYTES: number;
