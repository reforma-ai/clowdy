// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Attachment, Attachments, type AttachmentData } from './Attachment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const render = (element: React.ReactNode) => act(() => root.render(element));
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${ label }"]`);
const press = (element: HTMLElement | null) => act(() => {
    // React Aria presses listen to pointer events, then fire `onPress` on pointer up.
    const init = { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 1, clientY: 1 };

    element?.dispatchEvent(new PointerEvent('pointerdown', init));
    element?.dispatchEvent(new PointerEvent('pointerup', init));
    element?.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
});

const photo: AttachmentData = {
    id: 'a1',
    filename: 'photo.png',
    mediaType: 'image/png',
    url: 'https://example.com/photo.png',
    preview: 'blob:http://localhost/preview-1',
    size: 2048,
};
const report: AttachmentData = { id: 'a2', filename: 'report.pdf', mediaType: 'application/pdf', size: 3 * 1024 * 1024 };

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('Attachment', () => {
    it('shows the name and size on the card, whether it is alone or among others', () => {
        render(
            <Attachments>
                <Attachment data={ report } />
                <Attachment data={ photo } />
            </Attachments>
        );

        expect(container.textContent).toContain('report.pdf');
        expect(container.textContent).toContain('3.0 MB');
        expect(container.textContent).toContain(photo.filename ?? '');
    });

    it('prefers the title over the filename', () => {
        render(<Attachment data={ { ...report, title: 'Q3 report' } } />);

        expect(container.querySelector('[data-slot="attachment"]')?.getAttribute('aria-label')).toBe('Q3 report');
    });

    it('draws an image from its preview, then its url', () => {
        render(<Attachment data={ photo } />);

        expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:http://localhost/preview-1');

        render(<Attachment data={ { ...photo, preview: undefined } } />);

        expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/photo.png');
    });

    it('recognizes an image by its media type alone', () => {
        render(<Attachment data={ { mediaType: 'image/webp', preview: 'blob:http://localhost/x' } } />);

        expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:http://localhost/x');
        expect(container.querySelector('[data-slot="attachment"]')?.getAttribute('aria-label')).toBe('Image');
    });

    it('shows a file icon instead of an image for other files', () => {
        render(<Attachment data={ { ...report, url: 'https://example.com/report.pdf' } } />);

        const images = container.querySelectorAll('img');

        // The Material icon is the only image, and it has no alt text.
        expect(images).toHaveLength(1);
        expect(images[0]?.getAttribute('alt')).toBe('');
        expect(images[0]?.getAttribute('src')).not.toContain('example.com');
    });

    it('falls back to the file icon when the image fails to load', () => {
        render(<Attachment data={ photo } />);

        act(() => {
            container.querySelector('img')?.dispatchEvent(new Event('error'));
        });

        expect(container.querySelector('img')?.getAttribute('src')).not.toBe('blob:http://localhost/preview-1');
        expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    });

    it('removes through the remove button', () => {
        const onRemove = vi.fn();

        render(<Attachment data={ report } onRemove={ onRemove } />);
        press(button('Remove report.pdf'));

        expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it('has no remove button without onRemove', () => {
        render(<Attachment data={ report } />);

        expect(container.querySelector('button')).toBeNull();
    });

    it('retries through the retry button on error', () => {
        const onRetry = vi.fn();

        render(<Attachment data={ report } error onRetry={ onRetry } />);

        expect(container.querySelector('[data-slot="attachment"]')?.getAttribute('data-error')).toBe('true');

        press(button('Retry report.pdf'));

        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('has no retry button without onRetry, or without an error', () => {
        render(<Attachment data={ report } error />);

        expect(container.querySelector('button')).toBeNull();

        render(<Attachment data={ report } onRetry={ vi.fn() } />);

        expect(container.querySelector('button')).toBeNull();
    });

    it('keeps remove next to retry on error', () => {
        render(<Attachment data={ report } error onRetry={ vi.fn() } onRemove={ vi.fn() } />);

        expect(button('Retry report.pdf')).not.toBeNull();
        expect(button('Remove report.pdf')).not.toBeNull();
    });

    it('shows a spinner while loading, without remove, retry or the image', () => {
        render(<Attachment data={ photo } loading onRemove={ vi.fn() } onRetry={ vi.fn() } error />);

        const tile = container.querySelector('[data-slot="attachment"]');

        expect(tile?.getAttribute('aria-busy')).toBe('true');
        expect(container.querySelector('[role="status"]')).not.toBeNull();
        expect(container.querySelector('button')).toBeNull();
        expect(container.querySelector('img')).toBeNull();
    });

    it('presses through the whole tile when onPress is set, but not while loading or on error', () => {
        const onPress = vi.fn();

        render(<Attachment data={ report } onPress={ onPress } />);
        press(button('report.pdf'));

        expect(onPress).toHaveBeenCalledTimes(1);

        render(<Attachment data={ report } onPress={ onPress } error />);

        expect(button('report.pdf')).toBeNull();

        render(<Attachment data={ report } onPress={ onPress } loading />);

        expect(button('report.pdf')).toBeNull();
    });
});

describe('Attachments', () => {
    const files = Array.from({ length: 5 }, (_, index): AttachmentData => ({ id: `f${ index }`, filename: `file-${ index }.txt` }));
    const tiles = () => container.querySelectorAll('[data-slot="attachment"]');
    const showMore = () => container.querySelector<HTMLButtonElement>('[data-slot="attachments-show-more"]');

    it('shows every tile without a limit', () => {
        render(<Attachments>{ files.map(file => <Attachment key={ file.id } data={ file } />) }</Attachments>);

        expect(tiles()).toHaveLength(5);
        expect(showMore()).toBeNull();
    });

    it('stops at the limit and counts the rest on the "+N" control', () => {
        render(<Attachments defaultLimitCount={ 3 }>{ files.map(file => <Attachment key={ file.id } data={ file } />) }</Attachments>);

        expect(tiles()).toHaveLength(3);
        expect(showMore()?.textContent).toBe('+2');
    });

    it('reveals the rest on "+N"', () => {
        render(<Attachments defaultLimitCount={ 3 }>{ files.map(file => <Attachment key={ file.id } data={ file } />) }</Attachments>);
        press(showMore());

        expect(tiles()).toHaveLength(5);
        expect(showMore()).toBeNull();
    });

    it('has no "+N" at or under the limit, or for a non-positive limit', () => {
        render(<Attachments defaultLimitCount={ 5 }>{ files.map(file => <Attachment key={ file.id } data={ file } />) }</Attachments>);

        expect(showMore()).toBeNull();

        render(<Attachments defaultLimitCount={ 0 }>{ files.map(file => <Attachment key={ file.id } data={ file } />) }</Attachments>);

        expect(tiles()).toHaveLength(5);
        expect(showMore()).toBeNull();
    });
});
