let _rafLoopRunned = false;
let _rafLoopPool: Map<(timestamp: number) => any, { fps: number | (() => number); last: number }>;

const _rafLoopRunner = (timestamp: number) => {
    if (!_rafLoopPool.size) {
        _rafLoopRunned = false;

        return;
    }

    requestAnimationFrame(_rafLoopRunner);

    _rafLoopPool.forEach((meta, cb) => {
        // A new raf could occur in the same millisecond, or earlier than this code execution
        if (meta.last >= timestamp) {
            return;
        }

        const fps = (typeof meta.fps === 'function') ? meta.fps() : meta.fps;

        if (!isFinite(fps) || !fps || (timestamp - meta.last) >= (1000 / fps)) {
            meta.last = timestamp;
            cb(timestamp);
        }
    });
};

/**
 * Create a looped requestAnimationFrame with FPS limit
 * All calls to this method will be called in the same raf (raf-pool)
 *
 * @param cb - Callback to be called
 * @param fps - FPS limit, number or function
 *
 * @return disposer - Function to cancel the loop
 */
export function requestAnimationFrameLoop(cb: (timestamp: number) => any, fps: number | (() => number) = 0): (() => void) {
    if (!_rafLoopPool) {
        _rafLoopPool = new Map();
    }

    // Add current callback to the set
    _rafLoopPool.set(cb, { last: 0, fps });

    // Start only once
    if (!_rafLoopRunned) {
        requestAnimationFrame(_rafLoopRunner);
    }

    return () => {
        _rafLoopPool.delete(cb);
    };
}
