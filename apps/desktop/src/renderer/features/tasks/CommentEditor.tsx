import { Button } from '@clowdy/components/Button';
import { tooltipWithHotkey } from '@clowdy/components/Hotkey';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import styles from './CommentEditor.module.css';
import { MarkdownPlate } from './MarkdownPlate';

export interface CommentEditorProps {
    /** What the editor starts with, and goes back to once a send was taken: nothing for a new comment, the body for an edit. */
    initial?: string;
    /** An unsent text kept elsewhere, which the editor starts with in place of `initial` (read once, when the editor appears). */
    draft?: string;
    /** Hears the text of the editor each time it changes, and `initial` once a send was taken, to keep it as a `draft`. */
    onDraftChange?: (text: string) => void;
    'aria-label': string;
    /** What the button that sends says: `Send`, `Save`. */
    submitLabel: string;
    /** Sends the text, trimmed, and resolves to whether it was taken. A text that was not stays in the editor. */
    onSubmit: (body: string) => Promise<boolean>;
    /** Gives the edit up. Without it there is no Cancel button and Escape does nothing: a composer is always there. */
    onCancel?: () => void;
    /** Puts the keyboard at the end of the text when the editor appears: for an edit the person has just asked for, which has taken the focus from the button they pressed. */
    autoFocus?: boolean;
}

/**
 * A comment being written or edited: the Markdown editor with a button, and `Cmd+Enter` (`Ctrl+Enter`) to send. The text is trimmed, and an empty one cannot be
 * sent. A text the daemon took leaves the editor as it started, which is empty for a composer. The editor takes the key first, so the line break it would make
 * of `Cmd+Enter` is not made.
 */
export function CommentEditor({
    initial = '',
    draft,
    onDraftChange,
    'aria-label': ariaLabel,
    submitLabel,
    onSubmit,
    onCancel,
    autoFocus,
}: CommentEditorProps) {
    const frame = useRef<HTMLDivElement>(null);
    const [text, setText] = useState(draft ?? initial);
    const [isPending, setIsPending] = useState(false);
    const body = text.trim();
    const canSubmit = body !== '' && !isPending;

    useEffect(() => {
        const field = autoFocus ? frame.current?.querySelector<HTMLElement>('[contenteditable="true"]') : null;

        if (!field) return;

        field.focus();

        const selection = field.ownerDocument.getSelection();

        selection?.selectAllChildren(field);
        selection?.collapseToEnd();
    }, [autoFocus]);

    const change = (value: string) => {
        setText(value);
        onDraftChange?.(value);
    };

    const submit = async () => {
        if (!canSubmit) return;

        setIsPending(true);

        try {
            if (await onSubmit(body)) change(initial);
        } finally {
            setIsPending(false);
        }
    };

    // In the capture phase, before the editor's own keys: Cmd+Enter is a line break to it.
    const onKeyDownCapture = (event: KeyboardEvent) => {
        // The Enter that ends an IME composition confirms the text typed, it does not send.
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;

        // A key in a popover of the toolbar (the link's field) comes through the React tree but is not the editor's: Escape there closes the popover, not the edit.
        if (!event.currentTarget.contains(event.target as Node)) return;

        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            void submit();
        } else if (event.key === 'Escape' && onCancel) {
            event.stopPropagation();
            onCancel();
        }
    };

    return (
        <div ref={frame} className={styles.editor} onKeyDownCapture={onKeyDownCapture}>
            <MarkdownPlate isBounded value={text} aria-label={ariaLabel} onChange={change} />
            <div className={styles.actions}>
                {onCancel && (
                    <Button size="sm" variant="bordered" isDisabled={isPending} onPress={onCancel}>
                        Cancel
                    </Button>
                )}
                <Button
                    size="sm"
                    color="primary"
                    isDisabled={!canSubmit}
                    isPending={isPending}
                    tooltip={tooltipWithHotkey(submitLabel, ['mod', 'enter'])}
                    onPress={() => void submit()}
                >
                    {submitLabel}
                </Button>
            </div>
        </div>
    );
}
