import { clamp } from '@clowdy/lib';

import type { ModalInstance } from './typings';

const MOVEMENT_THRESHOLD = 1;
const RESIZE_HANDLE_SELECTOR = '[data-modal-resize-handle]';
const RESIZE_DEFAULT_MIN_WIDTH = 200;
const RESIZE_DEFAULT_MIN_HEIGHT = 120;
const DRAG_EXCLUDE_SELECTORS =
    'input, textarea, select, button, a, [contenteditable="true"], [data-modal-drag-exclude], [data-modal-close], [type="button"], [role="button"]';

/**
 * Handles draggable and resizable functionality for modal windows
 */
export default class ModalInteractions {
    #modal: ModalInstance;
    isDragging = false;
    isResizing = false;
    isMaximized = false;
    /** True after the user manually drags the window away from its computed position. */
    hasUserMoved = false;
    #initialResizeCoords!: { clientX: number; clientY: number };
    #initialModalSize!: { width: number; height: number };
    #initialModalDimensions: { width: number; height: number } | null = null;
    #resizableDimensions: { width: number; height: number } | null = null;
    #dragAbortController: AbortController | null = null;
    #resizeAbortController: AbortController | null = null;

    constructor(modal: ModalInstance) {
        this.#modal = modal;
    }

    /**
     * Initialize draggable handlers
     */
    initDraggable() {
        const options = this.#modal.currentOptions;

        if (!options.handle) {
            return;
        }

        const overlayEl = this.#getOverlayElement();

        if (!overlayEl) {
            return;
        }

        overlayEl.addEventListener('pointerdown', e => {
            const target = e.target as HTMLElement;
            const handleElement =
                options.handle === true
                    ? target.closest('[data-modal-window]')
                    : target.closest(options.handle as string);

            if (!handleElement) {
                return;
            }

            if (target.closest(DRAG_EXCLUDE_SELECTORS)) {
                return;
            }

            if (this.isResizing) {
                return;
            }

            blurActiveElementInside(overlayEl, e.target);
            this.#modal.focus();

            e.preventDefault();
            e.stopPropagation();

            this.#handleDragStart(e, handleElement);
        });
    }

    /**
     * Initialize resize handlers
     */
    initResizable() {
        const overlayEl = this.#getOverlayElement();

        if (!overlayEl) {
            return;
        }

        overlayEl.addEventListener('dblclick', e => {
            const target = e.target as HTMLElement;

            if (!target.closest(RESIZE_HANDLE_SELECTOR)) {
                return;
            }

            const options = this.#modal.currentOptions;

            if (!options.resizable || this.#modal.options.type === 'overlay') {
                return;
            }

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            this.#handleDoubleClick();
        });

        overlayEl.addEventListener('pointerdown', e => {
            const target = e.target as HTMLElement;
            const resizeHandle = target.closest(RESIZE_HANDLE_SELECTOR);

            if (!resizeHandle) {
                return;
            }

            const options = this.#modal.currentOptions;

            if (!options.resizable || this.#modal.options.type === 'overlay') {
                return;
            }

            // Read direction from data-resize attribute, fallback to option's direction
            const dataResize = resizeHandle.getAttribute('data-resize') as 'x' | 'y' | 'both' | null;
            const direction = dataResize || options.resizable.direction || 'both';

            blurActiveElementInside(overlayEl, e.target);
            this.#handleResizeStart(e, direction);
        });
    }

    /**
     * Maximize modal to available space (respecting constraints)
     * Public API for components to programmatically maximize the modal
     */
    maximize() {
        const modalEl = this.#getWindowElement();
        const options = this.#modal.currentOptions;
        const resizableConfig = options.resizable;

        if (!resizableConfig) {
            return;
        }

        if (!this.#initialModalDimensions) {
            this.#initialModalDimensions = {
                width: modalEl.offsetWidth,
                height: modalEl.offsetHeight,
            };
        }

        const viewportMax = this.#calculateMaxResizeDimensions();

        let maxWidth = viewportMax.maxWidth;
        let maxHeight = viewportMax.maxHeight;

        if (resizableConfig.maxWidth != null) {
            maxWidth = Math.min(maxWidth, resizableConfig.maxWidth);
        }
        if (resizableConfig.minWidth != null) {
            maxWidth = Math.max(maxWidth, resizableConfig.minWidth);
        }

        if (resizableConfig.maxHeight != null) {
            maxHeight = Math.min(maxHeight, resizableConfig.maxHeight);
        }
        if (resizableConfig.minHeight != null) {
            maxHeight = Math.max(maxHeight, resizableConfig.minHeight);
        }

        this.#modal.updateStyles(
            {
                width: maxWidth,
                height: maxHeight,
            },
            true
        );

        this.#resizableDimensions = {
            width: maxWidth,
            height: maxHeight,
        };

        this.isMaximized = true;
    }

    /**
     * Restore modal to initial size (before any resizes)
     * Public API for components to programmatically restore the modal
     */
    restore() {
        if (!this.#initialModalDimensions) {
            return;
        }

        const initialWidth = this.#initialModalDimensions.width;
        const initialHeight = this.#initialModalDimensions.height;

        this.#resizableDimensions = {
            ...this.#initialModalDimensions,
        };

        const modalEl = this.#getWindowElement();

        modalEl.style.width = `${initialWidth}px`;
        modalEl.style.height = `${initialHeight}px`;

        this.#modal.updateStyles(
            {
                width: initialWidth,
                height: initialHeight,
            },
            true
        );

        this.isMaximized = false;
    }

    /**
     * Restore dimensions for a specific tab
     * - If tab is resizable: use shared resizable dimensions, clamped to tab's min/max
     * - If tab is NOT resizable: use tab's original options
     */
    restoreDimensions() {
        const options = this.#modal.currentOptions;
        const resizableConfig = options.resizable;

        if (!resizableConfig) {
            this.#modal.updateStyles({
                width: options.width ?? '',
                height: options.height ?? '',
            });
            this.isMaximized = false;

            return;
        }

        const savedDimensions = this.#resizableDimensions || {
            width: options.width ?? '',
            height: options.height ?? '',
        };

        const direction = resizableConfig.direction || 'both';
        const clamped = this.#clampDimensions(
            savedDimensions.width,
            savedDimensions.height,
            resizableConfig,
            direction
        );

        this.#modal.updateStyles(
            {
                width: clamped.width,
                height: clamped.height,
            },
            true
        );
    }

    /**
     * Handle drag start event
     */
    #handleDragStart(e: PointerEvent, handleElement: Element) {
        if (this.#dragAbortController) {
            this.#dragAbortController.abort();
        }

        this.#dragAbortController = new AbortController();
        const signal = this.#dragAbortController.signal;
        const options = this.#modal.currentOptions;
        const { clientX, clientY, pointerId } = e;

        // Find all modals to drag (drag the modal from which we were called along with the current one)
        const targets: { modal: ModalInstance; top: number; left: number }[] = [];

        let modal: ModalInstance = this.#modal;

        while (modal) {
            // Only draggable modals
            if (modal.options.handle) {
                const position = modal.styles;

                targets.push({
                    modal,
                    top: position.top,
                    left: position.left,
                });
            }

            modal = modal.options.fromModal!;
        }

        targets.forEach(({ modal }) => {
            const interactions = modal.interactions;

            if (interactions) {
                interactions.isDragging = true;
            }
        });

        // Activate overlay so events are not lost in iframes in the background
        this.#activateOverlay('move');
        const handleEl = handleElement as HTMLElement;

        handleEl.setAttribute('handle', 'true');

        if (handleEl.setPointerCapture) {
            handleEl.setPointerCapture(pointerId);
        }

        const handleMove = (moveEvent: PointerEvent) => {
            if (signal.aborted) {
                return;
            }

            moveEvent.preventDefault();
            moveEvent.stopPropagation();

            const newMoveX = options.moveAxis !== 'y' ? Math.round(moveEvent.clientX - clientX) : 0;
            const newMoveY = options.moveAxis !== 'x' ? Math.round(moveEvent.clientY - clientY) : 0;

            if (Math.abs(newMoveX) > MOVEMENT_THRESHOLD || Math.abs(newMoveY) > MOVEMENT_THRESHOLD) {
                targets.forEach(({ modal }) => {
                    modal.interactions.hasUserMoved = true;
                });
            }

            targets.forEach(({ modal, top, left }) => {
                const position = {
                    position: 'absolute',
                    top: top + newMoveY,
                    left: left + newMoveX,
                };

                modal.updateStyles(position, options.limit?.overflow);
            });
        };

        const handleEnd = (endEvent: PointerEvent) => {
            if (signal.aborted) {
                return;
            }

            endEvent.preventDefault();
            endEvent.stopPropagation();

            if (this.#dragAbortController) {
                this.#dragAbortController.abort();
            }
        };

        document.addEventListener('pointermove', handleMove, { signal });
        document.addEventListener('pointerup', handleEnd, { once: true, signal });

        signal.addEventListener('abort', () => {
            if (handleEl.releasePointerCapture) {
                handleEl.releasePointerCapture(pointerId);
            }

            this.#deactivateOverlay('move');

            handleEl.removeAttribute('handle');

            targets.forEach(({ modal }) => {
                const interactions = modal.interactions;

                if (interactions) {
                    interactions.isDragging = false;
                }
            });
        });
    }

    // ============================================================================
    // Resize Handlers
    // ============================================================================

    /**
     * Handle resize start event
     */
    #handleResizeStart(e: PointerEvent, direction: 'x' | 'y' | 'both') {
        if (this.#resizeAbortController) {
            this.#resizeAbortController.abort();
        }

        this.#resizeAbortController = new AbortController();
        const signal = this.#resizeAbortController.signal;
        const options = this.#modal.currentOptions;
        const resizableConfig = options.resizable;

        if (this.isDragging || this.isResizing || !resizableConfig) {
            return;
        }

        this.#modal.focus();

        e.preventDefault();
        e.stopPropagation();

        const { clientX, clientY } = e;
        const modalEl = this.#getWindowElement();

        this.#initialModalSize = {
            width: modalEl.offsetWidth,
            height: modalEl.offsetHeight,
        };

        if (!this.#initialModalDimensions) {
            this.#initialModalDimensions = {
                width: modalEl.offsetWidth,
                height: modalEl.offsetHeight,
            };
        }

        this.#initialResizeCoords = { clientX, clientY };
        this.isResizing = true;

        this.#activateOverlay('resize');

        const resizeHandle = e.target as HTMLElement;
        const pointerId = e.pointerId;

        if (resizeHandle.setPointerCapture) {
            resizeHandle.setPointerCapture(pointerId);
        }

        let resized = false;

        const handleMove = (moveEvent: PointerEvent) => {
            if (signal.aborted) {
                return;
            }

            moveEvent.preventDefault();
            moveEvent.stopPropagation();

            const deltaX = moveEvent.clientX - this.#initialResizeCoords.clientX;
            const deltaY = moveEvent.clientY - this.#initialResizeCoords.clientY;

            const allowedDeltaX = direction === 'x' || direction === 'both' ? deltaX : 0;
            const allowedDeltaY = direction === 'y' || direction === 'both' ? deltaY : 0;

            if (Math.abs(allowedDeltaX) >= MOVEMENT_THRESHOLD || Math.abs(allowedDeltaY) >= MOVEMENT_THRESHOLD) {
                resized = true;
            }

            const newWidth = this.#initialModalSize.width + allowedDeltaX;
            const newHeight = this.#initialModalSize.height + allowedDeltaY;

            const clamped = this.#clampDimensions(newWidth, newHeight, resizableConfig, direction);

            this.#modal.updateStyles(
                {
                    width: clamped.width,
                    height: clamped.height,
                },
                true
            );
        };

        const handleEnd = (endEvent: PointerEvent) => {
            if (signal.aborted) {
                return;
            }

            endEvent.preventDefault();
            endEvent.stopPropagation();

            const modalEl = this.#getWindowElement();

            this.#modal.updateBounds();

            this.#resizableDimensions = {
                width: modalEl.offsetWidth,
                height: modalEl.offsetHeight,
            };

            if (resized) {
                this.isMaximized = false;
                this.#initialModalDimensions = {
                    ...this.#resizableDimensions,
                };
            }

            if (this.#resizeAbortController) {
                this.#resizeAbortController.abort();
            }
        };

        document.addEventListener('pointermove', handleMove, { signal });
        document.addEventListener('pointerup', handleEnd, { once: true, signal });

        signal.addEventListener('abort', () => {
            if (resizeHandle.releasePointerCapture) {
                resizeHandle.releasePointerCapture(pointerId);
            }

            this.#deactivateOverlay('resize');

            this.isResizing = false;
        });
    }

    /**
     * Handle double-click on resize handle for maximize/restore toggle
     */
    #handleDoubleClick() {
        const modalEl = this.#getWindowElement();

        if (!this.#initialModalDimensions) {
            this.#initialModalDimensions = {
                width: modalEl.offsetWidth,
                height: modalEl.offsetHeight,
            };
        }

        if (this.isMaximized) {
            this.restore();
        } else {
            this.maximize();
        }
    }

    /**
     * Calculate maximum allowed resize dimensions based on viewport bounds
     */
    #calculateMaxResizeDimensions(): { maxWidth: number; maxHeight: number } {
        const options = this.#modal.currentOptions;
        const bounds = this.#modal.bounds;

        // if (!bounds) {
        //     this.#modal.updateBounds();
        //     bounds = this.#modal.bounds;
        // }

        const position = this.#modal.styles;
        const modalLeft = position.left || 0;
        const modalTop = position.top || 0;
        const overlayWidth = bounds.overlayWidth;
        const overlayHeight = bounds.overlayHeight;

        const maxWidth = overlayWidth - modalLeft - (options.limit?.right ?? 0);
        const maxHeight = overlayHeight - modalTop - (options.limit?.bottom ?? 0);

        return {
            maxWidth: Math.max(0, maxWidth),
            maxHeight: Math.max(0, maxHeight),
        };
    }

    /**
     * Clamp dimensions to constraints (min/max from config and viewport bounds)
     */
    #clampDimensions(
        width: number | string,
        height: number | string,
        resizableConfig: { minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number },
        direction: 'x' | 'y' | 'both' = 'both'
    ): { width: number | string; height: number | string } {
        const viewportMax = this.#calculateMaxResizeDimensions();

        let clampedWidth = width;
        let clampedHeight = height;

        if ((direction === 'x' || direction === 'both') && typeof clampedWidth === 'number') {
            const minW = resizableConfig.minWidth ?? RESIZE_DEFAULT_MIN_WIDTH;
            const maxW = Math.min(resizableConfig.maxWidth ?? Infinity, viewportMax.maxWidth);

            clampedWidth = clamp(minW, clampedWidth, maxW);
        }

        if ((direction === 'y' || direction === 'both') && typeof clampedHeight === 'number') {
            const minH = resizableConfig.minHeight ?? RESIZE_DEFAULT_MIN_HEIGHT;
            const maxH = Math.min(resizableConfig.maxHeight ?? Infinity, viewportMax.maxHeight);

            clampedHeight = clamp(minH, clampedHeight, maxH);
        }

        return {
            width: clampedWidth,
            height: clampedHeight,
        };
    }

    #activateOverlay(type?: 'move' | 'resize') {
        const overlayEl = this.#getOverlayElement();
        const modalEl = this.#getWindowElement();

        overlayEl.classList.add('on');

        if (type) {
            modalEl.setAttribute(`data-modal-in-${type}`, '');
        }
    }

    #deactivateOverlay(type?: 'move' | 'resize') {
        const overlayEl = this.#getOverlayElement();
        const modalEl = this.#getWindowElement();

        overlayEl.classList.remove('on');

        if (type) {
            modalEl.removeAttribute(`data-modal-in-${type}`);
        }
    }

    #getWindowElement(): HTMLElement {
        return this.#modal.windowEl!;
    }

    #getOverlayElement(): HTMLElement {
        return this.#modal.overlay;
    }
}

function blurActiveElementInside(root: Element, target: EventTarget | null): void {
    const activeElement = root.ownerDocument.activeElement;

    if (!(activeElement instanceof HTMLElement)) {
        return;
    }

    if (activeElement === root || !root.contains(activeElement)) {
        return;
    }

    if (target instanceof Node && activeElement.contains(target)) {
        return;
    }

    activeElement.blur();
}
