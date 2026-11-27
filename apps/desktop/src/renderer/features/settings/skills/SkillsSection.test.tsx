// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from '../../../daemon/fixtureData';
import { FixtureTransport } from '../../../daemon/fixtureTransport';
import { overrideTransport } from '../../../daemon/testing';
import { RootStore, RootStoreProvider } from '../../../stores';
import { SkillsSection } from './SkillsSection';

import type { SkillCatalog } from '@clowdy/protocol';
import type { Transport } from '../../../daemon/transport';

vi.mock('./RecommendedSkill', () => ({ RecommendedSkill: () => null }));
vi.mock('@clowdy/components/Select', async () => {
    const { createElement } = await import('react');
    return {
        Select: (props: any) =>
            createElement(
                'select',
                {
                    'aria-label': props['aria-label'],
                    value: props.selectedKey,
                    onChange: (event: any) => props.onSelectionChange(event.target.value),
                },
                props.items.map((item: any) => props.children(item))
            ),
    };
});
vi.mock('@clowdy/components/List', async () => {
    const { createElement } = await import('react');
    return { ListBoxItem: (props: any) => createElement('option', { value: props.id, key: props.id }, props.text) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
const flush = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
const select = async (id: string) => {
    const element = container.querySelector('select')!;
    await act(async () => {
        element.value = id;
        element.dispatchEvent(new Event('change', { bubbles: true }));
    });
};
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
async function open(overrides: Partial<Transport> = {}) {
    const base = new FixtureTransport();
    store = new RootStore(overrideTransport(base, overrides), { storage: { getItem: () => null, setItem: () => {} } });
    await store.load();
    await act(async () =>
        reactRoot.render(
            <RootStoreProvider value={store}>
                <SkillsSection />
            </RootStoreProvider>
        )
    );
}
beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
});
afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store?.dispose();
});

it('shows the system skeleton while catalogs load', async () => {
    const waiting = deferred<SkillCatalog>();
    await open({ getSkills: () => waiting.promise });
    expect(container.querySelector('[aria-label="Loading system skills"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Enable system skills"]')).toBeNull();
});

it('switches global and project scopes with zero counts without changing the selected project', async () => {
    await open();
    await flush();
    const before = store.selectedProject?.project.id;
    const options = [...container.querySelectorAll('option')].map(option => option.textContent);
    expect(options[0]).toMatch(/^Global skills \(\d+\)$/);
    expect(options.some(option => option?.includes('(0)'))).toBe(true);
    await select(FIXTURE_PROJECT_ID);
    expect(container.textContent).toContain('booking-rules');
    expect(container.textContent).not.toContain('user:sql-review');
    expect(container.textContent).not.toContain('Claude and Codex');
    await select(FIXTURE_EMPTY_PROJECT_ID);
    expect(container.textContent).toContain('No skills found');
    await select('global');
    expect(container.textContent).toContain('user:sql-review');
    expect(store.selectedProject?.project.id).toBe(before);
});

it('does not show stale results after a reload and reports a project error independently', async () => {
    const base = new FixtureTransport();
    const old = deferred<SkillCatalog>();
    const fresh = deferred<SkillCatalog>();
    let generation = 0;
    await open({
        getSkills: id =>
            id === FIXTURE_PROJECT_ID ? (generation++ === 0 ? old.promise : fresh.promise) : base.getSkills(id),
    });
    await select(FIXTURE_PROJECT_ID);
    await act(async () => {
        store.skillsRevision++;
    });
    await act(async () => {
        old.resolve(await base.getSkills(FIXTURE_PROJECT_ID));
    });
    expect(container.textContent).not.toContain('booking-rules');
    expect(container.querySelector('[aria-label="Loading skills"]')).not.toBeNull();
    await act(async () => {
        fresh.reject(new Error('offline'));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('offline');
    expect(container.querySelector('[aria-label="Enable system skills"]')).not.toBeNull();
    expect(
        [...container.querySelectorAll('option')].find(option => option.value === FIXTURE_PROJECT_ID)?.textContent
    ).not.toMatch(/\(\d+\)/);
});

it('shows skill paths for multiple project folders and reloads after folders change', async () => {
    const base = new FixtureTransport();
    let requests = 0;
    await open({
        getSkills: async id => {
            const catalog = await base.getSkills(id);
            if (id === FIXTURE_PROJECT_ID) {
                requests++;
                const projectSkills = catalog.entries.filter(entry => entry.source === 'project');
                projectSkills[0]!.path = '/work/first/.agents/skills/booking-rules';
                projectSkills[1]!.path = '/work/second/.claude/skills/fleet-import';
            }
            return catalog;
        },
    });
    await select(FIXTURE_PROJECT_ID);
    expect(container.querySelector('[title="/work/first/.agents/skills/booking-rules"]')).not.toBeNull();
    expect(container.querySelector('[title="/work/second/.claude/skills/fleet-import"]')).not.toBeNull();
    await act(async () => {
        store.projects = store.projects.map(project =>
            project.id === FIXTURE_PROJECT_ID
                ? {
                      ...project,
                      folders: [
                          { id: 'first', path: '/work/first' },
                          { id: 'extra', path: '/work/second' },
                      ],
                  }
                : project
        );
    });
    expect(requests).toBe(2);
    expect(container.textContent).toContain('Folder: /work/first');
    expect(container.textContent).toContain('Folder: /work/second');
});
