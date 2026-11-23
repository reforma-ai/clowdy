/**
 * Checks if a point is inside a rectangle
 *
 * @param x - X coordinate
 * @param y - Y coordinate
 * @param rect - Rectangle
 */
export function isPointInRect(
    x: number,
    y: number,
    rect: { left: number; right: number; top: number; bottom: number }
): boolean {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
