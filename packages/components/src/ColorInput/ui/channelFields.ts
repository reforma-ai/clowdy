import { formatNumber } from '../format';

export const CHANNEL_NUMBER_FORMAT: Intl.NumberFormatOptions = {
    style: 'decimal',
    useGrouping: false,
    maximumFractionDigits: 4,
};

export type EditableColorChannel = 'red' | 'green' | 'blue' | 'hue' | 'saturation' | 'lightness';

export function channelField(
    key: EditableColorChannel,
    label: string,
    value: number,
    minValue: number,
    maxValue: number
) {
    return {
        key,
        label,
        value: Number(formatNumber(value, 2)),
        minValue,
        maxValue,
    };
}

export function channelGroupTemplateColumns(columnCount: number): string {
    const inputMinWidth = 'calc(3ch + (var(--clowdy-control-group-input-padding-inline) * 2))';
    const previewInputMinWidth = [
        'var(--clowdy-control-group-prefix-size)',
        'var(--clowdy-control-group-input-gap)',
        inputMinWidth,
    ].join(' + ');

    if (columnCount <= 1) {
        return `minmax(calc(${previewInputMinWidth}), 1fr)`;
    }

    return `minmax(calc(${previewInputMinWidth}), 1.35fr) repeat(${columnCount - 1}, minmax(${inputMinWidth}, 1fr))`;
}
