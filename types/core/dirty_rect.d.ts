export function expandDirtyRect(rect: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null, padding?: number): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null;
export function normalizeDirtyRect(rect: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null, width: number, height: number): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null;
export function unionDirtyRect(a: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null, b: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null;
export function getFullDirtyRect(width: number, height: number): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
};
