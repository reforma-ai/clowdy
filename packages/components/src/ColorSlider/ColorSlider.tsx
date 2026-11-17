import { cn } from '@clowdy/lib';
import {
    ColorSlider as AriaColorSlider,
    ColorThumb,
    SliderTrack,
    type ColorSliderProps as AriaColorSliderProps,
    type ColorThumbProps,
    type SliderTrackProps,
} from 'react-aria-components';

import styles from './ColorSlider.module.css';

import type { CSSProperties, ReactNode, Ref } from 'react';

export interface ColorSliderProps extends Omit<AriaColorSliderProps, 'children' | 'className'> {
    ref?: Ref<HTMLDivElement | null>;
    className?: string;
    trackClassName?: string;
    thumbClassName?: string;
    children?: ReactNode;
}


function getDefaultColorSpace(channel: AriaColorSliderProps['channel']): AriaColorSliderProps['colorSpace'] {
    if (channel === 'hue' || channel === 'saturation' || channel === 'brightness') {
        return 'hsb';
    }

    if (channel === 'lightness') {
        return 'hsl';
    }

    if (channel === 'red' || channel === 'green' || channel === 'blue') {
        return 'rgb';
    }

    return undefined;
}

function getTrackStyle(channel: AriaColorSliderProps['channel']): SliderTrackProps['style'] {
    return ({ defaultStyle }) => {
        if (channel !== 'alpha') {
            return defaultStyle;
        }

        const style = defaultStyle ?? {};
        const gradient = getBackgroundLayer(style);

        return {
            ...style,
            background: `${ gradient }, var(--clowdy-color-slider-checker-bg)`,
        };
    };
}

const getThumbStyle: ColorThumbProps['style'] = ({ defaultStyle }) => {
    if (defaultStyle.left != null) {
        return {
            ...defaultStyle,
            top: defaultStyle.top ?? '50%',
            transform: 'translate(-50%, -50%)',
        };
    }

    if (defaultStyle.top != null) {
        return {
            ...defaultStyle,
            left: defaultStyle.left ?? '50%',
            transform: 'translate(-50%, -50%)',
        };
    }

    return defaultStyle;
};

function getBackgroundLayer(style: CSSProperties): string {
    const background = style.background ?? style.backgroundImage;

    return typeof background === 'string' ? background : 'transparent';
}

export function ColorSlider({
    ref,
    className,
    trackClassName,
    thumbClassName,
    children,
    channel,
    colorSpace,
    ...props
}: ColorSliderProps) {
    return (
        <AriaColorSlider
            { ...props }
            ref={ ref }
            channel={ channel }
            colorSpace={ colorSpace ?? getDefaultColorSpace(channel) }
            className={ cn(styles.slider, className) }
            data-channel={ channel }
            data-modal-drag-exclude
        >
            { children ?? (
                <SliderTrack
                    className={ cn(styles.track, trackClassName) }
                    style={ getTrackStyle(channel) }
                >
                    <ColorThumb
                        className={ cn(styles.thumb, thumbClassName) }
                        style={ getThumbStyle }
                    />
                </SliderTrack>
            ) }
        </AriaColorSlider>
    );
}

ColorSlider.displayName = 'ColorSlider';
