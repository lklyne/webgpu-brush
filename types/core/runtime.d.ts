/**
 * Registers or updates host-runtime hooks used by core modules.
 *
 * @param {object} hooks
 */
export function setRuntime(hooks: object): void;
export function usesRadians(): boolean;
export function fromDegrees(angle: any): any;
export function createColor(): never;
export function getAffineMatrix(): {
    a: number;
    b: number;
    c: number;
    d: number;
    x: number;
    y: number;
};
export function notifyDraw(): void;
