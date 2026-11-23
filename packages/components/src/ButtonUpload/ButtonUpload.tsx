import { useCallback, useRef } from 'react';

import { Button } from '../Button';

import type { ReactNode } from 'react';
import type { ButtonProps } from '../Button';

export interface ButtonUploadProps extends Omit<ButtonProps, 'onPress'> {
    onFileSelect: (file: File) => void;
    accept?: string;
    children: ReactNode;
}

export function ButtonUpload({ onFileSelect, accept, children, ...buttonProps }: ButtonUploadProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    const handlePress = useCallback(() => {
        inputRef.current?.click();
    }, []);

    const handleChange = useCallback(() => {
        const file = inputRef.current?.files?.[0];

        if (file) {
            onFileSelect(file);
            inputRef.current!.value = '';
        }
    }, [onFileSelect]);

    return (
        <>
            <input ref={inputRef} type="file" accept={accept} style={{ display: 'none' }} onChange={handleChange} />
            <Button {...buttonProps} onPress={handlePress}>
                {children}
            </Button>
        </>
    );
}

ButtonUpload.displayName = 'ButtonUpload';
