import { useCallback, useMemo, useState } from 'react';

import {
    canEditColorChannels,
    isColorObjectEditorFormat,
    isParsedColorEditorFormat,
    resolveColorInputEditorFormat,
    type ColorInputEditorFormat,
    type ColorInputFormat,
} from './format';
import { ColorObjectChannelEditor } from './ui/ColorObjectChannelEditor';
import { CssFunctionChannelEditor } from './ui/CssFunctionChannelEditor';
import { HexColorEditor } from './ui/HexColorEditor';
import { RawColorEditor } from './ui/RawColorEditor';
import {
    colorInputValueToString,
    parseColorInputValue,
    type ColorInputChangeDetails,
    type ParsedColorInputValue,
} from './value';

import type { HTMLAttributes, ReactNode, Ref } from 'react';
import type { Color } from 'react-stately';
import type { InputSize } from '../Input';

const FALLBACK_CHANNEL_COLOR = parseColorInputValue('#000000');

export type ColorInputSize = InputSize;
export type ColorInputVariant = 'filled' | 'bordered';
export type ColorInputValue = string | Color | null;

export interface ColorInputRenderState extends ColorInputChangeDetails {
    inputValue: string;
    isInvalid: boolean;
}

export interface ColorInputProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'defaultValue' | 'onChange'> {
    ref?: Ref<HTMLDivElement | null>;
    inputRef?: Ref<HTMLInputElement | null>;
    value?: ColorInputValue;
    defaultValue?: ColorInputValue;
    onChange?: (value: string | null, details: ColorInputChangeDetails) => void;
    size?: ColorInputSize;
    variant?: ColorInputVariant;
    format?: ColorInputFormat;
    showAlpha?: boolean;
    placeholder?: string;
    isDisabled?: boolean;
    isReadOnly?: boolean;
    isInvalid?: boolean;
    isActive?: boolean;
    autoFocus?: boolean;
    name?: string;
    form?: string;
    children?: ReactNode | ((state: ColorInputRenderState) => ReactNode);
}

export interface ColorInputEditorProps extends Omit<ColorInputProps, 'value' | 'defaultValue' | 'onChange'> {
    currentValue: ColorInputValue | undefined;
    editorFormat: ColorInputEditorFormat;
    requestedFormat: ColorInputFormat;
    onValueChange: (value: string | null, details: ColorInputChangeDetails) => void;
}

export function ColorInput({
    value,
    defaultValue = '#000000',
    onChange,
    format = 'auto',
    ...props
}: ColorInputProps) {
    const isControlled = value !== undefined;
    const [localValue, setLocalValue] = useState<ColorInputValue>(defaultValue);
    const currentValue = isControlled ? value : localValue;
    const detectedEditorFormat = resolveColorInputEditorFormat(currentValue, format);
    const parsedColor = useMemo(() => parseColorInputValue(currentValue), [currentValue]);
    const defaultParsedColor = useMemo(() => parseColorInputValue(defaultValue), [defaultValue]);
    const editorFormat = shouldUseRawEditor(currentValue, detectedEditorFormat, parsedColor.color)
        ? 'raw'
        : detectedEditorFormat;

    const handleValueChange = useCallback((nextValue: string | null, details: ColorInputChangeDetails) => {
        if (!isControlled) {
            setLocalValue(nextValue);
        }

        onChange?.(nextValue, details);
    }, [isControlled, onChange]);

    const editorProps: ColorInputEditorProps = {
        ...props,
        currentValue,
        editorFormat,
        requestedFormat: format,
        onValueChange: handleValueChange,
    };

    if (editorFormat === 'raw') {
        return <RawColorEditor { ...editorProps } />;
    }

    if (isColorObjectEditorFormat(editorFormat)) {
        return (
            <ColorObjectChannelEditor
                { ...editorProps }
                editorFormat={ editorFormat }
                parsedColor={ parsedColor.color ?? defaultParsedColor.color ?? FALLBACK_CHANNEL_COLOR.color! }
                parsedAlpha={ resolveChannelEditorAlpha(parsedColor, defaultParsedColor) }
            />
        );
    }

    if (editorFormat !== 'hex') {
        return <CssFunctionChannelEditor { ...editorProps } />;
    }

    return <HexColorEditor { ...editorProps } />;
}

function resolveChannelEditorAlpha(
    parsedColor: ParsedColorInputValue,
    defaultParsedColor: ParsedColorInputValue
): number {
    if (parsedColor.color) {
        return parsedColor.alpha;
    }

    if (defaultParsedColor.color) {
        return defaultParsedColor.alpha;
    }

    return FALLBACK_CHANNEL_COLOR.alpha;
}

function shouldUseRawEditor(value: ColorInputValue | undefined, editorFormat: ColorInputEditorFormat, parsedColor: Color | null): boolean {
    if (editorFormat === 'raw') {
        return true;
    }

    if (isParsedColorEditorFormat(editorFormat)) {
        return Boolean(colorInputValueToString(value)) && !parsedColor;
    }

    return !canEditColorChannels(value, editorFormat);
}

ColorInput.displayName = 'ColorInput';
