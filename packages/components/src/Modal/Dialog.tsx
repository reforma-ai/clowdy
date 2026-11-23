import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import Modal from './Modal';
import { ModalRoot } from './views/ModalRoot';

import type { ModalComponent, ModalInstance, ModalOptions, ModalOptionsRaw } from './typings';

export type DialogProps = {
    isOpen?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: ModalComponent;
} & ModalOptionsRaw;

export function Dialog({
    isOpen: _isOpen,
    defaultOpen = true,
    onOpenChange,
    children,
    component,
    ..._modalOptions
}: DialogProps) {
    const controlled = _isOpen !== undefined;
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const isOpen = controlled ? _isOpen : internalOpen;

    const setOpen = useCallback(
        (open: boolean) => {
            if (!controlled) {
                setInternalOpen(open);
            }

            onOpenChange?.(open);
        },
        [controlled, onOpenChange]
    );

    const [instance, setInstance] = useState<ModalInstance | null>(null);
    const instanceRef = useRef(instance);

    useLayoutEffect(() => {
        instanceRef.current = instance;
    }, [instance]);

    const resolvedComponent = children ?? component;

    const modalOptions = useMemo<Partial<ModalOptions>>(
        () => ({
            ..._modalOptions,
            component: resolvedComponent,
            reactHost: true,
            onOpen: modalInstance => {
                setOpen(true);
                _modalOptions.onOpen?.(modalInstance);
            },
            onClose: modalInstance => {
                setOpen(false);
                setInstance(null);
                _modalOptions.onClose?.(modalInstance);
            },
        }),
        [_modalOptions, resolvedComponent, setOpen]
    );

    useLayoutEffect(() => {
        if (!isOpen || instance) {
            return;
        }

        setInstance(Modal.create(modalOptions));
    }, [isOpen, instance, modalOptions]);

    useLayoutEffect(() => {
        if (instance) {
            instance.updateOptions(modalOptions);
        }
    }, [instance, isOpen, modalOptions]);

    useLayoutEffect(() => {
        if (instance && !isOpen) {
            void instance.close();
        }
    }, [isOpen, instance]);

    useLayoutEffect(
        () => () => {
            void instanceRef.current?.close(false, { restoreFocus: false });
        },
        []
    );

    if (!instance) {
        return;
    }

    return <ModalRoot modal={instance} />;
}
