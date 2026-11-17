import { Close, Search } from '@clowdy/icons/14';
import { useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';

import { Button } from '../Button';
import { filterSlots } from '../Slot';
import { Input, INPUT_CONTROL_AFFIX, type InputProps, type InputSize } from './Input';

export interface SearchInputProps extends Omit<InputProps, 'type' | 'prefix' | 'suffix'> {
    autoComplete?: string;
    placeholder?: string;
    ref?: Ref<HTMLInputElement>;
    /**
     * Override prefix / suffix via slots (`slot="prefix"` / `slot="suffix"`).
     * Default prefix is the search icon; default suffix is the clear button when non-empty.
     */
    children?: ReactNode;
}

const ICON_SIZE_MAP: Record<InputSize, number> = {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 20,
};

/**
 * Search field with a default search prefix icon and a clear suffix.
 * Pass `slot="prefix"` / `slot="suffix"` children to replace either default.
 */
export function SearchInput({
    children,
    size = 'md',
    isDisabled,
    value,
    defaultValue,
    onChange,
    onKeyDown,
    autoComplete,
    ...props
}: SearchInputProps) {
    const isControlled = value !== undefined;
    const [uncontrolledValue, setUncontrolledValue] = useState(() => String(defaultValue ?? ''));
    const currentValue = isControlled ? String(value ?? '') : uncontrolledValue;
    const iconSize = ICON_SIZE_MAP[size];

    const handleChange = (next: string) => {
        if (!isControlled) {
            setUncontrolledValue(next);
        }

        onChange?.(next as never);
    };

    const clear = () => handleChange('');

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape' && currentValue) {
            event.preventDefault();
            clear();
        }

        (onKeyDown as ((event: KeyboardEvent<HTMLInputElement>) => void) | undefined)?.(event);
    };

    const prefix = filterSlots(
        children,
        'prefix',
        <Search slot="prefix" aria-hidden size={ iconSize } />
    );

    const suffix = filterSlots(
        children,
        'suffix',
        currentValue
            ? (
                <Button
                    slot="suffix"
                    data-input-affix={ INPUT_CONTROL_AFFIX }
                    type="button"
                    variant="filling"
                    size="xs"
                    iconOnly
                    isDisabled={ isDisabled }
                    tooltip="Clear"
                    onPress={ clear }
                >
                    <Close aria-hidden size={ iconSize } />
                </Button>
            )
            : null
    );

    const inputProps = {
        ...props,
        size,
        type: 'search' as const,
        isDisabled,
        value: currentValue,
        onChange: handleChange,
        onKeyDown: handleKeyDown,
        autoComplete: autoComplete ?? 'off',
    } as InputProps;

    return (
        <Input { ...inputProps }>
            { prefix }
            { suffix }
        </Input>
    );
}

SearchInput.displayName = 'SearchInput';
