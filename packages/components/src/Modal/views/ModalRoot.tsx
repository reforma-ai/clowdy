import clsx from 'clsx';
import { observer } from 'mobx-react-lite';
import { useCallback, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';

import { ModalProvider } from '../hooks/useModalProvider';
import ModalController from '../Modal';
import overlayStyles from '../styles/Overlay.module.css';
import { ComponentRenderer } from './ComponentRender';
import { Modal } from './Modal';

import type { ModalInstance } from '../typings';

export type ModalRootProps = {
    modal: ModalInstance;
};

function syncOverlayTabIndex(overlay: HTMLElement) {
    const existingOverlays = document.querySelectorAll('[data-modal-overlay]');
    const lastOverlay = existingOverlays[existingOverlays.length - 1];

    overlay.tabIndex = lastOverlay
        ? (parseInt(lastOverlay.getAttribute('tabindex') || '0', 10) + 1)
        : 0;
}

export const ModalRoot = observer(({ modal }: ModalRootProps) => {
    const options = modal.currentOptions;
    const themeClass = options.theme || 'light';

    const overlayStyle = useMemo(() => {
        const style: {
            zIndex?: number;
            padding?: string;
            visibility?: 'hidden';
            opacity?: number;
        } = {};

        if (options.zIndex != null) {
            style.zIndex = options.zIndex;
        }

        if (options.padding != null && options.padding !== '') {
            style.padding = typeof options.padding === 'number'
                ? `${ options.padding }px`
                : options.padding;
        }

        if (modal.hidden) {
            style.visibility = 'hidden';
            style.opacity = 0;
        }

        return style;
    }, [modal.hidden, options.zIndex, options.padding]);

    const setOverlayRef = useCallback((el: HTMLDivElement | null) => {
        modal.setOverlay(el);

        if (el) {
            el.style.visibility = 'hidden';
        }
    }, [modal]);

    useLayoutEffect(() => {
        const overlay = modal.overlay;

        if (!overlay) {
            return;
        }

        const sync = () => {
            syncOverlayTabIndex(overlay);
        };

        sync();
        void ModalController.events.on('open close show hide', sync);

        return () => {
            void ModalController.events.off('open close show hide', sync);
        };
    }, [modal]);

    const overlay = (
        <div
            ref={ setOverlayRef }
            data-modal={ modal.name }
            data-modal-overlay=""
            className={ clsx(
                overlayStyles.overlay,
                options.overlay && overlayStyles.on,
                options.shadow && overlayStyles.shadow,
                options.scrollable === 'overlay' && overlayStyles.scrollableContent,
                options.overlayClass,
                themeClass
            ) }
            style={ overlayStyle }
        >
            <ModalProvider value={ modal }>
                { options.overlayBackdrop
                    ? (
                        <ComponentRenderer
                            component={ options.overlayBackdrop }
                            modal={ modal }
                        />
                    )
                    : null }

                <Modal modal={ modal } />
            </ModalProvider>
        </div>
    );

    if (options.reactHost) {
        return createPortal(overlay, document.body);
    }

    return overlay;
});
