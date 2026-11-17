import { Show } from '../../Show';

import type { ModalOptions } from '../typings';

export type ModalResizeHandlesProps = {
    resizable?: ModalOptions['resizable'];
    handleClassName?: string;
};

export function ModalResizeHandles({ resizable, handleClassName }: ModalResizeHandlesProps) {
    const direction = resizable ? (resizable.direction || 'both') : false;

    return (
        <>
            <Show when={ direction === 'both' || direction === 'x' }>
                <div className={ handleClassName } data-modal-resize-handle data-resize="x" />
            </Show>
            <Show when={ direction === 'both' || direction === 'y' }>
                <div className={ handleClassName } data-modal-resize-handle data-resize="y" />
            </Show>
            <Show when={ direction === 'both' }>
                <div className={ handleClassName } data-modal-resize-handle data-resize="both">
                    <svg viewBox="0 0 16 16">
                        <path d="M7 11.9497L11.9497 7L12.6569 7.70711L7.70711 12.6569L7 11.9497Z" />
                        <path d="M2 11.8995L11.8995 2L12.6066 2.70711L2.70711 12.6066L2 11.8995Z" />
                    </svg>
                </div>
            </Show>
        </>
    );
}
