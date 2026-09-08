/**
 * Builds one painting's validator table, keyed by public export name. Each
 * entry mirrors one upstream check against `ctx`'s shadow.
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {object}
 */
export function createPrecheck(ctx: import("../../core/context.js").BrushContext): object;
/** The default painting's validators — what the module-level API is wrapped with. */
export const precheck: any;
