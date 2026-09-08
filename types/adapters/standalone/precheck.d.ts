export namespace precheck {
    export function angleMode(mode: any): void;
    export function push(): void;
    export function pop(): void;
    export function pick(name: any): void;
    export function set(name: any): void;
    export function stroke(): void;
    export function noStroke(): void;
    export { requireBrush as line };
    export { requireBrush as flowLine };
    export function beginShape(): void;
    export function vertex(): void;
    export function endShape(): void;
    export function beginStroke(type: any): void;
    export function move(): void;
    export function endStroke(): void;
    export function spline(points: any): void;
    export function field(name: any): void;
    export function noField(): void;
    export function wiggle(): void;
    export function refreshField(): void;
}
declare function requireBrush(): void;
export {};
