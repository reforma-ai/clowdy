import { ColorSwatch, Swatch } from '../../Swatch';
import styles from '../ColorInput.module.css';
import { parseColorInputValue, withAlpha } from '../value';

import type { CSSProperties } from 'react';
import type { ColorInputSize } from '../ColorInput';

export function CssColorPreview({
    value,
    size,
    isDisabled,
    slot,
}: {
    value: string;
    size: ColorInputSize;
    isDisabled?: boolean;
    slot?: string;
}) {
    const parsed = parseColorInputValue(value);

    if (parsed.color) {
        return (
            <ColorSwatch
                slot={slot}
                color={withAlpha(parsed.color, parsed.alpha)}
                size={size}
                isDisabled={isDisabled}
                aria-label="Selected color"
            />
        );
    }

    return (
        <Swatch slot={slot} size={size} isDisabled={isDisabled} aria-label="Selected color">
            <CssColorPreviewContent value={value} />
        </Swatch>
    );
}

export function CssColorPreviewContent({ value }: { value: string }) {
    return (
        <span className={styles.cssPreview} aria-hidden>
            <span className={styles.cssPreviewChecker} />
            <span
                className={styles.cssPreviewColor}
                style={{ '--clowdy-color-input-preview': value || 'transparent' } as CSSProperties}
            />
        </span>
    );
}
