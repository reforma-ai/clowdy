// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { Autocomplete } from '../Autocomplete';
import { ListBox, ListBoxHeader, ListBoxItem, ListBoxSection } from './ListBox';

const original = Element.prototype.scrollIntoView;
const scrolled: string[] = [];

let host: HTMLDivElement;
let root: Root;

function StoryList({ selected, nonce }: { selected: string; nonce: number }) {
    const items = Array.from({ length: 40 }, (_, index) => `story-${ index }`);

    return (
        <Autocomplete
            inputValue=""
            onInputChange={ () => {} }
            filter={ () => true }
            maxHeight={ 300 }
            placeholder="Find story"
            aria-label="Find story"
        >
            <ListBox
                aria-label="Stories"
                size="sm"
                autoFocus={ false }
                selectionMode="single"
                selectedKeys={ [selected] }
                data-nonce={ nonce }
            >
                <ListBoxSection id="ui">
                    <ListBoxHeader>UI</ListBoxHeader>
                    { items.map(id => (
                        <ListBoxItem key={ id } id={ id } textValue={ id }>
                            { id }
                        </ListBoxItem>
                    )) }
                </ListBoxSection>
            </ListBox>
        </Autocomplete>
    );
}

async function renderList(selected: string, nonce: number) {
    await act(async () => {
        root.render(<StoryList selected={ selected } nonce={ nonce } />);
        await Promise.resolve();
    });
}

describe('useScrollActiveListItem', () => {
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        Element.prototype.scrollIntoView = original;
        scrolled.length = 0;
    });

    it('should scroll the selected story into view when the menu mounts', async () => {
        Element.prototype.scrollIntoView = function (this: Element) {
            scrolled.push(this.textContent ?? '');
        };

        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);

        await renderList('story-30', 0);

        expect(host.querySelector('[data-selected]')?.textContent).toBe('story-30');
        expect(scrolled).toEqual(['story-30']);

        await renderList('story-30', 1);

        expect(scrolled).toEqual(['story-30']);

        await renderList('story-35', 2);

        expect(scrolled).toEqual(['story-30', 'story-35']);
    });
});
