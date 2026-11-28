import type { NativeScrollRecord } from '../../shared/bridge';

// Only one DOM target can own a physical gesture, even if the pointer moves to another target.
let owner: object | undefined;

/** DOM wheels still choose the target and perform movement. Native records only supply lifecycle. */
export function nativeWheel(target: HTMLElement, end: (release: boolean) => void) {
    const bridge = window.desktop?.nativeScroll;
    const token = {};
    let gesture = 0;
    let barrier = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let outsideWheel: ((event: WheelEvent) => void) | undefined;
    const captureWheel = (event: WheelEvent) => {
        if (owner === token && event.target instanceof Node && !target.contains(event.target)) outsideWheel?.(event);
    };
    const reset = () => {
        clearTimeout(pending);
        pending = undefined;
        gesture = 0;
        if (owner === token) {
            owner = undefined;
            document.removeEventListener('wheel', captureWheel, { capture: true });
        }
    };
    const finish = (release: boolean) => {
        if (!gesture) return;
        reset();
        end(release);
    };
    const receive = (record: NativeScrollRecord) => {
        if (!gesture || record.sequence <= barrier) return;
        barrier = record.sequence;
        if (record.kind === 'cancel' || record.phase & 16) finish(false);
        else if (record.phase & 8) {
            // Allow already queued DOM input a chance to arrive. A wheel observed after the
            // terminal snapshot cancels instead of committing an incomplete, reordered pull.
            clearTimeout(pending);
            pending = setTimeout(
                () =>
                    finish(
                        !document.querySelector(
                            '[role="dialog"], [role="alertdialog"], [role="menu"], [data-modal-overlay], [data-modal-clickout-layer]'
                        )
                    ),
                40
            );
        }
    };
    const unsubscribe = bridge?.available && bridge.snapshot ? bridge.subscribe(receive) : undefined;
    return {
        onOutsideWheel(listener: (event: WheelEvent) => void) {
            outsideWheel = listener;
        },
        wheel(event: WheelEvent): 'phased' | 'fallback' | 'momentum' | 'ignore' {
            if (!bridge?.available || !bridge.snapshot) return 'fallback';
            const snapshot = bridge.snapshot();
            if (!snapshot) return 'fallback';
            const last = snapshot.last;
            if (gesture) {
                if (
                    !snapshot.active &&
                    snapshot.gesture === gesture &&
                    last?.kind === 'scroll' &&
                    last.momentumPhase !== 0
                )
                    return 'momentum';
                if (!snapshot.active || snapshot.gesture !== gesture) {
                    finish(false);
                    return 'ignore';
                }
                barrier = Math.max(barrier, snapshot.sequence);
                return 'phased';
            }
            if (owner) return 'ignore';
            if (snapshot.active && last?.kind === 'scroll' && last.precise) {
                // Do not adopt a gesture that began over another DOM target.
                if (snapshot.origin && document.elementFromPoint) {
                    const origin = document.elementFromPoint(snapshot.origin.x, snapshot.origin.y);
                    if (!origin || !target.contains(origin)) return 'ignore';
                }
                // The latest native event may already belong to another queued gesture.
                if (Math.abs(last.x - event.clientX) > 12 || Math.abs(last.y - event.clientY) > 12) return 'ignore';
                owner = token;
                document.addEventListener('wheel', captureWheel, { capture: true, passive: false });
                gesture = snapshot.gesture;
                barrier = snapshot.sequence;
                return 'phased';
            }
            if (last?.kind === 'cancel' || (last?.kind === 'scroll' && (last.phase !== 0 || last.momentumPhase !== 0)))
                return 'ignore';
            return 'fallback';
        },
        cancel() {
            finish(false);
        },
        dispose() {
            reset();
            unsubscribe?.();
        },
    };
}
