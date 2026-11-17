import clsx from 'clsx';
import { observer } from 'mobx-react-lite';
import { useRef } from 'react';

import { Show } from '../../Show';
import { Spinner } from '../../Spinner';
import modalStyles from '../styles/Modal.module.css';
import { ComponentRenderer } from './ComponentRender';
import { ModalData } from './ModalData';
import { ModalResizeHandles } from './ModalResizeHandles';
import { ModalTitle } from './ModalTitle';

import type { CSSProperties, HTMLAttributes, Ref } from 'react';
import type { ModalInstance } from '../typings';

export type ModalProps = {
    modal: ModalInstance;
    className?: string;
    ref?: Ref<HTMLDivElement>;
} & Omit<HTMLAttributes<HTMLDivElement>, 'ref'>;

function resolveSizeStyle(value: number | string): string {
    return typeof value === 'number' ? `${ value }px` : value;
}

export const Modal = observer(({ modal, className: classNameProp, style: styleProp, ...rest }: ModalProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const options = modal.currentOptions;
    const loading = modal.loading;

    const className = clsx(
        modalStyles.root,
        options.type === 'overlay' && modalStyles.overlay,
        loading && 'loading',
        options.animate && modalStyles.animate,
        classNameProp,
        options.class
    );

    const sizeStyle: CSSProperties = {};

    if (options.width != null) {
        sizeStyle.width = resolveSizeStyle(options.width);
    }

    if (options.minWidth != null) {
        sizeStyle.minWidth = resolveSizeStyle(options.minWidth);
    }

    if (options.height != null) {
        sizeStyle.height = resolveSizeStyle(options.height);
    }

    const contentSized = options.height === 'auto'
        || options.height === 'fit-content'
        || options.height === 'min-content'
        || options.height === 'max-content';

    return (
        <div
            className={ className }
            data-modal-window
            data-modal-height={ contentSized ? 'content' : undefined }
            data-name={ modal.name }
            aria-disabled={ modal.disabled ? 'true' : undefined }
            style={ { ...sizeStyle, ...styleProp } }
            { ...rest }
            ref={ el => modal.setWindow(el) }
        >
            <Show when={ loading }>
                <Spinner className={ modalStyles.loader } />
            </Show>

            <ModalTitle
                modal={ modal }
                titleClassName={ modalStyles.title }
                closeClassName={ modalStyles.close }
                tabsListClassName={ modalStyles.tabsList }
                titleTextClassName={ modalStyles.titleText }
                actionsClassName={ modalStyles.actions }
                responsiveToggleClassName={ modalStyles.responsiveToggle }
            />

            <ModalData containerRef={ containerRef } className={ modalStyles.data }>
                { options.component && (
                    <ComponentRenderer
                        key={ `${ modal.contentRevision }-${ modal.activeTab ?? '' }-${ modal.responsiveMode ?? '' }` }
                        component={ options.component }
                        props={ options.props }
                        modal={ modal }
                        store={ options.store }
                        onMounted={ options.onMounted }
                        onUnmounted={ options.onUnmounted }
                    />
                ) }
            </ModalData>
            <ModalResizeHandles resizable={ options.resizable } handleClassName={ modalStyles.resizeHandle } />
        </div>
    );
});
