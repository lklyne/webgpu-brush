/**
 * Updates the shared target state consumed by core modules.
 *
 * @param {object} state
 */
export function setTargetState(state: object): void;
/**
 * Registers or updates host target hooks used by core modules.
 *
 * @param {object} hooks
 */
export function setTargetRuntime(hooks: object): void;
export let Cwidth: any;
export let Cheight: any;
export let Instance: any;
export let Renderer: any;
export let Density: any;
export function load(buffer: boolean, options: any): never;
export function syncDensity(): any;
export function isCanvasReady(): never;
export function instance(inst: any): void;
export function activateInstance(inst: any): void;
export function deactivateInstance(): void;
export function getActiveFramebuffer(): any;
export function isFramebufferTarget(target: any): boolean;
