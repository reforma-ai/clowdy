import { createContext, use, useId, useLayoutEffect } from 'react';

import type { ReactNode } from 'react';
import type { ModalInstance, ModalStore } from '../typings';

interface ModalContextValue {
    modal: ModalInstance;
    store: ModalStore | undefined;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export { ModalContext };

export function ModalProvider(props: { value: ModalInstance; children: ReactNode }) {
    const modal = props.value;
    const store = modal.currentOptions.store;

    return <ModalContext value={{ modal, store }}>{props.children}</ModalContext>;
}

export function useModalContext(): ModalContextValue {
    const context = use(ModalContext);

    if (!context) {
        throw new Error('useModalContext must be used within a ModalProvider');
    }

    return context;
}

/**
 * An id for the element that is the dialog's title: the modal it renders in is named by that element while it is mounted. Outside a modal it is just
 * an id. `DialogLayout` and the confirmation dialog use it; a dialog with a title of its own gives the id to its heading.
 */
export function useModalTitleId(): string {
    const id = useId();
    const modal = use(ModalContext)?.modal;

    useLayoutEffect(() => {
        if (!modal) {
            return;
        }

        modal.setLabelledBy(id);

        return () => {
            if (modal.labelledBy === id) {
                modal.setLabelledBy(null);
            }
        };
    }, [modal, id]);

    return id;
}
