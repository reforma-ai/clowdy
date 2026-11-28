/** Movement (px) before a gesture picks its axis. */
export const SWIPE_SLOP = 6;

/** A gesture goes sideways only when its first movement is this much more horizontal than vertical. */
const AXIS_RATIO = 1.2;

/** The window (ms) the release velocity is measured over. A finger that stopped before lifting has no velocity. */
const VELOCITY_WINDOW = 100;

/** Share of the width a slow pull has to cover to switch. */
export const SWIPE_DISTANCE = 0.25;

/** Release speed (px/ms) that switches on its own, a flick. */
export const SWIPE_FLICK = 0.3;

/** A flick still has to move this far (px), so a twitch does not switch. */
const FLICK_MIN = 12;

export type SwipeAxis = 'pending' | 'horizontal' | 'vertical';

/**
 * One physical gesture: picks its axis once, then follows only the horizontal movement, so a pull that drifts up or down
 * keeps going. `x` is positive when the content follows the fingers to the right.
 */
export class SwipeTracker {
    axis: SwipeAxis = 'pending';
    x: number;
    private totalX = 0;
    private totalY = 0;
    private samples: { t: number; x: number }[] = [];

    constructor(
        base = 0,
        private readonly slop = SWIPE_SLOP
    ) {
        this.x = base;
    }

    move(dx: number, dy: number, t: number): SwipeAxis {
        if (this.axis === 'vertical') return this.axis;
        this.totalX += dx;
        this.totalY += dy;
        if (this.axis === 'pending') {
            if (Math.hypot(this.totalX, this.totalY) < this.slop) return this.axis;
            this.axis = Math.abs(this.totalX) > Math.abs(this.totalY) * AXIS_RATIO ? 'horizontal' : 'vertical';
            if (this.axis === 'vertical') return this.axis;
            // The movement spent on picking the axis is part of the pull.
            this.x += this.totalX;
        } else this.x += dx;
        this.samples.push({ t, x: this.x });
        while (this.samples.length > 2 && t - this.samples[0].t > VELOCITY_WINDOW) this.samples.shift();
        return this.axis;
    }

    /** Moves the whole pull, for a gesture that continues from where an animation left the content. */
    shift(by: number): void {
        this.x += by;
        for (const sample of this.samples) sample.x += by;
    }

    /** Horizontal speed (px/ms) over the last moments before `t`. */
    velocity(t: number): number {
        const recent = this.samples.filter(sample => t - sample.t <= VELOCITY_WINDOW);
        if (recent.length < 2) return 0;
        const first = recent[0];
        const last = recent[recent.length - 1];
        // A release long after the last movement means the fingers stopped first.
        if (t - last.t > VELOCITY_WINDOW / 2) return 0;
        const span = Math.max(last.t - first.t, 8);
        return (last.x - first.x) / span;
    }
}

/** Which way a released pull goes: -1 or 1 toward a neighbor, 0 back into place. */
export function swipeDecision(x: number, velocity: number, width: number): -1 | 0 | 1 {
    const direction = Math.sign(x) as -1 | 0 | 1;
    if (!direction) return 0;
    // A flick back toward the start cancels a pull that was already far enough.
    if (Math.sign(velocity) === -direction && Math.abs(velocity) >= SWIPE_FLICK) return 0;
    if (Math.abs(x) >= width * SWIPE_DISTANCE) return direction;
    if (Math.abs(velocity) >= SWIPE_FLICK && Math.abs(x) >= FLICK_MIN) return direction;
    return 0;
}
