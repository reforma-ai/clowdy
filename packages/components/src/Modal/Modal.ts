/**
 * Modal windows
 *
 *
 * Features:
    - Background overlay
    - Display next to element
    - Tabs
    - Window dragging
    - Multiple modals can be shown simultaneously
    - Automatic positioning

 * Usage:
    const modal = Modal.create({
        type: 'window', // window type: small or fullscreen
        component: 'name', // component
        props: {}, // component props,
        ...Opts
    });
 */

import { clamp, getRandomId } from '@clowdy/lib';
import { makeObservable } from '@clowdy/lib/observers';
import { action, computed, observable, observableRef, runInAction } from 'mobx';
import { animate } from 'motion';
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { disableFocusByTab, distanceBetween, enableFocusByTab, evaluateValue } from './helpers';
import ModalInteractions from './ModalInteractions';
import modalStyles from './styles/Modal.module.css';
import { ModalRoot } from './views/ModalRoot';

import type { ModalOptions, ModalPositionAxis, ModalResponsiveMode } from './typings';

type Writeable<T> = { -readonly [P in keyof T]: T[P] };
interface CloseOptions {
    restoreFocus?: boolean;
}

// Constants
const CLOSE_BUTTON_DISTANCE_THRESHOLD = 35;
const CLICKOUT_CLOSE_DELAY = 100;
const CLICKOUT_BLOCKING_LAYER_SELECTOR = '[data-modal-clickout-layer]';
/** What Tab can reach inside a window. */
const TABBABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]',
]
    .map(selector => `${selector}:not([tabindex^="-"])`)
    .join(', ');
const MODAL_OPEN_DURATION_S = 0.2;
const MODAL_CLOSE_DURATION_S = 0.15;

let popstated = false;

class Modal<Opts extends ModalOptions = ModalOptions> {
    // Static properties
    static events = makeObservable({});
    static list: Set<Modal> = new Set<Modal>();

    static get opened() {
        return Array.from(this.list);
    }

    static get visible() {
        return this.opened.filter(m => !m.hidden && m.type !== 'sidebar');
    }

    /** Top visible modal, excluding `child`. Used to nest window-type dialogs. */
    static parentOf(child: Modal): Modal | undefined {
        const visible = this.visible.filter(m => m !== child);

        return visible.at(-1);
    }

    /** The focused element, or null when nothing is (`body` has focus). */
    private static focusedElement(): HTMLElement | null {
        const { activeElement } = document;

        return activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : null;
    }

    static create(opts: Partial<ModalOptions> = {}): Modal {
        if (!popstated) {
            popstated = true;

            // Modal was open, but we navigated away - close it
            window.addEventListener('popstate', (e: any) => {
                if (e.direction === 'backward' && e.oldState?.modalId) {
                    const modal = Array.from(this.list).find(m => e.oldState.modalId === m.id);

                    if (modal) {
                        void modal.close(false);
                    }
                }
            });
        }

        // Check for duplicates before creating the actual instance
        const modals: Array<Modal> = Array.from(this.list);

        const name = opts.name || opts.id;
        const createOptions: Partial<ModalOptions> = { ...opts, name };
        const duplicate = opts.duplicate === true;
        const reuseExisting = opts.reuseExisting ?? !duplicate;

        const sameIdModal = opts.id ? modals.find(m => m.id === opts.id) : undefined;
        const sameNameModal = name ? modals.find(m => m.name === name) : undefined;

        if (sameIdModal) {
            if (sameIdModal.canReuseWith(createOptions, reuseExisting)) {
                sameIdModal.reuse(createOptions);
            } else {
                sameIdModal.show();
            }

            return sameIdModal;
        }

        if (sameNameModal) {
            if (sameNameModal.canReuseWith(createOptions, reuseExisting)) {
                sameNameModal.reuse(createOptions);

                return sameNameModal;
            }

            if (opts.hideOnClose || !duplicate) {
                sameNameModal.show();

                return sameNameModal;
            }
        }

        // Create modal instance only if unique
        return new this(createOptions);
    }

    // Instance properties
    @observableRef accessor options!: Opts;
    public name: string;
    public id: string;

    public type = 'window';

    @observable accessor hidden = false;
    @observable accessor disabled = false;

    public isSaved = true;

    @observable accessor loading = false;
    @observable accessor activeTab: string | null = null;
    @observableRef accessor tabOptions: Partial<Opts> = {};
    @observable accessor responsiveMode: ModalResponsiveMode | null = null;
    @observable accessor contentRevision = 0;
    /** The id of the element that names the dialog (its title), set by `useModalTitleId`. */
    @observable accessor labelledBy: string | null = null;
    /** While false, Escape, an outside click and the close button leave the modal open (an action in it is running). */
    @observable accessor dismissable = true;

    @computed get currentOptions(): Opts {
        const tabOptions = this.tabOptions;
        const responsiveMode = this.responsiveMode;
        const tabOptionsWithAdaptive = tabOptions as Partial<Opts> & {
            adaptive?: Partial<Record<ModalResponsiveMode, Partial<Opts>>>;
        };
        const adaptiveOptions = tabOptionsWithAdaptive.adaptive
            ? tabOptionsWithAdaptive.adaptive[responsiveMode ?? 'all'] || tabOptionsWithAdaptive.adaptive.all || {}
            : {};

        return {
            ...this.options,
            ...tabOptions,
            ...adaptiveOptions,
            props: {
                ...this.options.props,
                ...tabOptions.props,
                ...(adaptiveOptions as any).props,
            },
        };
    }

    /**
     * Get default tab ID - returns activeTab from signal/options or first tab ID
     */
    get defaultTabId(): string | null {
        const activeTab = this.activeTab || this.options.activeTab;
        const tabs = this.options.tabs || [];
        const hasTabs = tabs.length > 0;

        // Default id not provided or not found in tabs list - return first tab id
        if (hasTabs && (activeTab == null || !tabs.find(tab => tab.id === activeTab))) {
            return tabs[0]?.id || null;
        }

        return activeTab || null;
    }

    windowEl: HTMLElement | null = null;

    public overlay!: HTMLElement;

    styles!: {
        top: number;
        left: number;
        position: string | null;
        height: number | string;
        width: number | string;
        maxHeight: number | string | null;
        maxWidth: number | string | null;
    };

    bounds!: {
        windowWidth: number;
        windowHeight: number;
        overlayWidth: number;
        overlayHeight: number;

        limits: {
            minLeft: number;
            maxLeft: number;
            minTop: number;
            maxTop: number;
            overflowMinLeft: number;
            overflowMaxLeft: number;
            overflowMinTop: number;
            overflowMaxTop: number;
        };
    };

    isDragging = false;

    #initialCoords: { pageX: number; pageY: number } | null = null;

    #scrollableEl?: HTMLElement[];
    #clickOutInclude: (Document | Element)[];
    #eventsAbortController: AbortController;
    /** What had focus when the modal was created, so closing it hands focus back there. */
    #prevActiveElement: HTMLElement | null = null;
    #scrollPositions: WeakMap<HTMLElement, { top: number; left: number }>;
    #targetWatchInterval: number | null = null;

    #resizeObserver!: ResizeObserver;
    #disposers: Array<() => void> = [];
    interactions: ModalInteractions;

    /**
     * Set tab options based on active tab ID
     * Internal method - use selectTab() for public API
     */
    @action
    private setTabOptions(activeTab: string | null = this.defaultTabId) {
        const tabs = this.options.tabs ?? [];

        // No tabs, simple case
        if (!tabs.length) {
            this.activeTab = null;
            this.tabOptions = { ...this.options };
        }
        // Merge all tab options + dynamic options + global window options
        else {
            const activeTabOptions = tabs.find(tab => tab.id === activeTab) || ({} as Partial<Opts>);
            const activeTabDerivedOptions = activeTabOptions?.getOptions?.(this) || {};

            this.activeTab = activeTab;
            this.tabOptions = this.normalizeOptions({
                ...this.options,
                ...activeTabOptions,
                ...activeTabDerivedOptions,
            });
        }
    }

    /**
     * Normalize options - builds full Opts from partial options
     * Override in extended classes (e.g., EditorModal) to add custom defaults
     */
    protected normalizeOptions(opts: Partial<Opts>): Opts {
        const type = opts.type || 'window';

        const isOverlayStyle = type === 'overlay';
        const isWindowStyle = type === 'window';

        const target = opts.target ?? opts.fromModal?.windowEl;

        const options: Partial<Opts> = {
            type,
            handle: isOverlayStyle ? undefined : '[data-modal-title]',

            animate: true,
            duplicate: false,
            reuseExisting: true,
            loading: false,

            fromModal: null,
            position: ['center', 'center'],
            positionFrom: target ? 'target' : 'screen',
            closeOnTargetLost: !!target && type === 'window',
            target,

            component: null,
            props: null,

            class: [],
            overlayClass: [],
            theme: opts.fromModal?.currentOptions.theme || 'light',
            tabs: [],
            modalActions: [],

            title: null,
            closeButton: !isOverlayStyle || !!opts.title,

            width: null,
            minWidth: null,
            height: null,
            padding: null,

            scrollable: true,

            overlay: false,
            shadow: !!opts.overlay, // Enable shadow if overlay is active

            clickOut: isWindowStyle,
            clickOutExclude: opts.clickOutExclude || [],
            clickOutInclude: opts.clickOutInclude || [document],
            closeOnEscape: true,
            hideOnClose: false,
            reactHost: false,
            initialResponsiveMode: 'all',
            responsiveModes: {
                all: {
                    icon: 'all.svg',
                    iconSize: 16,
                    tip: 'All',
                },
                mobile: {
                    icon: 'mobile.svg',
                    iconSize: 16,
                    tip: 'Mobile',
                },
                tablet: {
                    icon: 'tablet.svg',
                    iconSize: 16,
                    tip: 'Tablet',
                },
                desktop: {
                    icon: 'desktop.svg',
                    iconSize: 16,
                    tip: 'Desktop',
                },
            },

            // Callbacks
            onInit() {},
            onOpen() {},
            onOpened() {},
            onCancel() {},
            onClose() {},
            onBeforeReuse() {},
            onShow() {},
            onHide() {},

            ...opts,

            limit: {
                overflow: true,
                top: 15,
                left: 15,
                right: 15,
                bottom: 15,
                ...(opts.limit || {}),
            },
        };

        if (typeof options.class === 'string') {
            options.class = [options.class];
        }

        if (typeof options.overlayClass === 'string') {
            options.overlayClass = [options.overlayClass];
        }

        if (options.scrollable === true) {
            options.scrollable = 'window';
        }

        if (options.scrollable === false) {
            options.scrollable = 'hidden';
        }

        if (options.scrollable === 'overlay' && options.type === 'window') {
            options.handle = false;
        }

        if (typeof options.padding === 'number') {
            options.padding = `${options.padding}px`;
        }

        options.duplicate = options.duplicate === true;

        // Dont allow duplicate if hideOnClose is true
        if (options.hideOnClose) {
            options.duplicate = false;
        }

        options.reuseExisting = opts.reuseExisting ?? (!options.duplicate && !options.hideOnClose);

        if (options.fromModal && options.type !== 'overlay' && opts.overlay !== true) {
            options.shadow = false;
            options.overlay = false;
        } else if (options.shadow) {
            options.overlay = true;
        }

        options.tabs = (options.tabs ?? []).filter(tab => tab && !tab.hide);

        // Find adaptive modes and remove invalid ones
        options.tabs?.forEach((tab, index) => {
            if (!tab.id) {
                tab.id = `tab-${index}`;
            }

            const adaptive = tab.adaptive;

            if (adaptive) {
                Object.entries(adaptive).forEach(([mode, data]: [string, any]) => {
                    if (!data) {
                        delete adaptive[mode];
                    }
                });
            }
        });

        return options as unknown as Opts;
    }

    constructor(opts: Partial<Opts>) {
        // Add in list
        Modal.list.add(this);

        // A child that autofocuses itself gets there before `focus()` runs, so the element to return to is read here, before anything moves focus.
        this.#prevActiveElement = Modal.focusedElement();

        // Extend options by getOptions function
        if (typeof opts.getOptions === 'function') {
            opts = {
                ...opts,
                ...opts.getOptions(this),
            };
        }

        if (opts.fromModal === undefined && (opts.type ?? 'window') !== 'overlay' && opts.overlay !== true) {
            const parent = Modal.parentOf(this);
            // Anchored outside the top dialog, it was opened from elsewhere and is not its child.
            const fromParent = !opts.target || Boolean(parent?.windowEl?.contains(opts.target));

            if (parent && fromParent) {
                opts = { ...opts, fromModal: parent };
            }
        }

        // Normalize options
        const options = this.normalizeOptions(opts);

        this.options = options;

        this.id = options.id || `modal:${getRandomId(8)}`;
        this.name = options.name ?? this.id;
        this.type = options.type;
        this.#clickOutInclude = options.clickOutInclude || [document];
        this.#eventsAbortController = new AbortController();
        this.#scrollPositions = new WeakMap();
        this.interactions = new ModalInteractions(this);

        runInAction(() => {
            this.responsiveMode = evaluateValue(options.initialResponsiveMode) ?? null;
            this.setTabOptions(this.defaultTabId);
        });

        requestAnimationFrame(() => {
            // Need to show loader immediately when opening the window
            if (options.loading) {
                this.setLoader();
            }

            // If modal created outside of React tree, create modal root
            // and mount it to the DOM
            if (!options.reactHost) {
                this.createModalRoot();
            }

            this.#bindEvents();
            this.interactions.initDraggable();
            this.interactions.initResizable();

            this.currentOptions.onInit?.(this);

            void this.open(true);
        });
    }

    /**
     * Triggers a global event on the Modal class
     */
    triggerEvent(event: string) {
        void Modal.events.emit(event, this);
    }

    /**
     * Updates options
     */
    @action
    updateOptions(options: Partial<Opts>) {
        const prevWidth = this.currentOptions.width;
        const prevHeight = this.currentOptions.height;

        let nextOptions: Partial<Opts> = {
            ...this.options,
            ...options,
        };

        if (typeof nextOptions.getOptions === 'function') {
            nextOptions = {
                ...nextOptions,
                ...nextOptions.getOptions(this),
            };
        }

        this.options = this.normalizeOptions(nextOptions);
        this.type = this.options.type;
        this.setTabOptions(this.defaultTabId);

        if (this.currentOptions.width !== prevWidth || this.currentOptions.height !== prevHeight) {
            this.refreshLayout();
        }
    }

    /**
     * Replace options for a reused instance without carrying stale caller options.
     */
    @action
    private replaceOptions(options: Partial<Opts>) {
        let nextOptions: Partial<Opts> = {
            id: this.id,
            name: this.name,
            ...options,
        };

        if (typeof nextOptions.getOptions === 'function') {
            nextOptions = {
                ...nextOptions,
                ...nextOptions.getOptions(this),
            };
        }

        this.options = this.normalizeOptions(nextOptions);
        this.name = this.options.name ?? this.name;
        this.id = this.options.id ?? this.id;
        this.type = this.options.type;
        this.setTabOptions(this.defaultTabId);
    }

    private canReuseWith(options: Partial<Opts>, reuseExisting = options.reuseExisting ?? !options.duplicate) {
        return !!reuseExisting && !options.reactHost && !options.hideOnClose && !this.currentOptions.hideOnClose;
    }

    /**
     * Reuse this instance for a new Modal.create call with the same id/name.
     */
    private reuse(options: Partial<Opts>) {
        const previousOptions = this.currentOptions;
        const sameTarget = options.target != null && previousOptions.target === options.target;

        if (!sameTarget) {
            previousOptions.onBeforeReuse?.(this);
        }

        this.replaceOptions(options);

        runInAction(() => {
            this.responsiveMode = evaluateValue(this.options.initialResponsiveMode) ?? null;
            this.contentRevision += 1;
        });

        if (this.options.loading) {
            this.setLoader();
        } else if (this.loading) {
            this.removeLoader();
        }

        if (this.hidden) {
            this.show();
        }

        requestAnimationFrame(() => {
            this.refreshLayout();
        });

        this.focus();
    }

    /**
     * Overlay-scroll and fullscreen overlay skip JS position / max-height —
     * the overlay is the scrollport, the window stays in flow.
     */
    private skipsWindowPositioning(): boolean {
        const { type, scrollable } = this.currentOptions;

        return type === 'overlay' || scrollable === 'overlay';
    }

    /**
     * Keep a dragged window where the user put it. Otherwise place it from the anchor.
     * A size change only pulls a dragged window back on screen.
     */
    private applyPosition() {
        if (this.currentOptions.handle && this.interactions.hasUserMoved) {
            this.#fixOverflow();

            return;
        }

        this.updatePosition();
    }

    /**
     * Recalculate dimensions and position after options change.
     */
    refreshLayout() {
        if (this.skipsWindowPositioning()) {
            this.stopTargetWatcher();

            return;
        }

        if (!this.windowEl) {
            return;
        }

        this.syncTargetWatcher();
        this.updateBounds();
        this.updateStyles(
            {
                width: this.currentOptions.width ?? '',
                height: this.currentOptions.height ?? '',
            },
            true
        );
        this.updateBounds();
        this.applyPosition();
    }

    /**
     * Close anchored windows when their target leaves the visible UI.
     */
    private syncTargetWatcher() {
        if (this.currentOptions.closeOnTargetLost) {
            this.initTargetWatcher();

            return;
        }

        this.stopTargetWatcher();
    }

    private initTargetWatcher() {
        if (this.#targetWatchInterval != null || !this.currentOptions.closeOnTargetLost) {
            return;
        }

        const checkTarget = () => {
            if (this.hidden || !this.isTargetLost()) {
                return;
            }

            this.cancel({ restoreFocus: false });
        };

        this.#targetWatchInterval = window.setInterval(checkTarget, 150);
        this.addDisposer(() => {
            if (this.#targetWatchInterval == null) {
                return;
            }

            this.stopTargetWatcher();
        });

        checkTarget();
    }

    private stopTargetWatcher() {
        if (this.#targetWatchInterval == null) {
            return;
        }

        window.clearInterval(this.#targetWatchInterval);
        this.#targetWatchInterval = null;
    }

    private isTargetLost() {
        const options = this.currentOptions;

        if (!options.closeOnTargetLost || options.type === 'overlay' || options.positionFrom !== 'target') {
            return false;
        }

        const target = this.getPositionTarget();

        if (!target || target === target.ownerDocument.body || target === target.ownerDocument.documentElement) {
            return false;
        }

        if (!target.isConnected) {
            return true;
        }

        const frameElement = target.ownerDocument.defaultView?.frameElement as HTMLElement | null;

        if (frameElement && (this.isElementInvisible(frameElement) || !frameElement.isConnected)) {
            return true;
        }

        return this.isElementInvisible(target);
    }

    private getPositionTarget() {
        const options = this.currentOptions;

        return options.target || options.fromModal?.windowEl || null;
    }

    private isElementInvisible(element: HTMLElement) {
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);

        if (style?.display === 'none' || style?.visibility === 'hidden') {
            return true;
        }

        const rect = element.getBoundingClientRect();

        return element.getClientRects().length === 0 || (!rect.width && !rect.height);
    }

    /**
     * Creates modal root using React
     */
    private createModalRoot() {
        const container = document.createElement('div');

        container.setAttribute('data-modal-root-container', this.name);
        document.body.appendChild(container);

        const root = createRoot(container);

        flushSync(() => {
            root.render(
                React.createElement(ModalRoot, {
                    modal: this,
                })
            );
        });

        this.addDisposer(() => {
            root.unmount();

            container.remove();
        });
    }

    setOverlay(overlay: HTMLElement | null) {
        if (!overlay) {
            return;
        }

        this.overlay = overlay;
    }

    setWindow(element: HTMLDivElement | null) {
        this.windowEl = element;
    }

    /**
     * Init core modal events (close on ESC or overlay and other)
     */
    #bindEvents() {
        const { overlay } = this;
        const windowEl = this.windowEl;

        const handleClose = () => {
            if (!this.dismissable) {
                return false;
            }

            const modals = Modal.visible;

            // close all nested modals
            if (modals.length > 1) {
                const currentModalIndex = modals.findIndex(modal => modal.id === this.id);
                const modalsToClose = modals.slice(currentModalIndex + 1);

                const eachClosed = modalsToClose.every(modal => modal.cancel());

                if (!eachClosed) {
                    return false;
                }
            }

            this.cancel();
        };

        // Helper to check if element matches selector or is within selector
        const matchesSelector = (element: HTMLElement, selector: string): boolean => {
            if (element.matches(selector)) {
                return true;
            }

            return element.closest(selector) !== null;
        };

        const hasOpenClickoutBlockingLayer = (doc: Document): boolean =>
            doc.querySelector(CLICKOUT_BLOCKING_LAYER_SELECTOR) !== null;

        // ESC
        overlay.addEventListener(
            'keydown',
            (e: KeyboardEvent) => {
                const options = this.currentOptions;

                if (e.key === 'Tab') {
                    this.#containTab(e);

                    return;
                }

                if (!options.closeOnEscape || e.key !== 'Escape') {
                    return;
                }

                if (this.dismissable) {
                    this.cancel();
                }

                e.preventDefault();
                e.stopImmediatePropagation();
            },
            { signal: this.#eventsAbortController.signal }
        );

        // CLOSE BTN
        const closeButtonSelector = '[data-modal-close], header .close, footer .close';

        const handleCloseButtonPointerDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null;

            if (target && matchesSelector(target, closeButtonSelector)) {
                const { pageX, pageY } = e;

                this.#initialCoords = { pageX, pageY };
            }
        };

        const handleCloseButtonPointerUp = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null;

            if (!target || !matchesSelector(target, closeButtonSelector)) {
                return;
            }

            if (this.#initialCoords != null) {
                const { pageX, pageY } = e;
                const distance = distanceBetween(
                    [pageX, pageY],
                    [this.#initialCoords.pageX, this.#initialCoords.pageY]
                );

                if (+distance.toFixed(0) <= CLOSE_BUTTON_DISTANCE_THRESHOLD) {
                    handleClose();
                }

                this.#initialCoords = null;
            } else {
                handleClose();
            }
        };

        overlay.addEventListener('pointerdown', handleCloseButtonPointerDown, {
            signal: this.#eventsAbortController.signal,
        });
        overlay.addEventListener('pointerup', handleCloseButtonPointerUp, {
            signal: this.#eventsAbortController.signal,
        });

        // ClickOut modal
        let denyClose = false;
        let clickTarget: HTMLElement | null = null;
        let wasLastOnPointerDown = false;
        const resetClickOutState = () => {
            denyClose = false;
            clickTarget = null;
            wasLastOnPointerDown = false;
        };

        // Prevent context menu on overlay (not needed)
        overlay.addEventListener(
            'contextmenu',
            (e: MouseEvent) => {
                if (e.target === overlay) {
                    e.preventDefault();
                }
            },
            { signal: this.#eventsAbortController.signal }
        );

        // Remember the start of the click
        const handlePointerDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null;

            if (!target) {
                denyClose = true;

                return;
            }

            clickTarget = target;

            const options = this.currentOptions;
            const modals = Modal.visible;
            const lastModal = modals[modals.length - 1];
            const clickStartedInsideWindow = windowEl?.contains(target) ?? false;
            const clickStartedOnAnchor = options.target?.contains(target) ?? false;
            const clickStartedInExcludedArea =
                options.clickOutExclude?.some(selector => matchesSelector(target, selector)) ?? false;
            const clickStartedInBlockingLayer = matchesSelector(target, CLICKOUT_BLOCKING_LAYER_SELECTOR);
            const clickStartedWithBlockingLayerOpen = hasOpenClickoutBlockingLayer(target.ownerDocument);

            wasLastOnPointerDown = lastModal === this;

            denyClose =
                e.button !== 0 ||
                clickStartedInsideWindow ||
                clickStartedOnAnchor ||
                clickStartedInExcludedArea ||
                clickStartedInBlockingLayer ||
                clickStartedWithBlockingLayerOpen;
        };

        // And the end of the click
        const handlePointerUp = (e: PointerEvent) => {
            if (denyClose || !clickTarget) {
                resetClickOutState();

                return;
            }

            clickTarget = null;

            const target = e.target as HTMLElement | null;

            if (!target) {
                resetClickOutState();

                return;
            }

            const options = this.currentOptions;

            // Ignore click on close button, it's handled above
            const closeButton = matchesSelector(target, '[data-modal-close]');
            const dropdownIsOpen = !!document.querySelector('body .dropdown-balloon');

            if (closeButton || dropdownIsOpen) {
                resetClickOutState();

                return;
            }

            // Window is hidden, ignore closing
            if (!wasLastOnPointerDown || this.hidden || this.interactions.isDragging) {
                resetClickOutState();

                return;
            }

            resetClickOutState();

            // Ignore click inside own window
            if (windowEl?.contains(target)) {
                return;
            }

            // Closing by outside click is disabled - animate
            if (!options.clickOut || !this.dismissable) {
                if (options.animate && windowEl) {
                    animate(
                        windowEl,
                        {
                            scale: [1, 1.02, 1],
                        },
                        {
                            duration: 0.18,
                            ease: 'circInOut',
                        }
                    );
                }

                return;
            }

            // Ignore clicks handled by a higher interaction layer
            if (matchesSelector(target, CLICKOUT_BLOCKING_LAYER_SELECTOR)) {
                return;
            }

            const contentRevision = this.contentRevision;

            // Slightly delay closing to allow click events that might occur on this element to fire
            setTimeout(() => {
                if (!Modal.list.has(this) || this.contentRevision !== contentRevision) {
                    return;
                }

                this.cancel({ restoreFocus: false });
            }, CLICKOUT_CLOSE_DELAY);
        };

        this.#clickOutInclude.forEach(targetDoc => {
            targetDoc.addEventListener('pointerdown', (e: Event) => handlePointerDown(e as PointerEvent), {
                capture: true,
                signal: this.#eventsAbortController.signal,
            });
            targetDoc.addEventListener('pointerup', (e: Event) => handlePointerUp(e as PointerEvent), {
                capture: true,
                signal: this.#eventsAbortController.signal,
            });
        });
    }

    /**
     * open - Open modal
     *
     * @param {type} isNew Description
     */
    async open(isNew = false) {
        const { options } = this;
        const overlay = this.overlay;
        const win = this.windowEl;

        const complete = (): void => {
            this.triggerEvent('open');

            overlay.style.transform = '';
            overlay.style.opacity = '';
            overlay.style.visibility = '';

            if (win) {
                win.style.transform = '';
                win.style.opacity = '';
                overlay.style.visibility = '';
            }

            options.onOpened?.(this);
        };

        // Opened from another editor, hide it
        if (options.fromModal) {
            options.fromModal.disable();
        }

        const isOverlayStyle = options.type === 'overlay';

        if (isOverlayStyle && isNew) {
            history.pushState({ modalId: this.id }, window.document.title, '');
        }

        if (isOverlayStyle || options.overlay) {
            document.body.classList.add('overflow');
        }

        const shouldAnimate = options.animate && isNew && win;

        if (!this.skipsWindowPositioning()) {
            this.updateBounds();
            this.updateStyles();
            this.initResizeObserver();
            this.syncTargetWatcher();
            this.updatePosition();
        }

        if (shouldAnimate && win) {
            overlay.style.opacity = String(isOverlayStyle ? 0.6 : 0);
            overlay.style.visibility = 'visible';

            const animations = [
                animate(
                    overlay,
                    {
                        opacity: 1,
                    },
                    {
                        duration: MODAL_OPEN_DURATION_S,
                        ease: 'easeOut',
                    }
                ),
                animate(
                    win,
                    {
                        scale: [0.98, 1],
                        y: [10, 0],
                    },
                    {
                        duration: MODAL_OPEN_DURATION_S,
                        ease: 'circOut',
                    }
                ),
            ];

            await Promise.all(animations);
            complete();
        } else {
            complete();
        }

        options.onOpen?.(this);

        this.focus();
    }

    /**
     * Close modal
     *
     * @param {boolean} [popstate] Need fire popstate event
     */
    async close(popstate = true, { restoreFocus = true }: CloseOptions = {}) {
        const { options } = this;

        const isOverlayStyle = options.type === 'overlay';

        if (isOverlayStyle && popstate) {
            window.dispatchEvent(new PopStateEvent('popstate'));
        }

        // Abort all event listeners
        this.#eventsAbortController.abort();

        if (typeof this.#resizeObserver?.disconnect === 'function') {
            this.#resizeObserver.disconnect();
        }

        // Blur any inputs
        const focusedElement = this.overlay?.querySelector(':focus');

        if (focusedElement && 'blur' in focusedElement && typeof (focusedElement as HTMLElement).blur === 'function') {
            (focusedElement as HTMLElement).blur();
        }

        const win = this.windowEl;
        const overlay = this.overlay;
        const shouldAnimate = options.animate && win && overlay;

        if (shouldAnimate) {
            await Promise.all([
                animate(
                    win,
                    {
                        scale: 0.98,
                        y: 10,
                        opacity: 0,
                    },
                    {
                        duration: MODAL_CLOSE_DURATION_S,
                        ease: 'circOut',
                    }
                ),
                animate(
                    overlay,
                    {
                        opacity: 0,
                    },
                    {
                        duration: MODAL_CLOSE_DURATION_S,
                        ease: 'easeOut',
                    }
                ),
            ]);
        }

        options.onClose?.(this);

        // Remove from list before triggering event so listeners don't see closed modals
        Modal.list.delete(this);

        // Dispose all registered disposers and unmount component
        this.disposeAll();

        this.triggerEvent('close');

        // Opened from another window, show it
        if (options.fromModal) {
            options.fromModal.enable();

            return;
        }

        // An element that is gone by now (a deleted row) cannot take focus, so it stays where the browser put it and the caller picks the next place.
        if (restoreFocus) {
            this.#prevActiveElement?.focus();
        }

        if (isOverlayStyle || options.overlay) {
            document.body.classList.remove('overflow');
        }
    }

    updateBounds() {
        const modal = this.windowEl;

        if (!modal) {
            return;
        }

        const { overlay, options } = this;
        const windowWidth = modal.offsetWidth;
        const windowHeight = modal.offsetHeight;

        const overlayWidth = overlay.offsetWidth;
        const overlayHeight = overlay.offsetHeight;

        const limit = options.limit ?? { top: 15, left: 15, right: 15, bottom: 15 };

        this.bounds = {
            windowWidth,
            windowHeight,
            overlayWidth,
            overlayHeight,
            limits: {
                minLeft: limit.left ?? 15,
                maxLeft: overlayWidth - windowWidth - (limit.right ?? 15),
                minTop: limit.top ?? 15,
                maxTop: overlayHeight - windowHeight - (limit.bottom ?? 15),
                overflowMinLeft: (limit.left ?? 15) - windowWidth,
                overflowMaxLeft: overlayWidth - (limit.right ?? 15),
                overflowMinTop: limit.top ?? 15,
                overflowMaxTop: overlayHeight - (limit.bottom ?? 15),
            },
        };
    }

    /**
     * Updates window size/position
     *
     * @param {object?} args - css params for modal
     * @param allowOverflow
     */
    updateStyles(args = {}, allowOverflow = false) {
        const { overlay, options } = this;

        if (this.skipsWindowPositioning()) {
            return;
        }

        const modal = this.windowEl;

        if (!modal) {
            return;
        }

        const { overlayWidth, overlayHeight, limits } = this.bounds;

        let styles: {
            position: string | null;
            top: number;
            left: number;
            width: number | string;
            height: number | string;
            maxWidth: number | string | null;
            maxHeight: number | string | null;
        } = {
            position: null,
            top: 0,
            left: 0,
            width: this.currentOptions.width ?? '',
            height: this.currentOptions.height ?? '',
            maxWidth: null,
            maxHeight: null,
        };

        styles = {
            ...styles,
            ...this.styles,
            ...args,
        };

        const minLeft = allowOverflow ? limits.overflowMinLeft : limits.minLeft;
        const maxLeft = allowOverflow ? limits.overflowMaxLeft : limits.maxLeft;
        const minTop = allowOverflow ? limits.overflowMinTop : limits.minTop;
        const maxTop = allowOverflow ? limits.overflowMaxTop : limits.maxTop;

        // Offset cannot exceed the set limit
        if (options.position) {
            styles.top = styles.top > maxTop ? maxTop : styles.top < minTop ? minTop : styles.top;
            styles.left = styles.left > maxLeft ? maxLeft : styles.left < minLeft ? minLeft : styles.left;
        }

        const limit = options.limit ?? { top: 15, left: 15, right: 15, bottom: 15 };

        styles.maxWidth = overlayWidth - (limit.left ?? 15) - (limit.right ?? 15);
        styles.maxHeight = overlayHeight - (limit.top ?? 15) - (limit.bottom ?? 15);

        Object.assign(modal.style, {
            position: styles.position || '',
            top: typeof styles.top === 'number' ? `${styles.top}px` : String(styles.top),
            left: typeof styles.left === 'number' ? `${styles.left}px` : String(styles.left),
            width: typeof styles.width === 'number' ? `${styles.width}px` : String(styles.width),
            height: typeof styles.height === 'number' ? `${styles.height}px` : String(styles.height),
            maxWidth: styles.maxWidth
                ? typeof styles.maxWidth === 'number'
                    ? `${styles.maxWidth}px`
                    : String(styles.maxWidth)
                : '',
            maxHeight: styles.maxHeight
                ? typeof styles.maxHeight === 'number'
                    ? `${styles.maxHeight}px`
                    : String(styles.maxHeight)
                : '',
        });

        this.styles = { ...styles, position: styles.position };

        overlay.dispatchEvent(new CustomEvent('updatePosition', { detail: styles }));
    }

    /**
     * Positions the window based on given options (next to element or in part of screen)
     */
    updatePosition() {
        const { overlay, options } = this;
        const modal = this.windowEl;

        if (!options.position || this.skipsWindowPositioning() || !modal) {
            return;
        }

        if (this.isTargetLost()) {
            this.cancel({ restoreFocus: false });

            return;
        }

        let top: number;
        let left: number;

        const target = this.getPositionTarget();
        const docRect = {
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight,
        };

        const overlayRect: DOMRect | undefined = overlay?.getBoundingClientRect();
        const itemRect: Writeable<DOMRect> | undefined = target?.getBoundingClientRect()?.toJSON();
        const modalRect: Writeable<DOMRect> = modal.getBoundingClientRect().toJSON();
        const optionWidth = this.currentOptions.width;
        const optionHeight = this.currentOptions.height;

        if (typeof optionWidth === 'number') {
            modalRect.width = optionWidth;
        }

        if (typeof optionHeight === 'number') {
            modalRect.height = optionHeight;
        }

        // Adjust itemRect if target is in a different document (e.g., iframe)
        if (target && itemRect && overlay && target.ownerDocument !== overlay.ownerDocument) {
            const frameElement = target.ownerDocument.defaultView?.frameElement as HTMLElement | null;

            if (frameElement) {
                const frameRect = frameElement.getBoundingClientRect();

                itemRect.top += frameRect.top;
                itemRect.left += frameRect.left;
            }
        }

        const targetRect = (options.positionFrom === 'target' && itemRect) || overlayRect;

        if (!targetRect) {
            return;
        }

        // Invisible or removed from DOM element around which we are positioning
        if (options.positionFrom === 'target' && !targetRect.width && !targetRect.height) {
            return;
        }

        const [xPos, yPos] = options.position || ['center', 'center'];
        const xGap = xPos.includes('around') ? 7 : 0;
        const yGap = yPos.includes('around') ? 7 : 0;

        const { x: offsetX, y: offsetY } = { x: xGap, y: yGap, ...options.positionOffset };

        const oppositePosition: Record<ModalPositionAxis, ModalPositionAxis> = {
            start: 'end',
            start_around: 'end_around',
            end: 'start',
            end_around: 'start_around',
            center: 'center',
        };

        const positionMapX: Record<ModalPositionAxis, number> = {
            start: targetRect.left + offsetX,
            start_around: targetRect.left - modalRect.width - offsetX,
            end: targetRect.left + targetRect.width - modalRect.width - offsetX,
            end_around: targetRect.left + targetRect.width + offsetX,
            center: targetRect.left + targetRect.width / 2 - modalRect.width / 2 + offsetX,
        };

        const positionMapY: Record<ModalPositionAxis, number> = {
            start: targetRect.top + offsetY,
            start_around: targetRect.top - modalRect.height - offsetY,
            end: targetRect.top + targetRect.height - modalRect.height - offsetY,
            end_around: targetRect.top + targetRect.height + offsetY,
            center: targetRect.top + targetRect.height / 2 - modalRect.height / 2 + offsetY,
        };

        left = positionMapX[xPos];
        top = positionMapY[yPos];

        // Try to open window from the other side if it doesn't fit
        if (
            (left < 0 && targetRect.left + modalRect.width + offsetX < docRect.width) || // Overflows left, though it fit on the right
            (left + modalRect.width > docRect.width && targetRect.left > modalRect.width + offsetX) // Cuts off right side of screen, though it fit on the left
        ) {
            left = positionMapX[oppositePosition[xPos]];
        }

        if (
            (top < 0 && targetRect.bottom + modalRect.height + offsetY < docRect.height) ||
            (top + modalRect.height > docRect.height && targetRect.top - modalRect.height - offsetY > 0)
        ) {
            top = positionMapY[oppositePosition[yPos]];
        }

        // Window cannot overflow beyond screen boundaries
        left = clamp(0, left, docRect.width - modalRect.width);
        top = clamp(options.limit?.top ?? 15, top, docRect.height - modalRect.height);

        this.updateStyles({
            position: 'absolute',
            top,
            left,
        });
    }

    updateView() {
        // Not implemented in base class
    }

    /**
     * Select a tab by ID
     */
    @action
    selectTab(activeTab: string) {
        const previousTabId = this.activeTab;

        if (activeTab === previousTabId) {
            return;
        }

        const win = this.windowEl;

        if (win) {
            win.classList.add(modalStyles.noanimate);
        }

        // Update tab options
        this.setTabOptions(activeTab);

        // Restore dimensions for new tab
        this.interactions.restoreDimensions();

        // Call callback
        this.options.onSelectTab?.(activeTab, this);

        // Notify about resize if tab change affects size
        requestAnimationFrame(() => {
            const w = this.windowEl;

            if (w) {
                w.classList.remove(modalStyles.noanimate);
            }
        });
    }

    /**
     * Toggle responsive mode for the modal
     */
    toggleResponsiveMode(state: string) {
        if (state === this.responsiveMode) {
            return;
        }

        const win = this.windowEl;

        if (win) {
            win.classList.add(modalStyles.noanimate);
        }

        this._setResponsiveMode(state);

        this.updateStyles({
            width: this.currentOptions.width,
            height: this.currentOptions.height,
        });

        requestAnimationFrame(() => {
            const w = this.windowEl;

            if (w) {
                w.classList.remove(modalStyles.noanimate);
            }
        });
    }

    /**
     * Set responsive mode for the modal
     */
    protected _setResponsiveMode(state: string) {
        this.responsiveMode = state;
    }

    /**
     * Watch for window size changes and fix position if necessary
     */
    initResizeObserver() {
        const onResize = () => {
            if (this.hidden || this.interactions.isDragging || this.interactions.isResizing) {
                return;
            }

            const { windowHeight: oldWindowHeight, windowWidth: oldWindowWidth } = this.bounds;

            this.updateBounds();

            this.applyPosition();

            const { windowHeight: newWindowHeight, windowWidth: newWindowWidth } = this.bounds;

            if (oldWindowHeight !== newWindowHeight || oldWindowWidth !== newWindowWidth) {
                this.options.onResize?.(this);
            }
        };

        // On screen or modal resize
        window.addEventListener('resize', onResize, { signal: this.#eventsAbortController.signal });
        this.#resizeObserver = new ResizeObserver(() => onResize());

        if (this.windowEl) {
            this.#resizeObserver.observe(this.windowEl);
        }
    }

    /**
     * Hide modal from screen
     */
    @action
    hide({ trigger = true, hideParent = true }: { trigger?: boolean; hideParent?: boolean } = {}) {
        if (this.hidden) {
            return;
        }

        this.#saveScrollPosition();

        this.hidden = true;

        // Hidden from another window, hide it too
        if (hideParent && this.options.fromModal) {
            this.options.fromModal.hide();
        }

        document.body.classList.remove('overflow');

        if (trigger) {
            this.overlay.dispatchEvent(new CustomEvent('hide'));

            this.options.onHide?.(this);
            this.triggerEvent('hide');
        }
    }

    /**
     * Show hidden modal
     */
    @action
    show({ trigger = true, showParent = true }: { trigger?: boolean; showParent?: boolean } = {}) {
        // is destroyed
        if (!Modal.list.has(this) || !this.hidden) {
            return;
        }

        // Opened from another window, show it too
        if (showParent && this.options.fromModal) {
            this.options.fromModal.show();
        }

        this.hidden = false;

        // Restore scroll position if it existed
        this.#restoreScrollPosition();

        this.focus();

        if (trigger) {
            this.overlay.dispatchEvent(new CustomEvent('show'));

            this.options.onShow?.(this);
            this.triggerEvent('show');
        }
    }

    /** Names the dialog by the element with this id, or by nothing (`null`). */
    @action
    setLabelledBy(id: string | null) {
        this.labelledBy = id;
    }

    /** Blocks (false) or allows (true) closing by Escape, an outside click and the close button, for the time an action in the modal runs. */
    @action
    setDismissable(dismissable: boolean) {
        this.dismissable = dismissable;
    }

    /** Whether the modal holds the page behind it: it has a backdrop. A window without one is a float the page stays usable beside. */
    get isModal(): boolean {
        const options = this.currentOptions;

        return options.type === 'overlay' || options.overlay || options.shadow;
    }

    /** Keeps Tab and Shift+Tab inside a modal that holds the page: from the last control to the first and back, and from the window itself into it. */
    #containTab(e: KeyboardEvent) {
        const windowEl = this.windowEl;

        if (!windowEl || !this.isModal) {
            return;
        }

        const tabbable = [...windowEl.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)].filter(
            element => !element.closest('[inert], [hidden]') && element.getClientRects().length > 0
        );
        const first = tabbable[0];
        const last = tabbable[tabbable.length - 1];
        const active = document.activeElement;

        if (!first || !last) {
            e.preventDefault();

            return;
        }

        const inside = active instanceof HTMLElement && windowEl.contains(active) && active !== windowEl;

        if (e.shiftKey && (!inside || active === first)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && (!inside || active === last)) {
            e.preventDefault();
            first.focus();
        }
    }

    /**
     * Focus current modal
     */
    focus() {
        if (!this.windowEl) {
            return;
        }

        // Something inside this modal is already focused — don't steal it
        if (this.overlay.contains(document.activeElement) && document.activeElement !== this.overlay) {
            return;
        }

        if (document.activeElement !== this.overlay) {
            // `body` means nothing had focus: keep the element noted at creation, if any.
            this.#prevActiveElement = Modal.focusedElement() ?? this.#prevActiveElement;

            this.overlay.focus();
        }
    }

    /**
     * Shake it
     */
    shake(duration = 300) {
        if (!this.overlay) {
            return;
        }

        this.overlay.classList.add('shake');

        setTimeout(() => {
            this.overlay.classList.remove('shake');
        }, duration);
    }

    /**
     * Make window unactive
     */
    @action
    disable() {
        const win = this.windowEl;

        if (win) {
            disableFocusByTab([win]);
        }

        this.disabled = true;
    }

    /**
     * Make window active
     */
    @action
    enable() {
        const win = this.windowEl;

        if (win) {
            enableFocusByTab([win]);
        }

        this.disabled = false;
        this.focus();
    }

    /**
     * sets the flag that modal is saved
     */
    saved() {
        this.isSaved = true;
    }

    /**
     * sets the flag that modal is not saved
     */
    unsaved() {
        this.isSaved = false;
    }

    /**
     * Shows loader on the entire editor window
     */
    @action
    setLoader() {
        this.disable();

        this.loading = true;
    }

    /**
     * Removes loader
     */
    @action
    removeLoader() {
        this.enable();

        this.loading = false;
    }

    /**
     * Asks before closing a modal with unsaved changes.
     * Override in extended classes for a custom dialog.
     */
    async showConfirm(): Promise<boolean> {
        const { confirmDiscardChanges } = await import('../modals/ConfirmModal');

        return confirmDiscardChanges();
    }

    /**
     * Close modal and show confirmation when data is not saved
     */
    cancel({ restoreFocus = true }: CloseOptions = {}) {
        const handleClose = () => {
            if (typeof this.options.onCancel === 'function') {
                this.options.onCancel(this);
            }

            // Hide modal instead of closing it
            if (this.options.hideOnClose) {
                this.hide();
            }
            // Close modal and destroy instance
            else {
                void this.close(true, { restoreFocus });
            }
        };

        // Show confirmation dialog if modal is not saved
        if (!this.isSaved) {
            void this.showConfirm().then(confirmed => {
                if (confirmed) {
                    handleClose();
                }
            });

            return false;
        }

        // Close modal and destroy instance
        handleClose();

        return true;
    }

    #fixOverflow() {
        const { limits } = this.bounds;
        const { top, left } = this.styles;

        let x = left;
        let y = top;

        if (y < limits.minTop) {
            y = limits.minTop;
        } else if (y > limits.maxTop) {
            y = limits.maxTop;
        }

        if (x < limits.minLeft) {
            x = limits.minLeft;
        } else if (x > limits.maxLeft) {
            x = limits.maxLeft;
        }

        this.updateStyles({
            top: y,
            left: x,
        });
    }

    #saveScrollPosition() {
        this.#scrollableEl = Array.from(this.overlay.querySelectorAll('.scrollable-content'));

        this.#scrollableEl.forEach(el => {
            this.#scrollPositions.set(el, {
                top: el.scrollTop || 0,
                left: el.scrollLeft || 0,
            });
        });
    }

    #restoreScrollPosition() {
        this.#scrollableEl?.forEach(el => {
            const position = this.#scrollPositions.get(el);

            if (position) {
                el.scrollTo(position.left, position.top);
            }
        });
    }

    /**
     * Add a disposer function to be called when modal is closed
     */
    protected addDisposer(disposer: () => void): void {
        this.#disposers.push(disposer);
    }

    /**
     * Dispose all registered disposers
     */
    protected disposeAll(): void {
        this.#disposers.forEach(disposer => disposer());
        this.#disposers = [];
    }
}

export default Modal;
