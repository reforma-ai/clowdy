import { Button } from '@clowdy/components/Button';
import { SortableList } from '@clowdy/components/SortableList';

import { PressesHotkey } from '../../hotkeys';
import { SIDE_PANEL_TAB_LABELS } from '../sidePanel/commands';
import { panelOrder } from '../sidePanel/panelOrder';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

/** The rail's order and the digit assigned to each position. */
export function PanelOrderSettings() {
    return (
        <SettingsSection title="Side panel" description="Drag to reorder tabs and their shortcuts">
            <SortableList
                aria-label="Side panel order"
                items={panelOrder.order}
                getKey={tab => tab}
                getTextValue={tab => SIDE_PANEL_TAB_LABELS[tab]}
                onChange={items => panelOrder.setOrder(items)}
                getDragHandleOptions={() => ({ variant: 'surface', edgeOffset: '10' })}
            >
                {(tab, { index }) => (
                    <SettingsCard>
                        <SettingsRow title={SIDE_PANEL_TAB_LABELS[tab]}>
                            <PressesHotkey presses={[['mod', String(index + 1)]]} />
                        </SettingsRow>
                    </SettingsCard>
                )}
            </SortableList>
            <Button variant="ghost" color="secondary" size="sm" onPress={() => panelOrder.reset()}>
                Reset order
            </Button>
        </SettingsSection>
    );
}
