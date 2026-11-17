import { Input } from '../Input';
import { filterSlots } from '../Slot';
import { ColorSwatch, ImageSwatch, Swatch } from '../Swatch';
import styles from './PreviewInput.module.css';

import type { ReactNode, Ref } from 'react';
import type { InputSize, InputVariant, TextInputProps } from '../Input';
import type { ColorSwatchProps, ImageSwatchProps, SwatchProps } from '../Swatch';

export type PreviewInputSize = InputSize;
export type PreviewInputVariant = InputVariant;
export type PreviewInputPreview
    = | PreviewInputColorPreview
      | PreviewInputImagePreview
      | PreviewInputCustomPreview;

export interface PreviewInputColorPreview {
    kind: 'color';
    ref?: ColorSwatchProps['ref'];
    color?: ColorSwatchProps['color'];
    ariaLabel?: string;
    isDisabled?: boolean;
    onPress?: ColorSwatchProps['onPress'];
}

export interface PreviewInputImagePreview {
    kind: 'image';
    ref?: ImageSwatchProps['ref'];
    src?: ImageSwatchProps['src'];
    alt?: ImageSwatchProps['alt'];
    ariaLabel?: string;
    isDisabled?: boolean;
    onPress?: ImageSwatchProps['onPress'];
}

export interface PreviewInputCustomPreview {
    kind: 'custom';
    ref?: SwatchProps['ref'];
    content?: ReactNode;
    ariaLabel?: string;
    isDisabled?: boolean;
    onPress?: SwatchProps['onPress'];
}

export interface PreviewInputProps extends Omit<TextInputProps, 'children' | 'className' | 'size' | 'type'> {
    ref?: Ref<HTMLDivElement | null>;
    className?: string;
    size?: PreviewInputSize;
    variant?: PreviewInputVariant;
    preview?: PreviewInputPreview;
    action?: ReactNode;
    children?: ReactNode;
    isActive?: boolean;
    isInvalid?: boolean;
    autoSelect?: boolean;
    spellCheck?: boolean;
    onPress?: () => void;
    onSubmit?: () => void;
}

export function PreviewInput({
    ref,
    size = 'sm',
    variant = 'filled',
    value,
    placeholder,
    preview,
    action,
    children,
    isDisabled,
    ...props
}: PreviewInputProps) {
    const previewSlot = preview ? renderPreview(preview, size, Boolean(isDisabled)) : null;
    const actionSlot = action ?? filterSlots(children, 'action');

    return (
        <Input
            ref={ ref }
            type="text"
            value={ value }
            placeholder={ placeholder }
            size={ size }
            variant={ variant }
            isDisabled={ isDisabled }
            { ...props }
        >
            {
                previewSlot
                    ? <span slot="prefix" className={ styles.previewSlot } data-size={ size }>{ previewSlot }</span>
                    : null
            }

            {actionSlot ? <span slot="suffix">{ actionSlot }</span> : null}
        </Input>
    );
}

PreviewInput.displayName = 'PreviewInput';

function renderPreview(
    preview: PreviewInputPreview,
    size: PreviewInputSize,
    isInputDisabled: boolean
): ReactNode {
    const isDisabled = preview.isDisabled ?? isInputDisabled;

    if (preview.kind === 'image') {
        return (
            <ImageSwatch
                ref={ preview.ref }
                size={ size }
                src={ preview.src }
                alt={ preview.alt }
                isDisabled={ isDisabled }
                aria-label={ preview.ariaLabel }
                onPress={ preview.onPress }
            />
        );
    }

    if (preview.kind === 'custom') {
        return (
            <Swatch
                ref={ preview.ref }
                size={ size }
                isDisabled={ isDisabled }
                aria-label={ preview.ariaLabel }
                onPress={ preview.onPress }
            >
                { preview.content }
            </Swatch>
        );
    }

    return (
        <ColorSwatch
            ref={ preview.ref }
            size={ size }
            color={ preview.color }
            isDisabled={ isDisabled }
            aria-label={ preview.ariaLabel }
            onPress={ preview.onPress }
        />
    );
}
