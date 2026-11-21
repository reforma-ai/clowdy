import { Button } from '@clowdy/components/Button';
import { Revert } from '@clowdy/icons/14';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { placeToolbar, readSelection, sameSelection, visibleBounds, type SelectedText } from './selectedMessage';
import styles from './SelectionReply.module.css';

export interface SelectionReplyProps {
    /** The element that holds the messages: only a selection inside one of its messages is offered. Another list on the page has its own. */
    scope: RefObject<HTMLElement | null>;
    /** Reply: called with the selected words as they are drawn. The caller quotes them and moves the focus. */
    onReply: (text: string) => void;
}

/**
 * A floating Reply button over the words the person selected inside one message of the list. One set of listeners on the document serves the whole list, and
 * the selection is read once per frame, so a drag and a key held down cost one read each frame at most. The button is hidden while a mouse button is down (it
 * shows when the button is released, on the selection that is then there), and goes on Escape, a scroll, a resize, and when the selection is gone or no longer
 * inside one message. It stays inside the part of the window the list shows in. A press on it takes neither the focus nor the selection, so the words are
 * still selected when it acts. It quotes what is drawn, not the Markdown it came from: a part of a message cannot be traced back to its source, so a whole
 * message is quoted from its row instead.
 */
export function SelectionReply({ scope, onReply }: SelectionReplyProps) {
    const [selected, setSelected] = useState<SelectedText | null>(null);
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let frame = 0;
        let pressed = false;

        const read = () => {
            frame = 0;

            const next = pressed ? null : readSelection(scope.current);

            setSelected(current => (sameSelection(current, next) ? current : next));
        };
        const schedule = () => {
            frame ||= requestAnimationFrame(read);
        };
        const hide = () => {
            cancelAnimationFrame(frame);
            frame = 0;
            setSelected(null);
        };
        const onPointerDown = (event: PointerEvent) => {
            // A press on the button itself acts on the selection that is there.
            if (box.current?.contains(event.target as Node)) return;

            pressed = event.button === 0;
            hide();
        };
        const onPointerEnd = () => {
            pressed = false;
            schedule();
        };
        const onSelectionChange = () => {
            if (!pressed) schedule();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') hide();
        };

        // Capture: a scroll does not bubble, and a press may be stopped by what it lands on.
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointerup', onPointerEnd, true);
        document.addEventListener('pointercancel', onPointerEnd, true);
        document.addEventListener('dragend', onPointerEnd, true);
        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);

        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('pointerup', onPointerEnd, true);
            document.removeEventListener('pointercancel', onPointerEnd, true);
            document.removeEventListener('dragend', onPointerEnd, true);
            document.removeEventListener('selectionchange', onSelectionChange);
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
        };
    }, [scope]);

    // The box is as big as its text and its font make it, so it is placed once it is drawn, before the browser paints it.
    useLayoutEffect(() => {
        const element = box.current;
        const list = scope.current;

        if (!selected || !element || !list) return;

        const { left, top } = placeToolbar(selected, { width: element.offsetWidth, height: element.offsetHeight }, visibleBounds(list));

        element.style.left = `${ left }px`;
        element.style.top = `${ top }px`;
    }, [selected, scope]);

    if (!selected) return null;

    return createPortal(
        // The press of the mouse is what moves the focus and clears the selection; the button's own press handling still sees it.
        <div ref={ box } className={ styles.box } role="toolbar" aria-label="Selected text" onMouseDownCapture={ (event: MouseEvent) => event.preventDefault() }>
            <Button
                variant="filling"
                size="sm"
                preventFocusOnPress
                onPress={ () => {
                    // The selection goes first: the caller moves the focus into the message box, and clearing the selection after that would take its caret.
                    window.getSelection()?.removeAllRanges();
                    setSelected(null);
                    onReply(selected.text);
                } }
            >
                <Revert />
                Reply
            </Button>
        </div>,
        document.body
    );
}
