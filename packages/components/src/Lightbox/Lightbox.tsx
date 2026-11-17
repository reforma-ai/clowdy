import { useCallback, useState, type ReactNode } from 'react';

import { Box } from '../Box';
import { Image } from '../Image';
import { Dialog } from '../Modal';
import styles from './Lightbox.module.css';

export type LightboxOpen = () => void;

export type LightboxProps = {
    src: string;
    alt: string;
    /** Modal title when it differs from `alt`. */
    label?: string;
    /** Controlled visibility. Omit to let the trigger call `open`. */
    isOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Build the trigger; call `open` from `onPress` (e.g. {@link Attachment}, {@link Pressable}). */
    children?: (open: LightboxOpen) => ReactNode;
};

/** Image preview via Clowdy modal scrollable overlay (`Dialog` + `reactHost`, portaled to `body`). */
export function Lightbox({
    src,
    alt,
    label,
    isOpen: isOpenProp,
    onOpenChange,
    children,
}: LightboxProps) {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const [smallImageSrc, setSmallImageSrc] = useState<string | null>(null);
    const isOpen = isOpenProp ?? uncontrolledOpen;
    const setOpen = useCallback((next: boolean) => {
        onOpenChange?.(next);

        if (isOpenProp === undefined) {
            setUncontrolledOpen(next);
        }
    }, [isOpenProp, onOpenChange]);
    const open = useCallback(() => {
        setOpen(true);
    }, [setOpen]);

    return (
        <>
            { children?.(open) }
            <Dialog
                name="lightbox"
                isOpen={ isOpen }
                onOpenChange={ setOpen }
                type="overlay"
                scrollable="overlay"
                class={ styles.window }
                overlayClass={ styles.overlay }
                height="auto"
                shadow
                clickOut
                title={ label ?? alt }
            >
                <Box direction="row" className={ styles.stage } align="center" justify="center" data-small-image={ smallImageSrc === src || undefined }>
                    <Image
                        className={ styles.image }
                        src={ src }
                        alt={ alt }
                        onLoad={ event => {
                            const image = event.currentTarget;
                            setSmallImageSrc(image.naturalWidth < 320 && image.naturalHeight < 320 ? src : null);
                        } }
                    />
                </Box>
            </Dialog>
        </>
    );
}

Lightbox.displayName = 'Lightbox';
