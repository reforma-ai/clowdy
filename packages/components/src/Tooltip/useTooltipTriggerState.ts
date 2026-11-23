import { useEffect, useMemo, useRef } from 'react';
import { useOverlayTriggerState } from 'react-stately';

import type { TooltipTriggerProps, TooltipTriggerState } from 'react-stately';

/** Minimum cooldown before global warmup resets (matches React Stately). */
const WARMUP_COOLDOWN_MIN = 500;

const tooltips: Record<string, (immediate?: boolean) => void> = {};
let tooltipId = 0;
let globalWarmedUp = false;
let globalWarmUpTimeout: ReturnType<typeof setTimeout> | null = null;
let globalCooldownTimeout: ReturnType<typeof setTimeout> | null = null;

export interface ClowdyTooltipTriggerStateProps extends TooltipTriggerProps {
    /**
     * Spectrum-style global warmup: first tooltip waits `delay`, then adjacent
     * triggers open immediately until cooldown expires. Default false.
     */
    warmUp?: boolean;
}

/**
 * Tooltip trigger state with optional Spectrum warmup.
 *
 * `warmUp={false}` (default): every hover waits the full `delay`.
 * `warmUp={true}`: shared warmup/cooldown like React Stately (toolbars).
 */
export function useTooltipTriggerState(props: ClowdyTooltipTriggerStateProps = {}): TooltipTriggerState {
    const { delay = 500, closeDelay = 150, warmUp = false } = props;
    const { isOpen, open, close } = useOverlayTriggerState(props);
    const id = useMemo(() => `${++tooltipId}`, []);
    const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
    const openTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeCallback = useRef(close);

    const hideTooltip = (immediate?: boolean) => {
        if (openTimeout.current) {
            clearTimeout(openTimeout.current);
            openTimeout.current = null;
        }

        if (immediate || closeDelay <= 0) {
            if (closeTimeout.current) {
                clearTimeout(closeTimeout.current);
                closeTimeout.current = null;
            }

            closeCallback.current();
        } else if (!closeTimeout.current) {
            closeTimeout.current = setTimeout(() => {
                closeTimeout.current = null;
                closeCallback.current();
            }, closeDelay);
        }

        if (!warmUp) {
            return;
        }

        if (globalWarmUpTimeout) {
            clearTimeout(globalWarmUpTimeout);
            globalWarmUpTimeout = null;
        }

        if (globalWarmedUp) {
            if (globalCooldownTimeout) {
                clearTimeout(globalCooldownTimeout);
            }

            globalCooldownTimeout = setTimeout(
                () => {
                    delete tooltips[id];
                    globalCooldownTimeout = null;
                    globalWarmedUp = false;
                },
                Math.max(WARMUP_COOLDOWN_MIN, closeDelay)
            );
        }
    };

    const ensureTooltipEntry = () => {
        tooltips[id] = hideTooltip;
    };

    const closeOpenTooltips = () => {
        for (const hideTooltipId in tooltips) {
            if (hideTooltipId !== id) {
                tooltips[hideTooltipId](true);
                delete tooltips[hideTooltipId];
            }
        }
    };

    const showTooltip = () => {
        if (openTimeout.current) {
            clearTimeout(openTimeout.current);
            openTimeout.current = null;
        }

        if (closeTimeout.current) {
            clearTimeout(closeTimeout.current);
            closeTimeout.current = null;
        }

        closeOpenTooltips();
        ensureTooltipEntry();

        if (warmUp) {
            globalWarmedUp = true;

            if (globalWarmUpTimeout) {
                clearTimeout(globalWarmUpTimeout);
                globalWarmUpTimeout = null;
            }

            if (globalCooldownTimeout) {
                clearTimeout(globalCooldownTimeout);
                globalCooldownTimeout = null;
            }
        }

        open();
    };

    const scheduleShow = () => {
        closeOpenTooltips();
        ensureTooltipEntry();

        if (isOpen) {
            return;
        }

        if (warmUp) {
            if (!globalWarmedUp) {
                if (globalWarmUpTimeout) {
                    clearTimeout(globalWarmUpTimeout);
                }

                globalWarmUpTimeout = setTimeout(() => {
                    globalWarmUpTimeout = null;
                    globalWarmedUp = true;
                    showTooltip();
                }, delay);
            } else {
                showTooltip();
            }

            return;
        }

        if (openTimeout.current) {
            clearTimeout(openTimeout.current);
        }

        if (delay > 0) {
            openTimeout.current = setTimeout(() => {
                openTimeout.current = null;
                showTooltip();
            }, delay);
        } else {
            showTooltip();
        }
    };

    useEffect(() => {
        closeCallback.current = close;
    }, [close]);

    useEffect(() => {
        return () => {
            if (closeTimeout.current) {
                clearTimeout(closeTimeout.current);
            }

            if (openTimeout.current) {
                clearTimeout(openTimeout.current);
            }

            if (tooltips[id]) {
                delete tooltips[id];
            }
        };
    }, [id]);

    return {
        isOpen,
        shouldSkipAnimation: false,
        open: (immediate?: boolean) => {
            if (!immediate && delay > 0 && !closeTimeout.current) {
                scheduleShow();
            } else {
                showTooltip();
            }
        },
        close: hideTooltip,
    };
}
