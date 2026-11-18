/** The parts of a key event that decide whether it sends the message. */
export interface KeyPress {
    key: string;
    shiftKey: boolean;
    /** An input method (IME) is still composing: Enter confirms its candidate and sends nothing. */
    isComposing: boolean;
}

/** Enter sends; Shift+Enter is a new line. */
export function isSendKey({ key, shiftKey, isComposing }: KeyPress): boolean {
    return key === 'Enter' && !shiftKey && !isComposing;
}
