import { Close } from '@clowdy/icons/14';
import clsx from 'clsx';
import { observer } from 'mobx-react-lite';

import { Button } from '../../Button';
import { Show } from '../../Show';
import { ModalActions } from './ModalActions';
import { ModalResponsiveToggle } from './ModalResponsiveToggle';
import { ModalTitleTabs } from './ModalTitleTabs';

import type { ModalInstance } from '../typings';

export type ModalTitleProps = {
    className?: string | string[];
    modal: ModalInstance;
    titleClassName?: string;
    closeClassName?: string;
    tabsListClassName?: string;
    titleTextClassName?: string;
    actionsClassName?: string;
    responsiveToggleClassName?: string;
};

export const ModalTitle = observer(
    ({
        className,
        modal,
        titleClassName,
        closeClassName,
        tabsListClassName,
        titleTextClassName,
        actionsClassName,
        responsiveToggleClassName,
    }: ModalTitleProps) => {
        const options = modal.currentOptions;
        const tabs = modal.options.tabs || [];
        const hasTitle = tabs.length > 0 || !!options.title || !!options.modalActions?.length;

        const resolvedTitleClassName = clsx(titleClassName, className, options.handle && 'draggable');

        return (
            <>
                <Show when={hasTitle}>
                    <div className={resolvedTitleClassName} data-modal-title>
                        <ModalTitleTabs
                            modal={modal}
                            tabsListClassName={tabsListClassName}
                            titleTextClassName={titleTextClassName}
                        />
                        <ModalActions modal={modal} actionsClassName={actionsClassName} />
                        <ModalResponsiveToggle modal={modal} className={responsiveToggleClassName} />
                        <Show when={options.closeButton}>
                            <Button
                                size="sm"
                                iconOnly
                                variant="filling"
                                color="inherit"
                                className={closeClassName}
                                data-modal-close
                                aria-label="Close"
                            >
                                <Close />
                            </Button>
                        </Show>
                    </div>
                </Show>
                <Show when={!hasTitle && options.closeButton}>
                    <Button
                        iconOnly
                        variant="filling"
                        size="sm"
                        color="secondary"
                        className={closeClassName}
                        data-modal-close
                        aria-label="Close"
                    >
                        <Close />
                    </Button>
                </Show>
            </>
        );
    }
);
