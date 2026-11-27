// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsLayout, useSettingsLayout } from './SettingsLayout';

const ITEMS = [
    { id: 'general', label: 'General' },
    { id: 'security', label: 'Security' },
];

let host: HTMLDivElement;
let root: Root;

function buttonNamed(name: string) {
    const button = [...host.querySelectorAll('button')].find(item => item.textContent === name);

    if (!button) {
        throw new Error(`Missing button ${name}`);
    }

    return button;
}

beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    host.remove();
});

describe('SettingsLayout as a window the host holds', () => {
    const GROUPED = [
        { id: 'appearance', label: 'Appearance', group: 'General' },
        { id: 'chat', label: 'Chat', group: 'General' },
        { id: 'projects', label: 'Projects', group: 'Workspace' },
    ];

    function Controls() {
        const { select, push, pop, rename, reset } = useSettingsLayout();

        return (
            <div>
                <button type="button" onClick={() => select('chat')}>
                    Choose chat
                </button>
                <button type="button" onClick={() => push({ id: 'one', label: 'One' })}>
                    Push
                </button>
                <button
                    type="button"
                    onClick={() => {
                        push({ id: 'two', label: 'Two' });
                        rename('two', 'Second');
                    }}
                >
                    Push and rename
                </button>
                <button type="button" onClick={pop}>
                    Pop
                </button>
                <button type="button" onClick={reset}>
                    Reset
                </button>
            </div>
        );
    }

    function draw(
        props: Partial<React.ComponentProps<typeof SettingsLayout>> = {},
        content: React.ReactNode = <Controls />
    ) {
        act(() => {
            root.render(
                <SettingsLayout items={GROUPED} {...props}>
                    <SettingsLayout.Sidebar title="Settings" />
                    <SettingsLayout.Content>{content}</SettingsLayout.Content>
                </SettingsLayout>
            );
        });
    }

    const options = () => [...host.querySelectorAll('[role="option"]')].map(option => option.textContent);
    const selectedOption = () => host.querySelector('[role="option"][aria-selected="true"]')?.textContent;

    it('puts the items under the headings of their groups, in order', () => {
        draw();

        expect(options()).toEqual(['Appearance', 'Chat', 'Projects']);
        expect(host.textContent).toContain('General');
        expect(host.textContent).toContain('Workspace');
        expect(host.textContent!.indexOf('General')).toBeLessThan(host.textContent!.indexOf('Appearance'));
        expect(host.textContent!.indexOf('Workspace')).toBeGreaterThan(host.textContent!.indexOf('Chat'));
        expect(host.textContent!.indexOf('Workspace')).toBeLessThan(host.textContent!.indexOf('Projects'));
    });

    it('keeps a list with no groups flat, with no headings of its own', () => {
        draw({ items: ITEMS });

        expect(options()).toEqual(['General', 'Security']);
        expect(host.querySelectorAll('[role="group"]')).toHaveLength(0);
    });

    it('shows the section it is given and only asks for another one, until the host gives it', () => {
        const onSelectedChange = vi.fn();

        draw({ selectedId: 'projects', onSelectedChange });

        expect(selectedOption()).toBe('Projects');

        act(() => {
            buttonNamed('Choose chat').click();
        });

        expect(onSelectedChange).toHaveBeenCalledExactlyOnceWith('chat');
        expect(selectedOption()).toBe('Projects');

        draw({ selectedId: 'chat', onSelectedChange });

        expect(selectedOption()).toBe('Chat');
    });

    it('tells the host the stack that each change makes, builds a rename on the push before it, and shows the stack it is given', () => {
        const onStackChange = vi.fn();

        draw({ stack: [], onStackChange });

        act(() => {
            buttonNamed('Push and rename').click();
        });

        expect(onStackChange).toHaveBeenCalledTimes(2);
        expect(onStackChange).toHaveBeenLastCalledWith([{ id: 'two', label: 'Second' }]);
        // The host has not given it yet.
        expect(host.textContent).not.toContain('Second');

        draw({ stack: [{ id: 'two', label: 'Second' }], onStackChange });

        expect(host.textContent).toContain('Second');

        act(() => {
            buttonNamed('Pop').click();
        });

        expect(onStackChange).toHaveBeenLastCalledWith([]);

        act(() => {
            buttonNamed('Reset').click();
        });

        expect(onStackChange).toHaveBeenLastCalledWith([]);
    });

    it('clears the stack when another section is chosen, and says nothing of a stack that is empty already', () => {
        const onStackChange = vi.fn();

        draw({ selectedId: 'projects', onSelectedChange: vi.fn(), stack: [], onStackChange });

        act(() => {
            buttonNamed('Choose chat').click();
        });

        expect(onStackChange).not.toHaveBeenCalled();

        draw({
            selectedId: 'projects',
            onSelectedChange: vi.fn(),
            stack: [{ id: 'one', label: 'One' }],
            onStackChange,
        });

        act(() => {
            buttonNamed('Choose chat').click();
        });

        expect(onStackChange).toHaveBeenCalledExactlyOnceWith([]);
    });

    it('works without the host holding anything: the layout holds the section and the stack itself', () => {
        draw();

        act(() => {
            buttonNamed('Choose chat').click();
        });

        expect(selectedOption()).toBe('Chat');

        act(() => {
            buttonNamed('Push').click();
        });

        expect(host.textContent).toContain('One');
    });

    it('draws what a section is for in the header under the title, outside the content that moves', () => {
        draw({}, <SettingsLayout.Intro>How it looks</SettingsLayout.Intro>);

        const description = host.querySelector('[class*="description"]')!;

        expect(description.textContent).toBe('How it looks');
        expect(host.querySelector('[class*="header"]')!.contains(description)).toBe(true);
        expect(host.querySelector('[class*="viewport"]')!.textContent).not.toContain('How it looks');
    });

    it("draws only the top layer's line: the page's while no pane is open over it, and the pane's while it is the last of the stack", () => {
        function Page() {
            return (
                <>
                    <SettingsLayout.Intro>The page</SettingsLayout.Intro>
                    <SettingsLayout.Pane paneKey="one">
                        <SettingsLayout.Intro>The pane</SettingsLayout.Intro>
                    </SettingsLayout.Pane>
                </>
            );
        }

        const description = () => host.querySelector('[class*="description"]')?.textContent;

        draw({ stack: [] }, <Page />);
        expect(description()).toBe('The page');

        draw({ stack: [{ id: 'one', label: 'One' }] }, <Page />);
        expect(description()).toBe('The pane');

        draw({ stack: [] }, <Page />);
        expect(description()).toBe('The page');
    });

    it('is a plain line where it stands when there is no layout around it', () => {
        act(() => {
            root.render(<SettingsLayout.Intro>Alone</SettingsLayout.Intro>);
        });

        expect(host.textContent).toBe('Alone');
    });
});
