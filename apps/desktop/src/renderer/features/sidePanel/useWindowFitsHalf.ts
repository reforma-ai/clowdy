import { useLayoutEffect } from 'react';

import { useRootStore } from '../../stores';
import { HALF_MIN_WINDOW_WIDTH } from './panelWidth';

/**
 * Tells the window state whether the window is wide enough for the side panel with a tree (Files, Docs) beside the chat, and follows the window as it is resized
 * (`UiStore.windowFitsHalf`; `HALF_MIN_WINDOW_WIDTH`). It runs before the first paint, so a narrow window never shows the panel beside the chat for a frame.
 * The shell calls it once.
 */
export function useWindowFitsHalf(): void {
    const root = useRootStore();

    useLayoutEffect(() => {
        if (typeof window.matchMedia !== 'function') return;

        const wide = window.matchMedia(`(min-width: ${ HALF_MIN_WINDOW_WIDTH }px)`);
        const sync = () => root.ui.setWindowFitsHalf(wide.matches);

        sync();
        wide.addEventListener('change', sync);

        return () => wide.removeEventListener('change', sync);
    }, [root]);
}
