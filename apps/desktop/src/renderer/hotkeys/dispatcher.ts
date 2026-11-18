import { matchKeybindingPress } from 'tinykeys';

import type { HotkeyRegistry, RegisteredCommand, Sequence } from './registry';

/** How long a chord waits for its next key. */
const CHORD_TIMEOUT = 1000;

/** Keys that change what the next key means but are not a key press of their own. They never cancel a chord. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'OS', 'Hyper', 'Super', 'Symbol', 'SymbolLock']);

/** Inputs that do not take text: a single key means a command there. */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'range', 'file', 'color', 'hidden']);

const TEXT_ROLES = '[role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"]';

/**
 * Dialogs and popovers: the page behind them does not get single-key commands.
 * React Aria renders a modal popover (a `Select` list, a `Menu`) as `role="dialog"`, and our `Popover` marks itself with `data-modal-clickout-layer` as well.
 * A bare `role="listbox"` or `role="menu"` is not on this list: an in-page list such as the Settings navigation is not an overlay.
 */
const OVERLAYS = '[data-modal-overlay], [data-modal-clickout-layer], [role="dialog"], [role="alertdialog"]';

const asElement = (target: EventTarget | null): Element | null => (target && typeof (target as Element).closest === 'function' ? target as Element : null);

/** Whether the person types text here, so a single key is a character and not a command. A focused button is not a text target. */
function isTextTarget(target: EventTarget | null): boolean {
    const element = asElement(target);

    if (!element) return false;

    const tag = element.tagName;

    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;

    if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((element as HTMLInputElement).type.toLowerCase());

    return (element as HTMLElement).isContentEditable === true || element.closest('[contenteditable]:not([contenteditable="false"])') !== null || element.closest(TEXT_ROLES) !== null;
}

/**
 * Whether a dialog or popover is in the way: the key came from inside one, or a `Modal` overlay is open anywhere.
 * `Modal` does not make the page behind it inert, so keys typed outside it still reach the page.
 */
function isOverlayOpen(target: EventTarget | null): boolean {
    return asElement(target)?.closest(OVERLAYS) != null || document.querySelector('[data-modal-overlay]') !== null;
}

/** A key event that must not be looked at at all: IME composition (including Safari's late Enter), dead keys, synthetic events with no key. */
function isInvisible(event: KeyboardEvent): boolean {
    return typeof event.key !== 'string' || event.isComposing || event.keyCode === 229 || event.key === 'Process' || event.key === 'Dead';
}

/** AltGr arrives as Ctrl+Alt on Windows. Those two flags are an artifact of typing a character, not a command's modifiers. */
function isAltGraph(event: KeyboardEvent): boolean {
    return event.ctrlKey && event.altKey && typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
}

/**
 * What tinykeys matches against. On a layout without Latin letters (Cyrillic, Greek, Hebrew) a letter key reports a letter of that script,
 * so `g` and `$mod+a` would never match; there the key counts as the Latin letter printed on its physical key. Latin layouts (Dvorak, AZERTY) match by the letter they produce.
 */
function layoutNeutral(event: KeyboardEvent): KeyboardEvent {
    const letter = /^Key([A-Z])$/.exec(event.code)?.[1];

    if (!letter || !/^\p{L}$/u.test(event.key) || /^\p{Script=Latin}$/u.test(event.key)) return event;

    return { key: letter.toLowerCase(), code: event.code, getModifierState: (modifier: string) => event.getModifierState(modifier) } as KeyboardEvent;
}

interface Candidate {
    entry: RegisteredCommand;
    sequence: Sequence;
    /** How many presses of the sequence were typed already. */
    typed: number;
}

interface Chord {
    candidates: Candidate[];
    timer: ReturnType<typeof setTimeout>;
}

/** A command that takes a key stops it there, so nothing below it (React Aria type-ahead, collection keys, a native click) sees it. */
function claim(event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
}

/**
 * Listens for key presses once, in the capture phase, and runs the commands of the registry.
 * A command that claims a key calls `preventDefault` and `stopPropagation`, so nothing below (React Aria type-ahead, collection keys) sees it.
 * A key that no live command takes is left alone. Returns the function that removes the listener.
 */
export function installDispatcher(registry: HotkeyRegistry): () => void {
    let chord: Chord | null = null;

    function cancel() {
        if (!chord) return;

        clearTimeout(chord.timer);
        chord = null;
        registry.setPending(null);
    }

    const starts = (): Candidate[] => registry.entries.flatMap(entry => entry.sequences[registry.family].map(sequence => ({ entry, sequence, typed: 0 })));

    /** The presses of the sequence start with this key event, among commands that may run here and now. */
    function matching(candidates: Candidate[], event: KeyboardEvent): Candidate[] {
        const textTarget = isTextTarget(event.target);
        const overlayOpen = isOverlayOpen(event.target);
        const keys = layoutNeutral(event);
        const matched = candidates.filter(({ entry, sequence, typed }) => {
            const { command } = entry;

            return matchKeybindingPress(keys, sequence.presses[typed])
                && (!textTarget || command.inInputs)
                && (!overlayOpen || command.inOverlays)
                && registry.isEntryLive(entry);
        });

        // The innermost scope wins when two live commands share keys.
        const depths = matched.map(({ entry }) => registry.scopeDepth(entry.command.scope) ?? -1);
        const innermost = Math.max(...depths);

        return matched.filter((_, index) => depths[index] === innermost);
    }

    function wait(candidates: Candidate[]) {
        if (chord) clearTimeout(chord.timer);

        const [first] = candidates;

        chord = { candidates, timer: setTimeout(cancel, CHORD_TIMEOUT) };
        registry.setPending({
            typed: first.sequence.display.slice(0, first.typed),
            candidates: candidates.map(({ entry, sequence, typed }) => ({ command: entry.command, remaining: sequence.display.slice(typed) })),
        });
    }

    function onKeyDown(event: KeyboardEvent) {
        if (isInvisible(event) || MODIFIER_KEYS.has(event.key)) return;

        const altGraph = isAltGraph(event);
        let matched: Candidate[] = [];

        if (chord) {
            // A held key neither continues nor breaks a chord. It is the key that started or continued the chord, so it stays claimed.
            if (event.repeat) {
                claim(event);

                return;
            }

            if (event.key === 'Escape') {
                cancel();
                claim(event);

                return;
            }

            matched = altGraph ? [] : matching(chord.candidates, event);

            // The key does not continue the chord: the chord is over, and the key may still start a command of its own.
            if (!matched.length) cancel();
        }

        if (!matched.length && !altGraph) matched = matching(starts(), event);

        if (!matched.length) return;

        // The command claims the key, even a repeat it will not run for: it must not fall through to type-ahead or a native click.
        claim(event);

        const advanced = matched.map(candidate => ({ ...candidate, typed: candidate.typed + 1 }));
        const done = advanced.find(({ sequence, typed }) => typed === sequence.presses.length);

        if (event.repeat) {
            if (done?.entry.command.repeat) done.entry.command.handler(event);

            return;
        }

        if (done) {
            // The chord is over before the handler runs, so a handler that throws cannot leave it pending.
            cancel();
            done.entry.command.handler(event);

            return;
        }

        wait(advanced);
    }

    const listener = (event: Event) => onKeyDown(event as KeyboardEvent);

    document.addEventListener('keydown', listener, true);

    return () => {
        document.removeEventListener('keydown', listener, true);
        cancel();
    };
}
