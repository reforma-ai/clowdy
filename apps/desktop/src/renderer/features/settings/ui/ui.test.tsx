// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    it('is what the page is for, under a hairline, and then its blocks: the window draws the title and the action above it', () => {
        draw(
            <SettingsPage description="Who is signed in.">
                <p>block</p>
                <p>another</p>
            </SettingsPage>
        );

        expect(container.textContent).toContain('Who is signed in.');
        expect(container.querySelector('[role="heading"]')).toBeNull();
        expect([...container.querySelectorAll('p')].map(item => item.textContent)).toEqual(['block', 'another']);
        // What it is for comes first.
        expect(container.textContent!.indexOf('Who is signed in.')).toBeLessThan(
            container.textContent!.indexOf('block')
        );
    });

    it('has no line on what it is for when it has no description', () => {
        draw(
            <SettingsPage>
                <p>block</p>
            </SettingsPage>
        );

        expect(container.querySelector('[class*="intro"]')).toBeNull();
        expect(container.querySelector('p')?.textContent).toBe('block');
    });
});

describe('SettingsSection', () => {
    it('is a named region with a heading, a line on what it is, and its card', () => {
        draw(
            <SettingsSection title="Git" aside={<span>2</span>} description="Where it lives.">
                <SettingsCard>card</SettingsCard>
            </SettingsSection>
        );

        const section = container.querySelector('section[aria-label="Git"]')!;
        const [caption, card] = section.children;

        expect(section.children).toHaveLength(2);
        expect(caption?.querySelector('h2')?.textContent).toBe('Git');
        expect(caption?.firstElementChild?.textContent).toBe('Git2');
        expect(caption?.lastElementChild?.textContent).toBe('Where it lives.');
        expect(card?.textContent).toBe('card');
    });

    it('has only the heading in its caption without a description', () => {
        draw(
            <SettingsSection title="Theme">
                <SettingsCard>card</SettingsCard>
            </SettingsSection>
        );

        const section = container.querySelector('section[aria-label="Theme"]')!;
        const [caption, card] = section.children;

        expect(section.children).toHaveLength(2);
        expect(caption?.children).toHaveLength(1);
        expect(caption?.querySelector('h2')?.textContent).toBe('Theme');
        expect(card?.textContent).toBe('card');
    });
});

describe('SettingsCard and its blocks', () => {
    it('can be a list of list items, with hairlines when divided', () => {
        draw(
            <SettingsCard as="ul" divided>
                <SettingsBlock as="li">one</SettingsBlock>
                <SettingsBlock as="li">two</SettingsBlock>
            </SettingsCard>
        );

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
        draw(
            <SettingsRow title="Name" description="How it is listed." footer={<em>note</em>}>
                <input aria-label="Name" />
            </SettingsRow>
        );

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
