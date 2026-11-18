import { Image } from '@clowdy/components/Image';
import { Lightbox, type LightboxOpen } from '@clowdy/components/Lightbox';
import { Pressable } from '@clowdy/components/Pressable';

import { sanitizeStreamdownProps } from '../sanitizeStreamdownProps';

import type { ImgHTMLAttributes } from 'react';
import type { ExtraProps } from 'streamdown';

export function StreamdownImage(props: ExtraProps) {
    const domProps = sanitizeStreamdownProps(props) as ImgHTMLAttributes<HTMLImageElement>;
    const { src, alt, ...rest } = domProps;
    const imageSrc = typeof src === 'string' ? src : undefined;
    const imageAlt = typeof alt === 'string' ? alt : '';

    if (!imageSrc) {
        return (
            <span data-streamdown="image-wrapper">
                <img data-streamdown="image" { ...domProps } />
            </span>
        );
    }

    return (
        <Lightbox src={ imageSrc } alt={ imageAlt || 'Image' }>
            {(open: LightboxOpen) => (
                <Pressable
                    data-streamdown="image-wrapper"
                    aria-label={ imageAlt || 'View image' }
                    onPress={ open }
                >
                    <Image data-streamdown="image" src={ imageSrc } alt={ imageAlt } { ...rest } />
                </Pressable>
            )}
        </Lightbox>
    );
}
