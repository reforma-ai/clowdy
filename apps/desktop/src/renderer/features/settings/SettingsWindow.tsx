import { SettingsLayout, type SettingsNavItem } from '@clowdy/components/SettingsLayout';
import { BoltBordered, Book, Folder, Info, Message, Page, PaintBucket, Robot, Version } from '@clowdy/icons/14';
import { Keyboard } from '@clowdy/icons/16';
import { observer } from 'mobx-react-lite';

import { type SettingsPage, useRootStore } from '../../stores';
import { AboutPage } from './AboutPage';
import { AppearancePage } from './AppearancePage';
import { ChatPage } from './ChatPage';
import { FilesPage } from './FilesPage';
import { PowerPage } from './PowerPage';
import { AddProjectButton, ProjectsPage } from './projects';
import { ProvidersPage } from './providers';
import { ShortcutsPage } from './ShortcutsPage';
import { SourceControlPage } from './SourceControlPage';
import { SkillsSection } from './skills';

import type { ReactNode } from 'react';

interface PageView extends SettingsNavItem {
    id: SettingsPage;
    render: () => ReactNode;
}

/** The pages, top to bottom, with the group each is under in the sidebar. */
const PAGES: readonly PageView[] = [
    {
        id: 'appearance',
        label: 'Appearance',
        group: 'General',
        icon: <PaintBucket />,
        render: () => <AppearancePage />,
    },
    { id: 'power', label: 'Power', group: 'General', icon: <BoltBordered />, render: () => <PowerPage /> },
    { id: 'chat', label: 'Chat', group: 'General', icon: <Message />, render: () => <ChatPage /> },
    { id: 'files', label: 'Files', group: 'General', icon: <Page />, render: () => <FilesPage /> },
    {
        id: 'source-control',
        label: 'Source Control',
        group: 'General',
        icon: <Version />,
        render: () => <SourceControlPage />,
    },
    {
        id: 'shortcuts',
        label: 'Shortcuts',
        group: 'General',
        icon: <Keyboard size={14} />,
        render: () => <ShortcutsPage />,
    },
    { id: 'projects', label: 'Projects', group: 'Workspace', icon: <Folder />, render: () => <ProjectsPage /> },
    { id: 'providers', label: 'Providers', group: 'Agents', icon: <Robot />, render: () => <ProvidersPage /> },
    { id: 'skills', label: 'Skills', group: 'Agents', icon: <Book />, render: () => <SkillsSection /> },
    { id: 'about', label: 'About', group: 'Clowdy', icon: <Info />, render: () => <AboutPage /> },
];

/**
 * Global settings, drawn by the shared `SettingsLayout`: a sidebar of the pages in their groups (no title over it), the page chosen in it under its title, and, over Projects, the page of
 * one project with a path back in the title. The window state keeps both (`UiStore.settingsPage`, `settingsProjectId`), and the layout only asks to change them.
 * Nothing here belongs to a project.
 */
export const SettingsWindow = observer(function SettingsWindow() {
    const { ui, projects } = useRootStore();
    const page = PAGES.find(candidate => candidate.id === ui.settingsPage) ?? PAGES[0]!;
    const project =
        page.id === 'projects' && ui.settingsProjectId
            ? projects.find(candidate => candidate.id === ui.settingsProjectId)
            : undefined;

    return (
        <SettingsLayout
            items={PAGES}
            selectedId={page.id}
            onSelectedChange={id => ui.showSettingsPage(id as SettingsPage)}
            stack={project ? [{ id: project.id, label: project.name }] : []}
            onStackChange={stack => ui.setSettingsProject(stack[0]?.id ?? null)}
        >
            {/* No title over the groups: the first group's heading is right there, and the window is called Settings by where it opens from. */}
            <SettingsLayout.Sidebar aria-label="Settings pages" />
            {/* The page's own main action, at the end of the title's line: Projects has Add project, and not while a project's page is open over it. */}
            <SettingsLayout.Content headerRight={page.id === 'projects' && !project ? <AddProjectButton /> : undefined}>
                {page.render()}
            </SettingsLayout.Content>
        </SettingsLayout>
    );
});
