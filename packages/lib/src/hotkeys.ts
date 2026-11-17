import { arrayUnique, compareArray, getRandomId } from '@clowdy/lib';
import debounce from 'lodash/debounce';
import throttle from 'lodash/throttle';
import { action, computed, observable } from 'mobx';

type HotkeyName = string;

type HandlerArguments = [event: KeyboardEvent, payload: {
    key: string;
    code: string;
    mod: string[];
    name: HotkeyName;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}];

type Disposer = () => void;

export type HotkeyHandlerData = {
    id?: number;
    hotkeys: HotkeyName[];
    shouldPrevent?: (e: Event) => boolean;
    handlerDown?: (...args: HandlerArguments) => void;
    handlerUp?: (...args: HandlerArguments) => void;
    handlerPress?: (...args: HandlerArguments) => void;
    options?: Partial<HotkeyHandlerOptions>;
};

export type HotkeyHandlerOptions = {
    included: (string | HTMLElement)[]; // Selectors on which the event should trigger, others will be ignored
    excluded: (string | HTMLElement)[]; // Selectors on which the event should be ignored (e.g., input) - takes priority over included
    debounce: number;
    throttle: number;
    allowRepeat: boolean; // Allows events to fire multiple times in a row (keydown)
    preventDefault: boolean; // Calls e.preventDefault
    stopPropagation: boolean; // Calls e.stopPropagation
    stopImmediatePropagation: boolean; // Prevents listeners added before this from running
    clearHandlers: boolean; // Clears handlers added before this
    runFirst: boolean; // Adds listener to the beginning of the list (LIFO order of addition/execution)
    capture: boolean; // Handles the hotkey before target-level listeners
};

const DEFAULT_OPTIONS: HotkeyHandlerOptions = {
    excluded: [],
    included: [],
    debounce: 0,
    throttle: 0,
    allowRepeat: false, // Allows hotkey to fire multiple times in a row (keydown)
    preventDefault: true, // Calls e.preventDefault
    stopPropagation: true, // Calls e.stopPropagation
    stopImmediatePropagation: false, // Prevents listeners added before this from running
    clearHandlers: false, // Clears handlers added before this
    runFirst: true, // Adds listener to the beginning of the list (LIFO order of addition/execution)
    capture: false,
};

const isMac = navigator.userAgent.includes('Mac');

export const COMMAND_SYMBOL = isMac ? '⌘' : 'Ctrl';
export const ALT_SYMBOL = isMac ? '⌥' : 'Alt';
export const CONTROL_SYMBOL = isMac ? '⌃' : 'Ctrl';
export const DEL_SYMBOL = isMac ? '⌫' : 'Delete';
export const BACKSPACE_SYMBOL = isMac ? '⌫' : 'Backspace';
export const SHIFT_SYMBOL = isMac ? '⇧' : 'Shift';
export const RETURN_SYMBOL = '⏎';
export const BACKSLASH_SYMBOL = '\\';

export const contentEditableSelectors = [
    'input',
    'textarea',
    '[contenteditable]:focus',
];

/**
 * Hotkeys
 */
export class Hotkeys {
    private documents: Document[] = [];

    private list: Record<string, HotkeyHandlerData[]> = {};
    readonly isMac = isMac;

    // TODO: Remove this and import where needed
    COMMAND_SYMBOL = COMMAND_SYMBOL;
    ALT_SYMBOL = ALT_SYMBOL;
    DEL_SYMBOL = DEL_SYMBOL;

    inited = false;

    @observable accessor isDisabled = false;

    @observable accessor excludeFromDisabled: string[] = [];

    @observable accessor pressed = new Set();

    @observable accessor shiftKey = false;

    @observable accessor metaKey = false;

    @observable accessor altKey = false;

    @observable accessor ctrlKey = false;

    abortController: AbortController | undefined;

    /**
     * Main control key is pressed (meta on Mac and ctrl on Windows/Linux)
     */
    @computed
    get commandKey() {
        return this.isMac ? this.metaKey : this.ctrlKey;
    }

    /**
     * Initializes event listeners on the document
     */
    init() {
        // Extract documents from $document if available (usually 2 documents in iframe scenarios)
        // $document is typically a jQuery collection containing multiple document objects
        if ((window as any).$document) {
            this.documents = (window as any).$document.toArray();
        }
        else {
            // Fallback to single document
            this.documents = [document];
        }

        if (!this.inited) {
            this.inited = true;

            this.#initControlKeys();
        }

        // Code below may be reinitialized because $document can be changed (on page change)
        const handleEvent = (e: KeyboardEvent, capturePhase: boolean) => {
            // Prevent window from losing focus when Alt is pressed in Windows
            if (e.key === 'Alt') {
                e.preventDefault();
            }

            const key = String(e.key);
            const code = String(e.code).replace(/^Key/, '').toLowerCase();

            const metaKey = (e.metaKey && !/^meta/.test(code));
            const ctrlKey = (e.ctrlKey && !/^control/.test(code));
            const shiftKey = (e.shiftKey && !/^shift/.test(code));
            const altKey = (e.altKey && !/^alt/.test(code));

            const mod = [
                metaKey ? 'meta' : null,
                ctrlKey ? 'control' : null,
                shiftKey ? 'shift' : null,
                altKey ? 'alt' : null,
            ].filter((k): k is string => k !== null);

            const name = (mod.length) ? `${ mod.join('_') }_${ code }` : `${ code }`;
            const isNameExcludedFromDisabled = this.excludeFromDisabled.includes(name);
            const hotkeys: HotkeyHandlerData[] = [(this.list[name] || []), (this.list['*'] || [])].flat();

            const handlerArgs: HandlerArguments = [e, { key, code, mod, name, metaKey, ctrlKey, shiftKey, altKey }];

            if (hotkeys.length === 0) {
                return;
            }

            if (this.isDisabled && !isNameExcludedFromDisabled) {
                return;
            }

            // Use some to exit the loop if needed
            hotkeys.some(({ shouldPrevent, handlerDown, handlerUp, handlerPress, options = {} }) => {
                if (Boolean(options.capture) !== capturePhase) {
                    return false;
                }

                const excluded = options.excluded ?? [];
                const included = options.included ?? [];

                const areaIsForbidden = excluded.length > 0 && excluded.some((item) => {
                    if (typeof item === 'string') {
                        return this.#closestElement(e.target as Element, item) !== null;
                    }

                    return item === e.target || item.contains(e.target as Node);
                });

                const areaIsAllowed = included.length > 0
                    ? included.some((item) => {
                        if (typeof item === 'string') {
                            return this.#closestElement(e.target as Element, item) !== null;
                        }

                        return item === e.target || item.contains(e.target as Node);
                    })
                    : true;

                const isPrevented = typeof shouldPrevent === 'function' && shouldPrevent(e);

                if (areaIsForbidden || !areaIsAllowed || isPrevented) {
                    return false;
                }

                if (options.allowRepeat || !e.repeat) {
                    if (e.type === 'keydown' && typeof handlerDown === 'function') {
                        handlerDown(...handlerArgs);
                    }

                    if (e.type === 'keypress' && typeof handlerPress === 'function') {
                        handlerPress(...handlerArgs);
                    }

                    if (e.type === 'keyup' && typeof handlerUp === 'function') {
                        handlerUp(...handlerArgs);
                    }
                }

                if (options.preventDefault) {
                    e.preventDefault();
                }

                if (options.stopPropagation) {
                    e.stopPropagation();
                }

                // Exit the loop
                if (options.stopImmediatePropagation) {
                    e.stopImmediatePropagation();

                    return true;
                }

                return false;
            });
        };

        const bubbleHandler = (e: KeyboardEvent) => handleEvent(e, false);
        const captureHandler = (e: KeyboardEvent) => handleEvent(e, true);

        if (this.abortController) {
            this.abortController.abort();
        }

        this.abortController = new AbortController();

        this.documents.forEach((doc) => {
            doc.addEventListener('keydown', captureHandler, { capture: true, signal: this.abortController!.signal });
            doc.addEventListener('keypress', captureHandler, { capture: true, signal: this.abortController!.signal });
            doc.addEventListener('keyup', captureHandler, { capture: true, signal: this.abortController!.signal });
            doc.addEventListener('keydown', bubbleHandler, { signal: this.abortController!.signal });
            doc.addEventListener('keypress', bubbleHandler, { signal: this.abortController!.signal });
            doc.addEventListener('keyup', bubbleHandler, { signal: this.abortController!.signal });
        });

        this.#initPointerSync(this.abortController.signal);
    }

    /**
     * Initializes tracking of current state of pressed ctrl/meta/shift/... keys
     */
    #initControlKeys() {
        const options = {
            preventDefault: false,
            stopPropagation: false,
            runFirst: true,
        };

        // Currently pressed keys
        this.register([{
            options,
            hotkeys: ['*'],

            handlerDown: action((e, { code }) => {
                if (!this.pressed.has(code)) {
                    this.pressed.add(code);
                }

                this.metaKey = e.metaKey;
                this.shiftKey = e.shiftKey;
                this.altKey = e.altKey;
                this.ctrlKey = e.ctrlKey;
            }),

            handlerUp: action((e, { code }) => {
                if (this.pressed.has(code)) {
                    this.pressed.delete(code);
                }

                this.metaKey = e.metaKey;
                this.shiftKey = e.shiftKey;
                this.altKey = e.altKey;
                this.ctrlKey = e.ctrlKey;
            }),
        }]);
    }

    /**
     * Keeps modifier state aligned with real pointer events.
     */
    #initPointerSync(signal: AbortSignal) {
        const syncModifiers = throttle(action((e: PointerEvent) => {
            this.shiftKey = e.shiftKey;
            this.metaKey = e.metaKey;
            this.ctrlKey = e.ctrlKey;
            this.altKey = e.altKey;
        }), 200);

        this.documents.forEach((doc) => {
            doc.addEventListener('pointerdown', syncModifiers, { signal });
            doc.addEventListener('pointermove', syncModifiers, { signal });
        });
    }

    /**
     * Registers a hotkey
     */
    register(...payload: HotkeyHandlerData[] | HotkeyHandlerData[][]): Disposer {
        if (!this.inited) {
            this.init();
        }

        const flatPayload = payload.flat();

        // Normalize
        const normalizedPayload = flatPayload.map((obj) => {
            const id = obj.id || getRandomId(10);
            const hotkeys = _formatHotkeys(obj.hotkeys, this.isMac);

            const options = {
                ...DEFAULT_OPTIONS,
                ...obj.options,
            };

            // Apply delay to handlers
            if (options.debounce) {
                this.hangDelay('debounce', obj, options.debounce);
            }
            else if (options.throttle) {
                this.hangDelay('throttle', obj, options.throttle);
            }

            return {
                ...obj,
                id: typeof id === 'string' ? parseInt(id, 10) : id,
                hotkeys,
                options,
            };
        }).filter(
            obj => obj.handlerUp || obj.handlerDown || obj.handlerPress
        );

        // Add
        normalizedPayload.forEach((obj) => {
            const { hotkeys, options } = obj;

            hotkeys.forEach((hotkey) => {
                if (this.list[hotkey] == null || options.clearHandlers) {
                    this.list[hotkey] = [];
                }

                if (options.runFirst) {
                    this.list[hotkey].unshift(obj);
                }
                else {
                    this.list[hotkey].push(obj);
                }
            });
        });

        // Return unregister method to quickly unsubscribe from the event if needed
        return () => this.unregister(...normalizedPayload);
    }

    /**
     * Unregisters a hotkey
     */
    unregister(...payload: HotkeyHandlerData[] | HotkeyHandlerData[][]) {
        let unregistered = false;

        payload = payload.flat();

        Object.entries(this.list).forEach(([, list]) => {
            payload.forEach((obj) => {
                const index = list.findIndex((item) => {
                    if (obj.id) {
                        return (item.id === obj.id);
                    }

                    if (obj.handlerDown || obj.handlerUp || obj.handlerPress) {
                        return (item.handlerDown === obj.handlerDown) || (item.handlerUp === obj.handlerUp) || (item.handlerPress === obj.handlerPress);
                    }

                    if (obj.hotkeys) {
                        const hotkeys = _formatHotkeys(obj.hotkeys, this.isMac);

                        return compareArray(true, item.hotkeys, hotkeys);
                    }

                    return false;
                });

                if (index >= 0) {
                    unregistered = true;
                    list.splice(index, 1);
                }
            });
        });

        return unregistered;
    }

    /**
     * Releases all pressed keys
     */
    @action
    loose() {
        this.pressed.clear();

        (['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const).forEach((name) => {
            (this as any)[name] = false;
        });
    }

    /**
     * Disables hotkeys with optional exclusions
     */
    @action
    disable(options: { exclude?: string[] } = {}) {
        const list = _formatHotkeys(options.exclude ?? [], this.isMac);

        this.isDisabled = true;
        this.excludeFromDisabled.push(...list);

        this.loose();
    }

    /**
     * Enables hotkeys
     */
    @action
    enable() {
        this.isDisabled = false;
        this.excludeFromDisabled = [];
    }

    /**
     * Applies debounce or throttle delay to handlers
     */
    private hangDelay(delayType: 'debounce' | 'throttle', obj: HotkeyHandlerData, delay: number) {
        (['handlerDown', 'handlerUp', 'handlerPress'] as const).forEach((handlerName) => {
            if (!obj[handlerName]) {
                return;
            }

            if (delayType === 'debounce') {
                (obj as any)[handlerName] = debounce(obj[handlerName], delay, { leading: true });
            }
            else if (delayType === 'throttle') {
                (obj as any)[handlerName] = throttle(obj[handlerName], delay);
            }
        });
    }

    /**
     * Native closest element implementation
     */
    #closestElement(element: Element, selector: string): Element | null {
        if (element?.matches(selector)) {
            return element;
        }

        let current = element.parentElement;

        while (current) {
            if (current?.matches(selector)) {
                return current;
            }

            current = current.parentElement;
        }

        return null;
    }
}

function _formatHotkeys(hotkeys: HotkeyName | HotkeyName[], isMac: boolean): HotkeyName[] {
    if (!Array.isArray(hotkeys)) {
        hotkeys = [hotkeys];
    }

    return arrayUnique(hotkeys.map(
        hotkey => hotkey
            .toLowerCase()
            .replace(/ctrl/, 'control')
            .replace(/return/, 'enter')
            .replace(/(cmd|command)/, isMac ? 'meta' : 'control')
    ));
}

const hotkeys = new Hotkeys();

export default hotkeys;
