import { createContext, use } from 'react';

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

    return (
        <ModalContext value={ { modal, store } }>
            { props.children }
        </ModalContext>
    );
}

export function useModalContext(): ModalContextValue {
    const context = use(ModalContext);

    if (!context) {
        throw new Error('useModalContext must be used within a ModalProvider');
    }

    return context;
}
