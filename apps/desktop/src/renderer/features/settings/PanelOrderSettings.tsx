import { Button } from '@clowdy/components/Button';
import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { SortableList } from '@clowdy/components/SortableList';

import { PressesHotkey } from '../../hotkeys';
import { SIDE_PANEL_TAB_LABELS } from '../sidePanel/commands';
import { panelOrder } from '../sidePanel/panelOrder';

/** The rail's order and the digit assigned to each position. */
export function PanelOrderSettings() {
    return (
        <SettingsLayout.Section title="Side panel" description="Drag to reorder tabs and their shortcuts">
            <SortableList
                aria-label="Side panel order"
                items={panelOrder.order}
                getKey={tab => tab}
                getTextValue={tab => SIDE_PANEL_TAB_LABELS[tab]}
                onChange={items => panelOrder.setOrder(items)}
                getDragHandleOptions={() => ({ variant: 'surface', edgeOffset: '10' })}
            >
                {(tab, { index }) => (
                    <SettingsLayout.Card>
                        <SettingsLayout.Row title={SIDE_PANEL_TAB_LABELS[tab]}>
                            <PressesHotkey presses={[['mod', String(index + 1)]]} />
                        </SettingsLayout.Row>
                    </SettingsLayout.Card>
                )}
            </SortableList>
            <Button variant="ghost" color="secondary" size="sm" onPress={() => panelOrder.reset()}>
                Reset order
            </Button>
        </SettingsLayout.Section>
    );
}
