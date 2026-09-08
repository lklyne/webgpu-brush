/**
 * Flushes any pending stroke/fill compositing into the active standalone target.
 *
 * Standalone users should call this at the end of a drawing pass or frame.
 */
export function render(): void;
/**
 * Clears the active standalone target.
 *
 * With no arguments, clears to transparent white.
 * With a color, clears to that color at full opacity.
 *
 * @param {...*} args
 */
export function clear(...args: any[]): void;
