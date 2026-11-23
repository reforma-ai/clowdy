import { composeRenderProps, Provider } from 'react-aria-components';

import { DEFAULT_SLOT, filterSlots, Slot, SlotContext } from '../Slot';
import { Text } from '../Text';
import styles from './ListBox.module.css';

import type { ReactNode } from 'react';

const listRowSlotDefinitions = {
    [DEFAULT_SLOT]: {},
    icon: {},
    startAffix: { className: styles.itemStartAffix },
    label: { className: styles.itemLabel },
    description: { className: styles.itemDescription },
} as const;

/** Stable reference for SlotContext.Provider (matches prior `useMemo(..., [])` pattern). */
export const listRowItemSlotContextValue = { slots: listRowSlotDefinitions };

export interface ListRowItemSlotFields {
    icon?: ReactNode;
    description?: ReactNode;
    startAffix?: ReactNode;
    endAffix?: ReactNode;
    /** Title + description in a column (slash / plus pickers). Default is inline, description in `itemEnd`. */
    stacked?: boolean;
    /** Primary label fallback when using render-prop children without explicit label slot content. */
    textValue?: string;
}

type RenderPropsChildren = Parameters<typeof composeRenderProps>[0];

/**
 * Shared list/menu/grid row layout: SlotContext + affix/description slots.
 * Returns RAC’s `(renderProps) => ReactNode`, not a rendered node — use as JSX child `{ result }`.
 */
export function renderListRowItemContent(children: RenderPropsChildren, slotFields: ListRowItemSlotFields) {
    return composeRenderProps(children as ReactNode, (composedChildren: ReactNode) => {
        const { icon, description, startAffix, endAffix, stacked, textValue } = slotFields;

        const iconSlot = filterSlots(composedChildren, 'icon', icon);

        const labelSlot = filterSlots(
            composedChildren,
            'label',
            <Text slot="label">{composedChildren ?? textValue}</Text>
        );

        const descriptionSlot = filterSlots(
            composedChildren,
            'description',
            description != null ? <Text slot="description">{description}</Text> : undefined
        );

        const startAffixSlot = filterSlots(
            composedChildren,
            'startAffix',
            startAffix ? (
                <Slot as="div" slot="startAffix">
                    {startAffix}
                </Slot>
            ) : undefined
        );

        const endAffixSlot = filterSlots(composedChildren, 'endAffix', endAffix);

        const copy =
            stacked && descriptionSlot ? (
                <div className={styles.itemCopy}>
                    {labelSlot}
                    {descriptionSlot}
                </div>
            ) : (
                labelSlot
            );

        return (
            <Provider values={[[SlotContext, listRowItemSlotContextValue]]}>
                <div className={styles.itemStart}>
                    {startAffixSlot}
                    {iconSlot}
                    {copy}
                </div>

                <div className={styles.itemEnd} {...(endAffixSlot ? { slot: 'endAffix' } : {})}>
                    {stacked ? null : descriptionSlot}
                    {endAffixSlot}
                </div>
            </Provider>
        );
    });
}
