import { Textarea } from '@clowdy/components/Textarea';
import { type KeyboardEvent, type Ref, useRef, useState } from 'react';

import styles from './EditableText.module.css';

export interface EditableTextProps {
    value: string;
    /** Saves the edit; resolves to whether it was accepted. A refused edit goes back to `value`. */
    onCommit: (value: string) => Promise<boolean>;
    'aria-label': string;
    /** The big form, one line at a time, for a title. Otherwise a plain plate for a paragraph. */
    variant: 'title' | 'body';
    placeholder?: string;
    /** An empty edit goes back to `value` instead of saving. */
    required?: boolean;
    /** The field, for a command that puts the keyboard in it. */
    ref?: Ref<HTMLTextAreaElement | null>;
}

/**
 * Text edited in place and saved when the field loses focus. Escape drops the edit; Enter ends it in a title.
 * A change that arrives from outside shows at once, unless the person is typing: their text is kept and saved on blur.
 */
export function EditableText({
    value,
    onCommit,
    variant,
    placeholder,
    required,
    ref,
    'aria-label': ariaLabel,
}: EditableTextProps) {
    const [draft, setDraft] = useState(value);
    const [seen, setSeen] = useState(value);
    const [isFocused, setIsFocused] = useState(false);
    // Escape blurs the field too, and that blur must not save what was just dropped.
    const dropped = useRef(false);

    if (value !== seen) {
        setSeen(value);

        if (!isFocused) setDraft(value);
    }

    const commit = async (next: string) => {
        const text = next.trim();

        if (text === value || (required && text === '')) {
            setDraft(value);

            return;
        }

        setDraft(text);

        if (!(await onCommit(text))) setDraft(value);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Escape') {
            dropped.current = true;
            setDraft(value);
            event.currentTarget.blur();
        } else if (event.key === 'Enter' && variant === 'title') {
            event.preventDefault();
            event.currentTarget.blur();
        }
    };

    return (
        <Textarea
            ref={ref}
            aria-label={ariaLabel}
            variant={variant === 'title' ? 'inline' : 'filled'}
            size="md"
            rows={variant === 'title' ? 1 : 3}
            autoResize
            isResizable={false}
            placeholder={placeholder}
            className={variant === 'title' ? styles.title : undefined}
            textareaClassName={variant === 'title' ? styles.titleText : undefined}
            value={draft}
            onChange={setDraft}
            onFocus={() => setIsFocused(true)}
            onBlur={() => {
                setIsFocused(false);

                if (dropped.current) dropped.current = false;
                else void commit(draft);
            }}
            onKeyDown={onKeyDown}
        />
    );
}
