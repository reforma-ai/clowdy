import { cn } from '@clowdy/lib';
import { useCallback } from 'react';

import { ControlGroup, ControlGroupField, ControlGroupInput } from '../../ControlGroup';
import { For } from '../../For';
import { Show } from '../../Show';
import { filterSlots, Slot } from '../../Slot';
import styles from '../ColorInput.module.css';
import { normalizeAlpha, parseCssColorChannels, serializeCssColorChannels } from '../format';
import { colorInputValueToString } from '../value';
import { CssColorPreview } from './CssColorPreview';
import { CHANNEL_NUMBER_FORMAT, channelGroupTemplateColumns } from './channelFields';
import { HiddenColorInput } from './HiddenColorInput';

import type { ColorInputEditorProps, ColorInputRenderState } from '../ColorInput';
import type { ParsedCssColorChannels } from '../format';

export function CssFunctionChannelEditor({
    ref,
    inputRef,
    currentValue,
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
}: ColorInputEditorProps) {
    const parsed = parseCssColorChannels(colorInputValueToString(currentValue), editorFormat)!;

    const emitChannels = useCallback(
        (nextChannels: ParsedCssColorChannels) => {
            const nextValue = serializeCssColorChannels(nextChannels);

            onValueChange(nextValue, {
                value: nextValue,
                color: null,
                alpha: nextChannels.alpha,
                format: requestedFormat,
                inputValue: nextValue,
            });
        },
        [onValueChange, requestedFormat]
    );

    const updateChannel = useCallback(
        (index: number, value: number) => {
            const channels = parsed.channels.map((channel, channelIndex) =>
                channelIndex === index ? { ...channel, value } : channel
            );

            emitChannels({ ...parsed, channels });
        },
        [emitChannels, parsed]
    );

    const updateAlpha = useCallback(
        (alpha: number) => {
            emitChannels({ ...parsed, alpha: normalizeAlpha(alpha) });
        },
        [emitChannels, parsed]
    );

    const channelColumns = parsed.channels.length + Number(showAlpha);
    const templateColumns = channelGroupTemplateColumns(channelColumns);
    const submittedValue = serializeCssColorChannels(parsed);
    const renderedChildren =
        typeof children === 'function'
            ? children({
                  value: submittedValue,
                  color: null,
                  alpha: parsed.alpha,
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
                <For each={parsed.channels}>
                    {(channel, index) => (
                        <ControlGroupField key={channel.key}>
                            <ControlGroupField.Label>{channel.label}</ControlGroupField.Label>
                            <ControlGroupInput
                                type="number"
                                inputRef={index === 0 ? inputRef : undefined}
                                aria-label={channel.label}
                                value={channel.value}
                                minValue={channel.minValue}
                                maxValue={channel.maxValue}
                                step={channel.step}
                                interactionStep={channel.interactionStep}
                                roundTo={channel.roundTo}
                                formatOptions={CHANNEL_NUMBER_FORMAT}
                                autoFocus={index === 0 ? autoFocus : undefined}
                                isDisabled={isDisabled}
                                isReadOnly={isReadOnly}
                                onChange={next => updateChannel(index, next)}
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
                            value={parsed.alpha}
                            minValue={0}
                            maxValue={100}
                            formatOptions={CHANNEL_NUMBER_FORMAT}
                            isDisabled={isDisabled}
                            isReadOnly={isReadOnly}
                            onChange={updateAlpha}
                        />
                    </ControlGroupField>
                </Show>
            </ControlGroup>

            <HiddenColorInput name={name} form={form} value={submittedValue} isDisabled={isDisabled} />
        </div>
    );
}
