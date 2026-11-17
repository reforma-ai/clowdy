import { ListBox, ListBoxHeader, ListBoxItem, ListBoxSection } from '@clowdy/components/List';
import { Panel, PanelContent, PanelHeader } from '@clowdy/components/Panel';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Book, PaintBucket, Robot } from '@clowdy/icons/14';

import { useRootStore, type SettingsPage } from '../../stores';
import { AppearancePage } from './AppearancePage';
import { EnginePage } from './EnginePage';
import styles from './Screen.module.css';
import { SkillsSection } from './skills';

import type { ReactNode } from 'react';

interface PageView {
    id: SettingsPage;
    label: string;
    icon: ReactNode;
    render: () => ReactNode;
}

/** The sidebar's groups, top to bottom. A page belongs to one group. */
const GROUPS: ReadonlyArray<{ id: string; label: string; pages: readonly PageView[] }> = [
    {
        id: 'general',
        label: 'General',
        pages: [
            { id: 'appearance', label: 'Appearance', icon: <PaintBucket />, render: () => <AppearancePage /> },
        ],
    },
    {
        id: 'agents',
        label: 'Agents',
        pages: [
            { id: 'engine', label: 'Engine', icon: <Robot />, render: () => <EnginePage /> },
            { id: 'skills', label: 'Skills', icon: <Book />, render: () => <SkillsSection /> },
        ],
    },
];

const PAGES = GROUPS.flatMap(group => group.pages);

/** Global settings: a sidebar of groups, and the page chosen in it. Nothing here belongs to a project. */
export function Screen() {
    const { ui } = useRootStore();
    const page = PAGES.find(candidate => candidate.id === ui.settingsPage) ?? PAGES[0]!;

    return (
        <div className={ styles.screen }>
            <Panel side="left" className={ styles.panel }>
                <PanelHeader>Settings</PanelHeader>

                <PanelContent contentClass={ styles.list }>
                    <ListBox
                        aria-label="Settings pages"
                        size="md"
                        selectionMode="single"
                        disallowEmptySelection
                        selectedKeys={ page.id }
                        onSelectionChange={ (keys) => {
                            const [id] = keys === 'all' ? [] : keys;
                            const next = PAGES.find(candidate => candidate.id === id);

                            if (next) ui.showSettingsPage(next.id);
                        } }
                    >
                        { GROUPS.map(group => (
                            <ListBoxSection key={ group.id }>
                                <ListBoxHeader>{ group.label }</ListBoxHeader>
                                { group.pages.map(item => (
                                    <ListBoxItem key={ item.id } id={ item.id } icon={ item.icon } textValue={ item.label }>
                                        { item.label }
                                    </ListBoxItem>
                                )) }
                            </ListBoxSection>
                        )) }
                    </ListBox>
                </PanelContent>
            </Panel>

            <section className={ styles.main } aria-label={ page.label }>
                <PanelHeader>{ page.label }</PanelHeader>
                {/* The key restarts the scroll position when another page is chosen. */}
                <Scrollable key={ page.id } className={ styles.scroll } contentClass={ styles.page }>
                    { page.render() }
                </Scrollable>
            </section>
        </div>
    );
}
