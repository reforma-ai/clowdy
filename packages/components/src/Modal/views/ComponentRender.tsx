import { isValidElement, useEffect } from 'react';

import type { ModalComponent, ModalComponentProps, ModalInstance, ModalStore } from '../typings';

export type ComponentRendererProps = {
    component?: ModalComponent;
    props?: ModalComponentProps;
    modal: ModalInstance;
    store?: ModalStore;
    onMounted?: (modal: ModalInstance) => void;
    onUnmounted?: (modal: ModalInstance) => void;
};

export function ComponentRenderer({
    component,
    props: componentProps,
    modal,
    store,
    onMounted,
    onUnmounted,
}: ComponentRendererProps) {
    useEffect(() => {
        onMounted?.(modal);

        return () => onUnmounted?.(modal);
    }, [modal, onMounted, onUnmounted]);

    if (!component) {
        return null;
    }

    // component: <FancyDialog /> notation
    if (isValidElement(component)) {
        return component;
    }

    // either
    // component: ({ modal }) => <FancyDialog />
    // component: FancyDialog
    const Component = component;

    return <Component store={store} modal={modal} {...componentProps} />;
}
