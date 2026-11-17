import { ArrowLeft } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { type ComponentProps, type HTMLAttributes, type ReactNode, type Ref } from 'react';

import { Button } from '../Button';
import { For } from '../For';
import { Scrollable } from '../Scrollable';
import { Text } from '../Text';
import { ToggleButtonGroup, ToggleButtonGroupItem, type Key } from '../ToggleButtonGroup';
import styles from './Panel.module.css';

type PanelSide = 'left' | 'right';

interface PanelProps {
    children: ReactNode;
    className?: string;
    ref?: Ref<HTMLElement>;
    side: PanelSide;
    'data-collapsed'?: string;
}

export function Panel({ children, className, side, 'data-collapsed': dataCollapsed, ...rest }: PanelProps) {
    return (
        <aside
            className={ cn(styles.panel, side === 'left' ? styles.panelLeft : styles.panelRight, className) }
            data-collapsed={ dataCollapsed }
            { ...rest }
        >
            { children }
        </aside>
    );
}

function PanelHeaderRoot({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={ cn(styles.title, className) } { ...props }>
            { children }
        </div>
    );
}

function PanelHeaderActions({ children }: { children: ReactNode }) {
    return (
        <div className={ styles.titleActions }>
            { children }
        </div>
    );
}

function PanelHeaderButton(props: ComponentProps<typeof Button>) {
    return (
        <Button
            variant="filling"
            color="secondary"
            size="sm"
            iconOnly
            { ...props }
        />
    );
}

/** 40px panel bar. Tabs or a title on the left, `PanelHeader.Actions` on the right. */
export const PanelHeader = Object.assign(PanelHeaderRoot, {
    Actions: PanelHeaderActions,
    Button: PanelHeaderButton,
});

/** One-step back in the tab/title slot. `label` is the place you return to. */
export function PanelHeaderBack({ label, onPress }: { label: string; onPress: () => void }) {
    return (
        <Button
            className={ styles.headerBack }
            variant="transparent"
            color="secondary"
            size="sm"
            truncate
            onPress={ onPress }
        >
            <ArrowLeft className="shrink-0" />
            <Text truncate className="min-w-0">
                { `Back to ${ label }` }
            </Text>
        </Button>
    );
}

interface PanelTabHeaderProps<T extends string> {
    tab: T;
    tabs: ReadonlyArray<{ value: T; label: ReactNode }>;
    onSelect: (tab: T) => void;
}

export function PanelTabHeader<T extends string>({ tab, tabs, onSelect }: PanelTabHeaderProps<T>) {
    return (
        <ToggleButtonGroup
            className={ styles.headerTabs }
            size="sm"
            variant="text"
            selectedKeys={ tab }
            onSelectionChange={ (keys: Set<Key>) => {
                const val = keys.size ? ([...keys][0] as T) : undefined;

                if (val) {
                    onSelect(val);
                }
            } }
        >
            <For each={ tabs }>
                { item => (
                    <ToggleButtonGroupItem key={ item.value } value={ item.value }>
                        { item.label }
                    </ToggleButtonGroupItem>
                ) }
            </For>
        </ToggleButtonGroup>
    );
}

/** Scrollable panel body that fills the space below the header. */
export function PanelContent({ className, ...props }: ComponentProps<typeof Scrollable>) {
    return <Scrollable className={ cn(styles.body, className) } { ...props } />;
}

/** Remount with `key={tab}` at the call site so the enter animation restarts. */
export function PanelTab({ children }: { children: ReactNode }) {
    return (
        <div className={ styles.tab }>
            <div className={ styles.tabEnter }>
                { children }
            </div>
        </div>
    );
}
