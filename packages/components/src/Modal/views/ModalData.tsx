import { mergeRefs } from '@clowdy/lib';
import clsx from 'clsx';
import { observer } from 'mobx-react-lite';

import { Scrollable } from '../../Scrollable';
import { Show } from '../../Show';
import { useModalContext } from '../hooks/useModalProvider';

import type { Ref } from 'react';

export type ModalDataProps = {
    children?: React.ReactNode;
    ref?: Ref<HTMLDivElement | null> | null;
    containerRef?: Ref<HTMLDivElement | null> | null;
} & React.HTMLAttributes<HTMLDivElement>;

export const ModalData = observer(({ children, className, ref: refProp, containerRef, ...rest }: ModalDataProps) => {
    const { modal } = useModalContext();
    const options = modal.currentOptions;
    const scrollable = options.scrollable;
    const useScrollable = scrollable === 'window';

    const classNameResolved = clsx(scrollable === 'hidden' && 'overflow-hidden', className);

    return (
        <div
            ref={mergeRefs(refProp, !useScrollable ? containerRef : null)}
            className={classNameResolved}
            data-modal-data
            data-name={modal.name}
            {...rest}
        >
            <Show when={useScrollable} fallback={children}>
                <Scrollable containerRef={containerRef ?? undefined}>{children}</Scrollable>
            </Show>
        </div>
    );
});
