import { cn, mergeRefs } from '@clowdy/lib';
import { useEffect, useRef, useState, type Ref } from 'react';

import { For } from '../For';
import styles from './CodeInput.module.css';

export type CodeInputProps = {
    value: string;
    /** Digits only, at most `length`: a pasted `123 456` arrives as `123456`. */
    onChange: (value: string) => void;
    /** Enter in the field. */
    onSubmit?: () => void;
    length?: number;
    /** `lg` is the large field height. `md` is a normal field height. Both fill the row. */
    size?: 'md' | 'lg';
    autoFocus?: boolean;
    isDisabled?: boolean;
    /** Keeps focus and the digits while a code is checked. */
    isReadOnly?: boolean;
    isInvalid?: boolean;
    id?: string;
    name?: string;
    'aria-label': string;
    ref?: Ref<HTMLInputElement>;
    className?: string;
};

/**
 * A numeric one-time code, one box per digit. A single real input lies over the boxes, so typing, paste, the
 * browser's `one-time-code` autofill, password managers and the arrow keys work as in any field; the boxes only draw
 * its digits and where its caret or selection is.
 */
export function CodeInput({
    value,
    onChange,
    onSubmit,
    length = 6,
    size = 'lg',
    autoFocus,
    isDisabled,
    isReadOnly,
    isInvalid,
    ref,
    className,
    ...aria
}: CodeInputProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [isFocused, setIsFocused] = useState(false);
    // The field's own selection, so the boxes show where the caret is, or which digits are selected.
    const [selection, setSelection] = useState({ start: 0, end: 0 });
    const digits = value.slice(0, length);
    // Never past the digits: the value can shrink under the caret, as when a refused code is cleared.
    const caret = Math.min(selection.start, digits.length, length - 1);
    const isActive = (index: number) => (selection.end > selection.start
        ? index >= selection.start && index < selection.end
        : index === caret);

    const trackSelection = (input: HTMLInputElement) => setSelection({
        start: input.selectionStart ?? input.value.length,
        end: input.selectionEnd ?? input.value.length,
    });

    // Past Modal.open(), which moves focus to the dialog after mount.
    useEffect(() => {
        if (!autoFocus) {
            return;
        }

        const timer = setTimeout(() => inputRef.current?.focus(), 50);

        return () => clearTimeout(timer);
    }, [autoFocus]);

    return (
        <div
            className={ cn(styles.root, className) }
            data-size={ size }
            data-disabled={ isDisabled || undefined }
            data-invalid={ isInvalid || undefined }
        >
            <For each={ Array.from({ length }, (_, index) => index) }>
                { index => (
                    <div
                        key={ index }
                        className={ styles.box }
                        data-active={ (isFocused && isActive(index)) || undefined }
                        data-filled={ index < digits.length || undefined }
                        aria-hidden="true"
                    >
                        { digits[index] }
                    </div>
                ) }
            </For>
            <input
                { ...aria }
                ref={ mergeRefs(inputRef, ref) }
                className={ styles.input }
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                spellCheck={ false }
                // No maxLength: it would cut a pasted `123 456` before the space is dropped.
                value={ digits }
                disabled={ isDisabled }
                readOnly={ isReadOnly }
                aria-invalid={ isInvalid || undefined }
                onChange={ (event) => {
                    trackSelection(event.target);
                    onChange(event.target.value.replace(/\D/g, '').slice(0, length));
                } }
                onKeyDown={ (event) => {
                    if (event.key === 'Enter') {
                        onSubmit?.();
                    }
                } }
                onSelect={ event => trackSelection(event.currentTarget) }
                onFocus={ (event) => {
                    setIsFocused(true);
                    trackSelection(event.currentTarget);
                } }
                onBlur={ () => setIsFocused(false) }
            />
        </div>
    );
}

CodeInput.displayName = 'CodeInput';
