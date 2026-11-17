import { useCallback, useEffect, useState } from 'react';

import { formatAngleDisplayNumber, formatAngleNumber } from './angle';
import styles from './AngleControl.module.css';

import type { ChangeEvent, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import type { AnglePrecision } from './angle';
import type { AngleState } from './useAngleState';

interface AngleDraftInputProps {
    angle: AngleState;
    precision?: AnglePrecision;
    previewValue?: string | null;
    isDisabled?: boolean;
    isReadOnly?: boolean;
    onCancel?: () => void;
}

const NUMBER_DRAFT_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d*)?$/;

function canEditNumber(value: string): boolean {
    return NUMBER_DRAFT_RE.test(value.trim());
}

function canCommitNumber(value: string): boolean {
    return value.trim() !== '' && Number.isFinite(Number(value));
}

export function AngleDraftInput({
    angle,
    precision,
    previewValue,
    isDisabled,
    isReadOnly,
    onCancel,
}: AngleDraftInputProps) {
    const displayValue = formatAngleDisplayNumber(angle.value, { precision });
    const editValue = formatAngleNumber(angle.value, { precision });
    const [value, setValue] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const isPreviewing = !isEditing && previewValue != null;
    const isInactive = isDisabled || isReadOnly;

    useEffect(() => {
        if (!isEditing) {
            setValue(previewValue ?? displayValue);
        }
    }, [displayValue, isEditing, previewValue]);

    const commit = useCallback((): boolean => {
        if (isInactive) {
            return false;
        }

        if (!canCommitNumber(value)) {
            setValue(displayValue);
            setIsEditing(false);

            return false;
        }

        angle.setValue({ value: Number(value), unit: angle.unit }, 'input', true);
        setIsEditing(false);

        return true;
    }, [angle, displayValue, isInactive, value]);

    const rollback = useCallback(() => {
        setValue(displayValue);
        setIsEditing(false);
    }, [displayValue]);

    const handleFocus = useCallback((event: FocusEvent<HTMLInputElement>) => {
        if (isInactive) {
            return;
        }

        const input = event.currentTarget;

        setIsEditing(true);
        setValue(editValue);
        requestAnimationFrame(() => input.select());
    }, [editValue, isInactive]);

    const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
        if (isInactive) {
            return;
        }

        if (canEditNumber(event.currentTarget.value)) {
            setValue(event.currentTarget.value);
        }
    }, [isInactive]);

    const handleBlur = useCallback(() => {
        if (!commit()) {
            rollback();
        }
    }, [commit, rollback]);

    const stopDialPointerHandling = useCallback((event: PointerEvent<HTMLInputElement> | MouseEvent<HTMLInputElement>) => {
        event.stopPropagation();
    }, []);

    const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            commit();
        }
        else if (event.key === 'Escape') {
            event.preventDefault();
            rollback();
            onCancel?.();
        }
    }, [commit, onCancel, rollback]);

    return (
        <input
            className={ styles.valueInput }
            value={ value }
            disabled={ isDisabled }
            readOnly={ isReadOnly }
            tabIndex={ isReadOnly ? -1 : undefined }
            data-preview={ isPreviewing || undefined }
            aria-label="Angle value"
            inputMode="decimal"
            spellCheck={ false }
            onFocus={ handleFocus }
            onChange={ handleChange }
            onBlur={ handleBlur }
            onPointerDown={ stopDialPointerHandling }
            onMouseDown={ stopDialPointerHandling }
            onClick={ stopDialPointerHandling }
            onKeyDown={ handleKeyDown }
        />
    );
}

AngleDraftInput.displayName = 'AngleDraftInput';
