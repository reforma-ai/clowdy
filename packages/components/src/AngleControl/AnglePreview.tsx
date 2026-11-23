import { cn } from '@clowdy/lib';

import styles from './AngleControl.module.css';
import { ANGLE_PREVIEW_GEOMETRY, ANGLE_RING_WIDTH, getPointOnCircle } from './angle';

import type { CSSProperties } from 'react';
import type { AngleControlSize } from './angle';

export interface AnglePreviewProps {
    normalizedDegrees: number;
    size?: AngleControlSize;
    className?: string;
}

export function AnglePreview({ normalizedDegrees, size = 'sm', className }: AnglePreviewProps) {
    const geometry = ANGLE_PREVIEW_GEOMETRY[size];
    const center = geometry.size / 2;
    const handlePoint = getPointOnCircle(normalizedDegrees, geometry.handleRadius, {
        x: center,
        y: center,
    });

    return (
        <span
            className={cn(styles.previewDial, className)}
            style={
                {
                    '--clowdy-angle-handle-size': `${geometry.handleSize}px`,
                    '--clowdy-angle-ring-width': `${ANGLE_RING_WIDTH}px`,
                    '--clowdy-angle-size': `${geometry.size}px`,
                } as CSSProperties
            }
            aria-hidden="true"
        >
            <span className={styles.ring} />
            <span
                className={styles.handle}
                style={{
                    left: handlePoint.x,
                    top: handlePoint.y,
                }}
            />
        </span>
    );
}

AnglePreview.displayName = 'AnglePreview';
