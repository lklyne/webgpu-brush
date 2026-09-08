/**
 * Represents a polygon with a set of vertices and provides methods for
 * intersection, drawing, filling, and hatching.
 */
export class Polygon {
    /**
     * Constructs the Polygon object from an array of points.
     * @param {Array} pointsArray - An array of points, where each point is an array of two numbers [x, y].
     * @param {boolean} [useRawVertices=false] - If true, uses the raw array as vertices.
     */
    constructor(pointsArray: any[], useRawVertices?: boolean);
    a: any[];
    vertices: any[];
    sides: any[][];
    _intersectionCache: {};
    /**
     * Intersects a given line with the polygon, returning all intersection points.
     * @param {Object} line - The line to intersect with the polygon, having two properties 'point1' and 'point2'.
     * @returns {Array} An array of intersection points (each with 'x' and 'y' properties) or an empty array if no intersections.
     */
    intersect(line: any): any[];
    /**
     * Displays the polygon with optional stroke, hatch, and fill effects.
     */
    show(): void;
}
