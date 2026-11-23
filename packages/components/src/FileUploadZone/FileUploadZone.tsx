import { cn } from '@clowdy/lib';
import { useCallback, useRef, useState } from 'react';

import { Show } from '../Show';
import { Text } from '../Text';
import styles from './FileUploadZone.module.css';

import type { DragEvent, ReactNode } from 'react';

export interface FileUploadZoneProps {
    onFileSelect: (file: File) => void;
    accept?: string;
    maxSize?: number;
    preview?: string | null;
    placeholder?: ReactNode;
    disabled?: boolean;
    className?: string;
}

export function FileUploadZone({
    onFileSelect,
    accept,
    maxSize,
    preview,
    placeholder,
    disabled = false,
    className,
}: FileUploadZoneProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [dragover, setDragover] = useState(false);

    const handleFile = useCallback(
        (file: File) => {
            if (maxSize && file.size > maxSize) {
                return;
            }

            onFileSelect(file);
        },
        [onFileSelect, maxSize]
    );

    const handleDrop = useCallback(
        (e: DragEvent) => {
            e.preventDefault();
            setDragover(false);

            const file = e.dataTransfer.files[0];

            if (file) {
                handleFile(file);
            }
        },
        [handleFile]
    );

    const handleDragOver = useCallback((e: DragEvent) => {
        e.preventDefault();
        setDragover(true);
    }, []);

    const handleDragLeave = useCallback(() => {
        setDragover(false);
    }, []);

    const handleClick = useCallback(() => {
        inputRef.current?.click();
    }, []);

    const handleChange = useCallback(() => {
        const file = inputRef.current?.files?.[0];

        if (file) {
            handleFile(file);
            inputRef.current!.value = '';
        }
    }, [handleFile]);

    return (
        <div
            className={cn(styles.zone, className)}
            data-dragover={dragover || undefined}
            data-disabled={disabled || undefined}
            data-has-preview={preview != null || undefined}
            onClick={handleClick}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
        >
            <input ref={inputRef} type="file" accept={accept} className={styles.input} onChange={handleChange} />

            <Show
                when={preview}
                fallback={
                    <div className={styles.placeholder}>
                        {placeholder ?? (
                            <Text variant="sm" color="secondary">
                                Drop file here or click to upload
                            </Text>
                        )}
                    </div>
                }
            >
                <img src={preview!} alt="Preview" className={styles.preview} />
            </Show>
        </div>
    );
}

FileUploadZone.displayName = 'FileUploadZone';
