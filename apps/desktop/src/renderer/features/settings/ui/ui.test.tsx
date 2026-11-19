// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsBlock } from './SettingsBlock';
import { SettingsCard } from './SettingsCard';
import { SettingsEmpty } from './SettingsEmpty';
import { SettingsPage } from './SettingsPage';
import { SettingsRow } from './SettingsRow';
import { SettingsSection } from './SettingsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const draw = (node: React.ReactNode) => act(() => root.render(node));

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('SettingsPage', () => {
    it('is a title that stays, an action, and then what the page is for and its blocks', () => {
        draw(<SettingsPage title="Providers" description="Who is signed in." actions={ <button type="button">Add</button> }><p>block</p></SettingsPage>);

        const heading = container.querySelector('[role="heading"]')!;

        expect([heading.textContent, heading.getAttribute('aria-level')]).toEqual(['Providers', '1']);
        expect(container.querySelector('nav[aria-label="Settings path"] button')).toBeNull();
        expect(container.querySelector('nav + div button')?.textContent).toBe('Add');
        expect(container.textContent).toContain('Who is signed in.');
        expect(container.querySelector('p')?.textContent).toBe('block');
        // Nothing is open over the page, so the page itself is in reach.
        expect(container.querySelector('[inert]')).toBeNull();
    });

    it('reads as a path once a page is open over it, each page above the last being a link back', () => {
        const navigate = vi.fn();

        draw(
            <SettingsPage
                title="Projects"
                description="The list."
                layers={ [{ id: 'car', title: 'Car Rental', description: 'Four chats.', content: <p>detail</p> }] }
                onNavigate={ navigate }
            >
                <p>list</p>
            </SettingsPage>
        );

        const nav = container.querySelector('nav[aria-label="Settings path"]')!;

        expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('Car Rental');
        expect(nav.querySelector('button')?.textContent).toBe('Projects');
        // The page opened over the other has its own line on what it is, and the one under it is out of reach, still there.
        expect(container.textContent).toContain('Four chats.');
        expect(container.querySelector('[inert]')?.textContent).toContain('The list.');
        expect(container.querySelector('[inert] p')?.textContent).toBe('list');

        act(() => nav.querySelector<HTMLButtonElement>('button')!.click());
        expect(navigate).toHaveBeenCalledWith(0);
    });
});

describe('SettingsSection', () => {
    it('is a named region with a heading, a line on what it is, and its card', () => {
        draw(<SettingsSection title="Git" aside={ <span>2</span> } description="Where it lives."><SettingsCard>card</SettingsCard></SettingsSection>);

        const section = container.querySelector('section[aria-label="Git"]')!;

        expect(section.querySelector('h2')?.textContent).toBe('Git');
        expect(section.textContent).toContain('Where it lives.');
        expect(section.textContent).toContain('2');
        expect(section.textContent).toContain('card');
    });
});

describe('SettingsCard and its blocks', () => {
    it('can be a list of list items, with hairlines when divided', () => {
        draw(<SettingsCard as="ul" divided><SettingsBlock as="li">one</SettingsBlock><SettingsBlock as="li">two</SettingsBlock></SettingsCard>);

        const list = container.querySelector('ul')!;

        expect(list.hasAttribute('data-divided')).toBe(true);
        expect([...list.children].map(child => child.tagName)).toEqual(['LI', 'LI']);
    });

    it('is a plain div that draws no hairlines unless divided', () => {
        draw(<SettingsCard>one</SettingsCard>);

        expect(container.firstElementChild?.tagName).toBe('DIV');
        expect(container.firstElementChild?.hasAttribute('data-divided')).toBe(false);
    });
});

describe('SettingsRow', () => {
    it('has the title, its description, the control, and a footer under them', () => {
        draw(<SettingsRow title="Name" description="How it is listed." footer={ <em>note</em> }><input aria-label="Name" /></SettingsRow>);

        expect(container.textContent).toContain('Name');
        expect(container.textContent).toContain('How it is listed.');
        expect(container.querySelector('input[aria-label="Name"]')).not.toBeNull();
        expect(container.querySelector('em')?.textContent).toBe('note');
    });

    it('has no control or footer element when there is none, and can stack its control', () => {
        draw(<SettingsRow title="Remote" stacked />);

        expect(container.firstElementChild?.getAttribute('data-stacked')).toBe('true');
        expect(container.firstElementChild?.children).toHaveLength(1);
    });
});

describe('SettingsEmpty', () => {
    it('says what is missing', () => {
        draw(<SettingsEmpty>No projects yet.</SettingsEmpty>);

        expect(container.textContent).toBe('No projects yet.');
    });
});
