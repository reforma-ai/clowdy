import { Eye, EyeClosed } from '@clowdy/icons/20';
import { type Ref, useState } from 'react';

import { Button } from '../Button';
import { INPUT_CONTROL_AFFIX, Input, type InputProps } from './Input';

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'suffix'> {
    autoComplete?: string;
    placeholder?: string;
    ref?: Ref<HTMLInputElement>;
}

const ICON_SIZE_MAP = {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 20,
};

export function PasswordInput({ className, isDisabled, size = 'md', ...props }: PasswordInputProps) {
    const [showPassword, setShowPassword] = useState(false);

    const handleTogglePassword = () => {
        setShowPassword(prev => !prev);
    };

    const inputProps = {
        ...props,
        size,
        type: showPassword ? 'text' : 'password',
        className,
        isDisabled,
        autoComplete: props.autoComplete ?? 'current-password',
    } as InputProps;

    return (
        <Input {...inputProps}>
            <Button
                slot="suffix"
                data-input-affix={INPUT_CONTROL_AFFIX}
                type="button"
                variant="filling"
                size="xs"
                iconOnly
                isDisabled={isDisabled}
                tooltip={showPassword ? 'Hide password' : 'Show password'}
                onPress={handleTogglePassword}
            >
                {showPassword ? (
                    <Eye aria-hidden="true" size={ICON_SIZE_MAP[size]} />
                ) : (
                    <EyeClosed aria-hidden="true" size={ICON_SIZE_MAP[size]} />
                )}
            </Button>
        </Input>
    );
}

PasswordInput.displayName = 'PasswordInput';
