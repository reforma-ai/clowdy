import { type KeyboardEvent, useEffect, useState } from 'react';

/**
 * A text field of Settings that saves on blur or Enter, and puts the saved value back on Escape. What the person types is a draft over
 * `value` until `save` says to drop it (`true`), or until `value` itself changes: the daemon's answer, from this window or another one.
 * `save` that returns `false` keeps the draft on screen, as a refused value or one whose answer has not arrived yet.
 */
export function useDraftField(value: string, save: (draft: string) => boolean | Promise<boolean>) {
    const [draft, setDraft] = useState<string>();

    useEffect(() => setDraft(undefined), [value]);

    const commit = async () => {
        if (draft !== undefined && (await save(draft))) setDraft(undefined);
    };

    return {
        draft,
        clear: () => setDraft(undefined),
        fieldProps: {
            value: draft ?? value,
            onChange: setDraft,
            onBlur: () => void commit(),
            onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                else if (event.key === 'Escape') setDraft(undefined);
            },
        },
    };
}
