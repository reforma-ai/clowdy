import { cn } from '@clowdy/lib';
import { useColorSwatch } from 'react-aria';

import { Button } from '../Button';
import { Show } from '../Show';
import { parseColorValue } from '../utils/colorValue';
import styles from './Swatch.module.css';

import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import type { AriaColorSwatchProps } from 'react-aria';
import type { Color } from 'react-stately';
import type { ButtonProps } from '../Button';
import type { InputSize } from '../Input';

export type SwatchSize = InputSize;

export interface SwatchProps extends HTMLAttributes<HTMLDivElement> {
    ref?: Ref<HTMLDivElement | HTMLButtonElement | HTMLAnchorElement | null>;
    size?: SwatchSize;
    isDisabled?: boolean;
    onPress?: ButtonProps['onPress'];
    children?: ReactNode;
}

export interface ColorSwatchProps extends Omit<AriaColorSwatchProps, 'color'> {
    ref?: Ref<HTMLDivElement | HTMLButtonElement | HTMLAnchorElement | null>;
    slot?: string;
    color?: string | Color | null;
    size?: SwatchSize;
    isDisabled?: boolean;
    className?: string;
    onPress?: ButtonProps['onPress'];
}

export interface ImageSwatchProps extends Omit<SwatchProps, 'children'> {
    src?: string | null;
    alt?: string;
}

export function Swatch({
    ref,
    size = 'sm',
    isDisabled,
    onPress,
    className,
    children,
    ...props
}: SwatchProps) {
    if (onPress) {
        const { role: _role, onClick: _onClick, ...buttonProps } = props;

        return (
            <Button
                { ...(buttonProps as ButtonProps) }
                ref={ ref as Ref<HTMLButtonElement | HTMLAnchorElement | null> }
                variant="inline"
                color="inherit"
                size="unset"
                className={ cn(styles.swatch, styles.swatchButton, className) }
                data-size={ size }
                data-disabled={ isDisabled || undefined }
                isDisabled={ isDisabled }
                onPress={ onPress }
            >
                { children }
            </Button>
        );
    }

    return (
        <div
            ref={ ref as Ref<HTMLDivElement | null> }
            className={ cn(styles.swatch, className) }
            data-size={ size }
            data-disabled={ isDisabled || undefined }
            { ...props }
        >
            { children }
        </div>
    );
}

export function ColorSwatch({
    ref,
    color,
    size = 'sm',
    isDisabled,
    className,
    slot: _slot,
    ...props
}: ColorSwatchProps) {
    const parsedColor = parseColorValue(color);

    if (!parsedColor) {
        const { colorName: _colorName, ...domProps } = props;
        const css = typeof color === 'string' ? color.trim() : '';

        return (
            <Swatch
                ref={ ref }
                size={ size }
                isDisabled={ isDisabled }
                className={ className }
                { ...domProps }
                aria-label={ domProps['aria-label'] ?? (css ? 'Selected color' : 'No color') }
            >
                <span className={ styles.checker } aria-hidden />
                <Show
                    when={ css }
                    fallback={ <span className={ styles.empty } aria-hidden /> }
                >
                    <span
                        className={ styles.cssColor }
                        style={ { '--clowdy-swatch-value': css } as CSSProperties }
                        aria-hidden
                    />
                </Show>
            </Swatch>
        );
    }

    return (
        <ColorSwatchInner
            ref={ ref }
            color={ parsedColor }
            size={ size }
            isDisabled={ isDisabled }
            className={ className }
            { ...props }
        />
    );
}

function ColorSwatchInner({
    ref,
    color,
    size,
    isDisabled,
    className,
    onPress,
    ...props
}: Omit<ColorSwatchProps, 'color' | 'slot'> & { color: Color }) {
    const { colorSwatchProps, color: parsedColor } = useColorSwatch({
        ...props,
        color,
    });
    const opaqueColor = withOpaqueAlpha(parsedColor).toString('css');
    const alphaColor = parsedColor.toString('css');

    return (
        <Swatch
            ref={ ref }
            size={ size }
            isDisabled={ isDisabled }
            className={ className }
            { ...colorSwatchProps }
            onPress={ onPress }
        >
            <span className={ styles.checker } aria-hidden />
            <span className={ styles.colorFill } aria-hidden>
                <span
                    className={ styles.colorHalf }
                    data-side="left"
                    style={ { '--clowdy-swatch-value': opaqueColor } as CSSProperties }
                />
                <span
                    className={ styles.colorHalf }
                    data-side="right"
                    style={ { '--clowdy-swatch-value': alphaColor } as CSSProperties }
                />
            </span>
        </Swatch>
    );
}

export function ImageSwatch({
    src,
    alt = '',
    ...props
}: ImageSwatchProps) {
    return (
        <Swatch { ...props }>
            {
                src
                    ? <img className={ styles.image } src={ src } alt={ alt } />
                    : <span className={ styles.empty } aria-hidden />
            }
        </Swatch>
    );
}

function withOpaqueAlpha(color: Color): Color {
    try {
        return color.withChannelValue('alpha', 1);
    }
    catch {
        return color;
    }
}

Swatch.displayName = 'Swatch';
ColorSwatch.displayName = 'ColorSwatch';
ImageSwatch.displayName = 'ImageSwatch';
