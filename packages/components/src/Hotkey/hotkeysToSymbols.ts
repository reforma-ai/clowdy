import { capitalize } from '@clowdy/lib';

export type HotkeyValue = string | readonly string[];

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

const COMMAND_SYMBOL = isMac ? '⌘' : 'Ctrl';
const ALT_SYMBOL = isMac ? '⌥' : 'Alt';
const CONTROL_SYMBOL = isMac ? '⌃' : 'Ctrl';
const DEL_SYMBOL = isMac ? '⌫' : 'Delete';
const BACKSPACE_SYMBOL = isMac ? '⌫' : 'Backspace';
const SHIFT_SYMBOL = isMac ? '⇧' : 'Shift';
const RETURN_SYMBOL = 'Enter';
const BACKSLASH_SYMBOL = '\\';
const ESCAPE_SYMBOL = 'Esc';

const HOTKEY_SYMBOLS = {
    up: '↑',
    arrowup: '↑',
    down: '↓',
    arrowdown: '↓',
    left: '←',
    arrowleft: '←',
    right: '→',
    arrowright: '→',
    plus: '+',
    minus: '-',

    // MacOS
    command: '⌘',
    option: '⌥',
    control: '⌃',

    // Windows / Linux / MacOS
    meta: COMMAND_SYMBOL,
    mod: COMMAND_SYMBOL,
    shift: SHIFT_SYMBOL,
    cmd: COMMAND_SYMBOL,
    alt: ALT_SYMBOL,
    backslash: BACKSLASH_SYMBOL,
    backspace: BACKSPACE_SYMBOL,
    delete: DEL_SYMBOL,
    ctrl: CONTROL_SYMBOL,
    enter: RETURN_SYMBOL,
    return: RETURN_SYMBOL,
    escape: ESCAPE_SYMBOL,
    esc: ESCAPE_SYMBOL,
    space: 'Space',
    spacebar: 'Space',
    tab: 'Tab',
    pageup: 'Page Up',
    pagedown: 'Page Down',

    // Punctuation, under the names `KeyboardEvent.code` gives it as well as the character itself
    comma: ',',
    period: '.',
    slash: '/',
    semicolon: ';',
    quote: '\'',
    backquote: '`',
    equal: '=',
    bracketleft: '[',
    bracketright: ']',
    question: '?',
} as const;

/** Transforms a hotkey identifier into readable key labels. */
export function hotkeysToSymbols(hotkey: HotkeyValue): string[] {
    return getHotkeyKeys(hotkey)
        .filter(Boolean)
        .map((key) => {
            const normalizedKey = key.toLowerCase();

            if (normalizedKey in HOTKEY_SYMBOLS) {
                return HOTKEY_SYMBOLS[normalizedKey as keyof typeof HOTKEY_SYMBOLS];
            }

            return capitalize(normalizedKey);
        });
}

function getHotkeyKeys(hotkey: HotkeyValue): string[] {
    if (typeof hotkey !== 'string') {
        return [...hotkey];
    }

    if (hotkey.length <= 1) {
        return [hotkey];
    }

    return hotkey.split(/[_\s+]+/);
}
