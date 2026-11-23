import clsx from 'clsx';
import { observer } from 'mobx-react-lite';

import { Show } from '../../Show';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '../../ToggleButtonGroup';

import type { ModalInstance } from '../typings';

export type ModalTitleTabsProps = {
    className?: string | string[];
    modal: ModalInstance;
    tabsListClassName?: string;
    titleTextClassName?: string;
};

export const ModalTitleTabs = observer(
    ({ className, modal, tabsListClassName, titleTextClassName }: ModalTitleTabsProps) => {
        const options = modal.currentOptions;
        const tabs = (options.tabs || []).map(tab => ({ ...tab, value: tab.id }));
        const showTabs = tabs.length > 1;
        const activeTabId = modal.activeTab || options.activeTab || options.id;
        const title = options.title || tabs[0]?.title;

        return (
            <div
                className={clsx(showTabs ? tabsListClassName : titleTextClassName, className)}
                data-modal-tabs-list={showTabs ? '' : undefined}
            >
                <Show when={!showTabs}>{title}</Show>
                <Show when={showTabs}>
                    <ToggleButtonGroup
                        variant="transparent"
                        size={options.titleTabSize ?? 'md'}
                        selectedKeys={activeTabId ?? undefined}
                        onSelectionChange={keys => {
                            const key = keys.values().next().value;

                            if (key != null) {
                                modal.selectTab(String(key));
                            }
                        }}
                        className={tabsListClassName}
                    >
                        {tabs.map(tab => (
                            <ToggleButtonGroupItem key={tab.id} value={tab.id}>
                                {tab.title ?? tab.id}
                            </ToggleButtonGroupItem>
                        ))}
                    </ToggleButtonGroup>
                </Show>
            </div>
        );
    }
);
