import type { ComponentType, ReactElement } from 'react';
import type Modal from './Modal';

export type EvaluableValue<T> = T | (() => T);

export type ModalPositionAxis = 'start_around' | 'start' | 'center' | 'end' | 'end_around';
export type ModalPosition = [x: ModalPositionAxis, y: ModalPositionAxis];
export type ModalPositionOffset = { x?: number; y?: number };
export type ModalResponsiveMode = 'all' | 'mobile' | 'tablet' | 'desktop' | (string & {});

export type ModalInstance = Modal<ModalOptions>;

/** Options passed to `Modal.create` and `Dialog`; omitted keys use `Modal` defaults. */
export type ModalOptionsRaw = Partial<ModalOptions>;
export type ModalStore = Record<string, any> | Map<any, any>;
export type ModalComponentProps = Record<string, any>;
export type ModalComponent<Props extends ModalComponentProps = any> =
    | ComponentType<Props & { modal: ModalInstance }>
    | ReactElement;

export interface ModalOptions<Props extends ModalComponentProps = any> {
    getOptions?: (modal: ModalInstance) => Partial<ModalOptions>;

    id?: string;
    name?: string;
    class?: string | string[];
    overlayClass?: string | string[];

    title?: string | false | null;
    closeButton?: boolean;
    handle?: string | boolean; // true = whole modal window, string = selector, false = disabled

    type: 'window' | 'overlay';
    theme?: 'light' | 'dark';
    animate: boolean;
    duplicate: boolean; // Allow duplicate modals with the same name. Duplicates with the same ID are never allowed.
    reuseExisting: boolean; // Reuse same-id/name Modal.create instances; duplicate: true opts out unless reuseExisting is explicit.

    loading: boolean; // Loading state (preloader shown/hidden)
    position?: ModalPosition | false;
    positionOffset?: ModalPositionOffset;
    positionFrom: 'target' | 'screen';
    closeOnTargetLost: boolean; // Close target-positioned windows when their anchor is removed or hidden.
    moveAxis?: 'x' | 'y' | 'both';
    fromModal?: ModalInstance | null; // Parent to dim. Omitted window-type modals without overlay nest from the top visible modal; null keeps it active.

    /**
     * When true, `ModalRoot` is rendered by your React tree (e.g. `Dialog`) instead of an internal `createRoot`.
     * The host must mount `<ModalRoot modal={instance} />`; `Modal` defers bind/open until the overlay exists.
     */
    reactHost?: boolean;

    target?: HTMLElement; // Element the modal is anchored to (for positioning)
    component?: ModalComponent<Props>;
    props?: Props;
    /** Shared observable store passed to component and modalActions. Use for MobX or other shared state. */
    store?: ModalStore;

    padding?: number | string; // Number or CSS value
    width?: number | 'min-content' | 'fit-content' | 'max-content';
    minWidth?: number | 'min-content';
    height?: number | 'min-content' | (string & {}); // Number or CSS value

    resizable?: {
        minWidth?: number;
        maxWidth?: number;
        minHeight?: number;
        maxHeight?: number;
        direction?: 'x' | 'y' | 'both';
    };

    limit?: {
        overflow?: boolean;
        top?: number;
        left?: number;
        right?: number;
        bottom?: number;
    };

    /** false | 'hidden' = no scroll wrapper, overflow hidden. 'overlay' = overlay scrolls, window stays in flow (no JS position / max-height). true | 'window' = Scrollable component. */
    scrollable?: boolean | 'hidden' | 'overlay' | 'window';

    overlay: boolean; // Backdrop layer (covers content behind and makes it clickable to close)
    shadow: boolean; // Dim the overlay (semi-transparent dark background). If true, enables overlay. Overlay can be transparent (no shadow) or dimmed (with shadow)
    /** Optional content layered on the overlay, before the window (inside ModalProvider). */
    overlayBackdrop?: ModalComponent;
    clickOut: boolean; // Click outside (on overlay or elements outside the window) closes the modal
    clickOutExclude?: string[]; // Do not close on click on these elements
    clickOutInclude?: (Document | Element)[]; // Target documents/elements to listen for clickout events. Default: [document]
    closeOnEscape: boolean; // Close on Escape key
    hideOnClose: boolean; // Hide on close instead of destroying (only when cancel() is called)

    tabs?: ModalTabOptions[];
    titleTabSize?: 'xs' | 'sm' | 'md' | 'lg';
    activeTab?: string;
    modalActions?: ModalAction[];
    zIndex?: number;

    initialResponsiveMode?: EvaluableValue<ModalResponsiveMode | null>;

    // Responsive modes metadata for UI rendering
    responsiveModes?: Partial<
        Record<
            ModalResponsiveMode,
            {
                icon: string;
                iconSize: number;
                tip: string;
            }
        >
    >;

    // Lifecycle callbacks (called in order):
    // onInit - Called once after modal is initialized (DOM created, events bound) but before opening. Use for setup logic.
    onInit?: (modal: ModalInstance) => void;
    // onOpen - Called when modal starts opening (DOM appended, before animations). Use for immediate actions.
    onOpen?: (modal: ModalInstance) => void;
    // onOpened - Called after open animation completes. Use for actions that should wait for animation.
    onOpened?: (modal: ModalInstance) => void;
    // onMounted - Called for tabs after component is mounted (initial tab and when switching tabs). Use for tab-specific setup.
    onMounted?: (modal: ModalInstance) => void;
    // onUnmounted - Called for tabs before component is unmounted (when closing or switching tabs). Use for cleanup.
    onUnmounted?: (modal: ModalInstance) => void;
    // onSelectTab - Called when user selects a different tab. Use for tab-specific logic.
    onSelectTab?: (tabId: string, modal: ModalInstance) => void;
    // onShow - Called when showing a previously hidden modal (hideOnClose=true). Use for restoring state.
    onShow?: (modal: ModalInstance) => void;
    // onHide - Called when hiding a modal (hideOnClose=true). Use for saving state before hide.
    onHide?: (modal: ModalInstance) => void;
    // onCancel - Called when canceling modal (via cancel() method). Called before hide/close. Use for confirmation logic.
    onCancel?: (modal: ModalInstance) => void;
    // onClose - Called when closing/destroying modal (before component unmount). Use for final cleanup.
    onClose?: (modal: ModalInstance) => void;
    // onBeforeReuse - Called before another target reuses this modal and replaces its options.
    onBeforeReuse?: (modal: ModalInstance) => void;
    // onResize - Called when modal size changes (via ResizeObserver on modal element). Use for responsive adjustments.
    onResize?: (modal: ModalInstance) => void;
}

export interface ModalAction {
    id?: string;
    hide?: boolean;
    component?: ModalComponent;
    props?: ModalOptions['props'];
}

export interface ModalTabOptions extends Partial<ModalOptions> {
    id: string;
    icon?: string;
    title?: string;

    // Small indicator in the corner of the tab indicating that there is something in the tab
    notify?: boolean;
    hide?: boolean;

    // Adaptive options for different responsive modes
    adaptive?: Partial<Record<ModalResponsiveMode, Omit<ModalTabOptions, 'adaptive' | 'id'>>>;
}
