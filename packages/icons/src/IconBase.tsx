import { cn } from '@clowdy/lib';
import * as React from 'react';

export type IconProps = React.SVGProps<SVGSVGElement> & {
    title?: string;
    size?: string | number;
    width?: string | number;
    height?: string | number;
};

export type IconWrapperProps = IconProps & {
    children: React.ReactElement;
};

/**
 * Wraps an SVG element and applies normalized props (className, title or hidden, spread rest).
 * Default width/height come from the generated component's default prop values, not from IconWrapper.
 */
export function IconWrapper({ children, title, className, size, width, height, ...rest }: IconWrapperProps): React.ReactElement {
    const mergedProps: React.SVGProps<SVGSVGElement> = {
        className: cn('clowdy-icon', className),
        ...(title ? { title } : { 'aria-hidden': true as const }),
        width: size ?? width,
        height: size ?? height,
        ...rest,
    };

    return React.cloneElement(children, mergedProps);
}
