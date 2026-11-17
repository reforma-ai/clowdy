import type { ImgHTMLAttributes } from 'react';

export type ImageProps = ImgHTMLAttributes<HTMLImageElement>;

/** Native image with safe defaults; sizing and fit are left to callers. */
export function Image({ draggable = false, ...props }: ImageProps) {
    return <img draggable={ draggable } { ...props } />;
}
