import { ListBox, ListBoxHeader, ListBoxItem, ListBoxSection } from '@clowdy/components/List';
import { Panel, PanelContent } from '@clowdy/components/Panel';
import { Book, Folder, Message, Page, PaintBucket, Robot } from '@clowdy/icons/14';
import { Fragment } from 'react';

import { SidebarHeading, SidebarLayout } from '../../shared';
import { useRootStore, type SettingsPage } from '../../stores';
import { AppearancePage } from './AppearancePage';
import { ChatPage } from './ChatPage';
import { FilesPage } from './FilesPage';
import { ProjectsPage } from './projects';
import { ProvidersPage } from './providers';
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
            { id: 'chat', label: 'Chat', icon: <Message />, render: () => <ChatPage /> },
            { id: 'files', label: 'Files', icon: <Page />, render: () => <FilesPage /> },
        ],
    },
    {
        id: 'workspace',
        label: 'Workspace',
        pages: [
            { id: 'projects', label: 'Projects', icon: <Folder />, render: () => <ProjectsPage /> },
        ],
    },
    {
        id: 'agents',
        label: 'Agents',
        pages: [
            { id: 'providers', label: 'Providers', icon: <Robot />, render: () => <ProvidersPage /> },
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
        <SidebarLayout screen="settings" defaultWidth={ 270 } sidebar={ <PagesSidebar page={ page } /> }>
            <section className={ styles.main } aria-label={ page.label }>
                {/* The key opens the page again, from the top, when another one is chosen. The page lays out its own title line and scroll. */}
                <Fragment key={ page.id }>{ page.render() }</Fragment>
            </section>
        </SidebarLayout>
    );
}

/** The heading, and the pages in their groups. */
function PagesSidebar({ page }: { page: PageView }) {
    const { ui } = useRootStore();

    return (
        <Panel side="left">
            <SidebarHeading title="Settings" className={ styles.heading } />

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
    );
}
