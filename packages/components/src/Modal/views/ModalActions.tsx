import { cn } from '@clowdy/lib';
import { observer } from 'mobx-react-lite';

import { For } from '../../For';
import { Show } from '../../Show';
import { ComponentRenderer } from './ComponentRender';

import type { ModalInstance } from '../typings';

export type ModalActionsProps = {
    modal: ModalInstance;
    className?: string | string[];
    actionsClassName?: string;
};

export const ModalActions = observer(({ modal, className, actionsClassName }: ModalActionsProps) => {
    const modalActions = modal.currentOptions.modalActions || [];
    const actions = modalActions
        .filter(action => !action.hide && action.component)
        .map((action, index) => ({ id: action.id || `action-${ index }`, ...action }));

    return (
        <Show when={ actions.length > 0 }>
            <div className={ cn(actionsClassName, className) }>
                <For each={ actions }>
                    { action => (
                        <ComponentRenderer
                            key={ action.id }
                            component={ action.component }
                            props={ action.props }
                            modal={ modal }
                            store={ modal.currentOptions.store }
                        />
                    ) }
                </For>
            </div>
        </Show>
    );
});
