import { cn } from '@clowdy/lib';
import { useContext, useEffect, useRef } from 'react';
import {
    ColorArea as AriaColorArea,
    type ColorAreaProps as AriaColorAreaProps,
    ColorAreaStateContext,
    ColorThumb,
} from 'react-aria-components';

import { Show } from '../Show';
import styles from './ColorArea.module.css';

import type { PointerEvent, ReactNode, Ref } from 'react';

export interface ColorAreaProps extends Omit<AriaColorAreaProps, 'children' | 'className'> {
    ref?: Ref<HTMLDivElement | null>;
    className?: string;
    thumbClassName?: string;
    children?: ReactNode;
}

export function ColorArea({ ref, className, thumbClassName, children, ...props }: ColorAreaProps) {
    return (
        <AriaColorArea {...props} ref={ref} className={cn(styles.area, className)} data-modal-drag-exclude>
            <Show when={children} fallback={<ColorThumb className={cn(styles.thumb, thumbClassName)} />}>
                {children}
            </Show>
            <Show when={!props.isDisabled}>
                <ColorAreaDrag />
            </Show>
        </AriaColorArea>
    );
}

ColorArea.displayName = 'ColorArea';

/**
 * React Aria snaps the area to a channel step of 1 (one percent of saturation
 * or brightness). On this field that is a few pixels. Pointer drags set the
 * channel from the pointer instead; arrow keys keep the step.
 */
function ColorAreaDrag() {
    const state = useContext(ColorAreaStateContext);
    const stateRef = useRef(state);
    const directionRef = useRef<'ltr' | 'rtl'>('ltr');

    useEffect(() => {
        stateRef.current = state;
    });

    if (!state) {
        return null;
    }

    const apply = (event: PointerEvent<HTMLDivElement>) => {
        const current = stateRef.current;

        if (!current) {
            return;
        }

        const rect = event.currentTarget.getBoundingClientRect();

        if (rect.width === 0 || rect.height === 0) {
            return;
        }

        const visualX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
        const x = directionRef.current === 'rtl' ? 1 - visualX : visualX;

        const { xChannel, yChannel } = current.channels;
        const xRange = current.value.getChannelRange(xChannel);
        const yRange = current.value.getChannelRange(yChannel);

        current.setValue(
            current.value
                .withChannelValue(xChannel, xRange.minValue + x * (xRange.maxValue - xRange.minValue))
                .withChannelValue(yChannel, yRange.minValue + (1 - y) * (yRange.maxValue - yRange.minValue))
        );
    };

    return (
        <div
            className={styles.drag}
            onPointerDown={event => {
                if (event.button !== 0) {
                    return;
                }

                event.stopPropagation();
                directionRef.current = getComputedStyle(event.currentTarget).direction === 'rtl' ? 'rtl' : 'ltr';
                event.currentTarget.setPointerCapture(event.pointerId);
                stateRef.current?.setDragging(true);
                apply(event);
            }}
            onPointerMove={event => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                    return;
                }

                apply(event);
            }}
            onPointerUp={event => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                    return;
                }

                apply(event);
                event.currentTarget.releasePointerCapture(event.pointerId);
                stateRef.current?.setDragging(false);
            }}
            onPointerCancel={() => {
                stateRef.current?.setDragging(false);
            }}
        />
    );
}
