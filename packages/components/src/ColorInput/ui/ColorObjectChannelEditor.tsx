import { cn } from '@clowdy/lib';

import { ControlGroup, ControlGroupField, ControlGroupInput } from '../../ControlGroup';
import { For } from '../../For';
import { Show } from '../../Show';
import { filterSlots, Slot } from '../../Slot';
import styles from '../ColorInput.module.css';
import { normalizeAlpha, serializeColorObject } from '../format';
import { withAlpha } from '../value';
import { CssColorPreview } from './CssColorPreview';
import {
    CHANNEL_NUMBER_FORMAT,
    channelField,
    channelGroupTemplateColumns,
    type EditableColorChannel,
} from './channelFields';
import { HiddenColorInput } from './HiddenColorInput';

import type { Color } from 'react-stately';
import type { ColorInputEditorProps, ColorInputRenderState } from '../ColorInput';
import type { ColorObjectEditorFormat } from '../format';

type ColorObjectChannelDefinition = {
    key: EditableColorChannel;
    label: string;
    minValue: number;
    maxValue: number;
};

type ColorObjectChannelConfig = {
    colorSpace: ColorObjectEditorFormat;
    channels: readonly ColorObjectChannelDefinition[];
};

const COLOR_OBJECT_CHANNEL_CONFIGS: Record<ColorObjectEditorFormat, ColorObjectChannelConfig> = {
    rgb: {
        colorSpace: 'rgb',
        channels: [
            { key: 'red', label: 'R', minValue: 0, maxValue: 255 },
            { key: 'green', label: 'G', minValue: 0, maxValue: 255 },
            { key: 'blue', label: 'B', minValue: 0, maxValue: 255 },
        ],
    },
    hsl: {
        colorSpace: 'hsl',
        channels: [
            { key: 'hue', label: 'H', minValue: 0, maxValue: 360 },
            { key: 'saturation', label: 'S', minValue: 0, maxValue: 100 },
            { key: 'lightness', label: 'L', minValue: 0, maxValue: 100 },
        ],
    },
};

export function ColorObjectChannelEditor({
    ref,
    inputRef,
    currentValue: _currentValue,
    parsedColor,
    parsedAlpha,
    editorFormat,
    requestedFormat,
    size = 'sm',
    variant = 'filled',
    showAlpha = true,
    isDisabled,
    isReadOnly,
    isInvalid,
    isActive,
    autoFocus,
    placeholder: _placeholder,
    name,
    form,
    children,
    className,
    onValueChange,
    ...props
}: Omit<ColorInputEditorProps, 'editorFormat'> & {
    editorFormat: ColorObjectEditorFormat;
    parsedColor: Color;
    parsedAlpha: number;
}) {
    const channelConfig = COLOR_OBJECT_CHANNEL_CONFIGS[editorFormat];
    const formatColor = parsedColor.toFormat(channelConfig.colorSpace);

    const emitColor = (nextColor: Color, nextAlpha = parsedAlpha) => {
        const nextValue = serializeColorObject(nextColor, nextAlpha, requestedFormat, editorFormat);
        const color = withAlpha(nextColor, nextAlpha);

        onValueChange(nextValue, {
            value: nextValue,
            color,
            alpha: normalizeAlpha(nextAlpha),
            format: requestedFormat,
            inputValue: nextValue,
        });
    };

    const fields = channelConfig.channels.map(channel =>
        channelField(
            channel.key,
            channel.label,
            formatColor.getChannelValue(channel.key),
            channel.minValue,
            channel.maxValue
        )
    );
    const channelColumns = fields.length + Number(showAlpha);
    const templateColumns = channelGroupTemplateColumns(channelColumns);
    const submittedValue = serializeColorObject(parsedColor, parsedAlpha, requestedFormat, editorFormat);
    const colorWithAlpha = withAlpha(parsedColor, parsedAlpha);
    const renderedChildren =
        typeof children === 'function'
            ? children({
                  value: submittedValue,
                  color: colorWithAlpha,
                  alpha: parsedAlpha,
                  format: requestedFormat,
                  inputValue: submittedValue,
                  isInvalid: Boolean(isInvalid),
              } satisfies ColorInputRenderState)
            : children;
    const swatchSlot = filterSlots(renderedChildren, 'swatch');
    const prefixSlot = swatchSlot ? (
        <Slot slot="prefix">{swatchSlot}</Slot>
    ) : (
        <CssColorPreview slot="prefix" value={submittedValue} size={size} isDisabled={isDisabled} />
    );

    return (
        <div
            ref={ref}
            className={cn(styles.root, className)}
            data-size={size}
            data-variant={variant}
            data-editor="channels"
            data-color-format={editorFormat}
            data-disabled={isDisabled || undefined}
            data-readonly={isReadOnly || undefined}
            data-invalid={isInvalid || undefined}
            data-active={isActive || undefined}
            {...props}
        >
            <ControlGroup size={size} variant={variant} templateColumns={templateColumns}>
                <For each={fields}>
                    {(field, index) => (
                        <ControlGroupField key={field.key}>
                            <ControlGroupField.Label>{field.label}</ControlGroupField.Label>
                            <ControlGroupInput
                                type="number"
                                inputRef={index === 0 ? inputRef : undefined}
                                aria-label={field.label}
                                value={field.value}
                                minValue={field.minValue}
                                maxValue={field.maxValue}
                                formatOptions={CHANNEL_NUMBER_FORMAT}
                                autoFocus={index === 0 ? autoFocus : undefined}
                                isDisabled={isDisabled}
                                isReadOnly={isReadOnly}
                                onChange={next => emitColor(formatColor.withChannelValue(field.key, next))}
                            >
                                {index === 0 ? prefixSlot : null}
                            </ControlGroupInput>
                        </ControlGroupField>
                    )}
                </For>

                <Show when={showAlpha}>
                    <ControlGroupField>
                        <ControlGroupField.Label>%</ControlGroupField.Label>
                        <ControlGroupInput
                            type="number"
                            aria-label="Alpha"
                            value={parsedAlpha}
                            minValue={0}
                            maxValue={100}
                            formatOptions={CHANNEL_NUMBER_FORMAT}
                            isDisabled={isDisabled}
                            isReadOnly={isReadOnly}
                            onChange={next => emitColor(parsedColor, next)}
                        />
                    </ControlGroupField>
                </Show>
            </ControlGroup>

            <HiddenColorInput name={name} form={form} value={submittedValue} isDisabled={isDisabled} />
        </div>
    );
}
