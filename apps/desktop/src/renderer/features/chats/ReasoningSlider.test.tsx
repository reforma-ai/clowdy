// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { progressFromTrackX, REASONING_DRAG_PULL, ReasoningSlider, stopAt, stopProgress } from './ReasoningSlider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Levels as the three agents spell them: the count is the agent's, not ours. */
const LEVELS = {
    6: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    5: ['low', 'medium', 'high', 'xhigh', 'max'],
    4: ['none', 'low', 'medium', 'high'],
    2: ['low', 'high'],
    1: ['high'],
    0: [],
} as const satisfies Record<number, readonly string[]>;

let container: HTMLDivElement;
let root: Root;
let changes: string[];
let drawn = 0;

/** Keeps the level it is told, as the picker does once the choice comes back. */
function Held({ levels, initial }: { levels: readonly string[]; initial: string | undefined }) {
    const [value, setValue] = useState(initial);

    return (
        <ReasoningSlider
            levels={levels}
            value={value}
            onChange={level => {
                changes.push(level);
                setValue(level);
            }}
        />
    );
}

// A new key makes a new slider that starts from `initial`, as the picker does for another model.
const draw = (levels: readonly string[], initial: string | undefined) =>
    act(async () => {
        root.render(<Held key={++drawn} levels={levels} initial={initial} />);
    });

const slider = () => container.querySelector<HTMLElement>('[role="slider"]')!;
const thumb = () => slider().lastElementChild as HTMLElement;
const key = (name: string) =>
    act(async () => {
        slider().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
const progress = () =>
    Number(slider().style.getPropertyValue('--level-anchor-p')) +
    Number(slider().style.getPropertyValue('--level-pointer-p'));

/** A 300px track at the left edge of the page with a 30px thumb, and a pointer that can be captured. */
function aim() {
    let captured = false;

    vi.spyOn(slider(), 'getBoundingClientRect').mockReturnValue({ left: 0, width: 300 } as DOMRect);
    vi.spyOn(thumb(), 'getBoundingClientRect').mockReturnValue({ width: 30 } as DOMRect);
    slider().setPointerCapture = vi.fn(() => {
        captured = true;
    });
    slider().hasPointerCapture = vi.fn(() => captured);
    slider().releasePointerCapture = vi.fn(() => {
        captured = false;
    });
}

const pointer = (type: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number) =>
    act(async () => {
        slider().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX }));
    });

beforeEach(() => {
    changes = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe('the track maths', () => {
    it('puts the stops evenly along the track, and the only stop at its start', () => {
        expect([0, 1, 2, 3].map(index => stopProgress(index, 4))).toEqual([0, 1 / 3, 2 / 3, 1]);
        expect(stopProgress(0, 1)).toBe(0);
        expect(stopProgress(0, 0)).toBe(0);
    });

    it('finds the stop nearest to the pointer', () => {
        expect([0, 0.2, 0.26, 0.5, 0.74, 0.8, 1].map(share => stopAt(share, 5))).toEqual([0, 1, 1, 2, 3, 3, 4]);
        expect(stopAt(0.9, 1)).toBe(0);
        expect(stopAt(0.9, 0)).toBe(0);
    });

    it('measures the pointer along the part of the track the thumb can travel, and keeps it inside', () => {
        const track = document.createElement('div');

        vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 300 } as DOMRect);

        expect(progressFromTrackX(100, track, 30)).toBe(0);
        expect(progressFromTrackX(115, track, 30)).toBe(0);
        expect(progressFromTrackX(250, track, 30)).toBeCloseTo(0.5);
        expect(progressFromTrackX(385, track, 30)).toBe(1);
        expect(progressFromTrackX(900, track, 30)).toBe(1);
        // A track no wider than its thumb has no way to travel.
        expect(progressFromTrackX(120, track, 300)).toBe(0);
    });
});

describe('the slider', () => {
    it('is a slider with a stop for each level and the level in force as its value, named as the person reads it', async () => {
        await draw(LEVELS[6], 'xhigh');

        expect(slider().getAttribute('aria-valuemin')).toBe('0');
        expect(slider().getAttribute('aria-valuemax')).toBe('5');
        expect(slider().getAttribute('aria-valuenow')).toBe('3');
        expect(slider().getAttribute('aria-valuetext')).toBe('Extra high');
        expect(slider().tabIndex).toBe(0);
        expect(container.querySelectorAll('[style*="--point-p"]')).toHaveLength(6);
    });

    it('reads a level the model does not offer, and none at all, as the first', async () => {
        await draw(LEVELS[4], 'max');

        expect(slider().getAttribute('aria-valuenow')).toBe('0');
        expect(slider().getAttribute('aria-valuetext')).toBe('None');

        await draw(LEVELS[4], undefined);

        expect(slider().getAttribute('aria-valuenow')).toBe('0');
    });

    describe.each([6, 5, 2] as const)('with %i levels', count => {
        const levels: readonly string[] = LEVELS[count];
        const first = levels[0]!;
        const last = levels.at(-1)!;

        it('steps with the arrow keys, one level each', async () => {
            await draw(levels, levels[1]);
            await key('ArrowRight');
            await key('ArrowUp');

            // Two levels leave nowhere to go from the upper one.
            expect(changes).toEqual(count === 2 ? [] : [levels[2], levels[3]]);

            changes.length = 0;
            await draw(levels, last);
            await key('ArrowLeft');
            await key('ArrowDown');

            // Two levels leave nowhere to go from the lower one.
            expect(changes).toEqual(count === 2 ? [levels.at(-2)] : [levels.at(-2), levels.at(-3)]);
        });

        it('goes to the ends with Home and End and stops there', async () => {
            await draw(levels, first);
            await key('End');
            await key('ArrowRight');
            await key('Home');
            await key('ArrowDown');
            await key('ArrowLeft');

            expect(changes).toEqual([last, first]);
        });

        it('keeps the thumb at the share of the track its level has', async () => {
            await draw(levels, levels[1]);

            expect(progress()).toBeCloseTo(1 / (count - 1));

            await key('End');

            expect(progress()).toBeCloseTo(1);
        });
    });

    it('leaves other keys alone, and says it took the ones it uses', async () => {
        await draw(LEVELS[5], 'high');

        const taken = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
        const left = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });

        await act(async () => {
            slider().dispatchEvent(taken);
            slider().dispatchEvent(left);
        });

        expect(taken.defaultPrevented).toBe(true);
        expect(left.defaultPrevented).toBe(false);
        expect(changes).toEqual(['xhigh']);
    });

    it('has nowhere to go with one level, and no NaN where the share of a stop is worked out', async () => {
        await draw(LEVELS[1], 'high');

        for (const name of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) await key(name);

        expect(changes).toEqual([]);
        expect(slider().getAttribute('aria-valuemax')).toBe('0');
        expect(slider().getAttribute('aria-valuenow')).toBe('0');
        expect(progress()).toBe(0);
        expect(slider().innerHTML).not.toContain('NaN');
        expect(slider().getAttribute('style')).not.toContain('NaN');
    });

    it('holds still with no levels', async () => {
        await draw(LEVELS[0], undefined);

        for (const name of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) await key(name);

        expect(changes).toEqual([]);
        expect(slider().getAttribute('aria-valuemax')).toBe('0');
        expect(slider().hasAttribute('aria-valuetext')).toBe(false);
        expect(progress()).toBe(0);
        expect(container.querySelectorAll('[style*="--point-p"]')).toHaveLength(0);

        aim();
        await pointer('pointerdown', 150);

        expect(changes).toEqual([]);
        expect(slider().getAttribute('style')).not.toContain('NaN');
    });
});

describe('dragging', () => {
    it('sets the level under the pointer at once, so a press on the track jumps to the nearest', async () => {
        await draw(LEVELS[4], 'none');
        aim();
        await pointer('pointerdown', 285);

        expect(changes).toEqual(['high']);
        expect(slider().setPointerCapture).toHaveBeenCalledWith(1);
        expect(slider().hasAttribute('data-dragging')).toBe(true);

        await pointer('pointerup', 285);

        expect(slider().hasAttribute('data-dragging')).toBe(false);
        expect(slider().releasePointerCapture).toHaveBeenCalledWith(1);
    });

    it('does nothing as the pointer goes over it with no press', async () => {
        await draw(LEVELS[4], 'none');
        aim();
        await pointer('pointermove', 285);
        await pointer('pointerup', 285);

        expect(changes).toEqual([]);
        expect(slider().hasAttribute('data-dragging')).toBe(false);
    });

    it('takes the level where the pointer is let go', async () => {
        await draw(LEVELS[5], 'low');
        aim();
        await pointer('pointerdown', 20);
        await pointer('pointerup', 290);

        expect(changes).toEqual(['max']);
    });

    it.each(['pointercancel', 'lostpointercapture'])('lets go of the thumb on %s', async type => {
        await draw(LEVELS[4], 'none');
        aim();
        await pointer('pointerdown', 150);

        expect(slider().hasAttribute('data-dragging')).toBe(true);

        await act(async () => {
            slider().dispatchEvent(new Event(type, { bubbles: true }));
        });

        expect(slider().hasAttribute('data-dragging')).toBe(false);
        expect(slider().querySelector('[data-hot]')).toBeNull();
    });

    it('ignores any button but the main one', async () => {
        await draw(LEVELS[4], 'none');
        aim();
        await act(async () => {
            slider().dispatchEvent(
                new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 285, button: 2 })
            );
        });

        expect(changes).toEqual([]);
        expect(slider().setPointerCapture).not.toHaveBeenCalled();
    });

    it('pulls the thumb toward the pointer, but only part of the way, so it stays near the level in force', async () => {
        await draw(LEVELS[4], 'low');
        aim();

        await pointer('pointerdown', 105);
        await pointer('pointermove', 125);

        const anchor = 1 / 3;
        const toward = 110 / 270;

        expect(progress()).toBeGreaterThan(anchor);
        expect(progress()).toBeLessThan((anchor + toward) / 2);
        expect(progress()).toBeCloseTo(anchor * (1 - REASONING_DRAG_PULL) + toward * REASONING_DRAG_PULL);
        // The pointer is still on the same stop, so nothing changed.
        expect(changes).toEqual([]);
        expect(slider().querySelector('[data-hot]')).not.toBeNull();

        await pointer('pointerup', 125);

        expect(progress()).toBeCloseTo(anchor);
        expect(slider().querySelector('[data-hot]')).toBeNull();
    });

    it('reports each level once as the pointer crosses it, not on every move', async () => {
        await draw(LEVELS[5], 'low');
        aim();

        // Stops sit 67.5px apart from 15px.
        await pointer('pointerdown', 20);
        await pointer('pointermove', 60);
        await pointer('pointermove', 100);
        await pointer('pointermove', 110);
        await pointer('pointermove', 125);
        await pointer('pointermove', 150);
        await pointer('pointermove', 230);
        await pointer('pointermove', 290);
        await pointer('pointermove', 295);
        await pointer('pointerup', 295);

        expect(changes).toEqual(['medium', 'high', 'xhigh', 'max']);
    });

    it('is not reset by the levels it passed coming back as the value, late and in turn, while the pointer is down', async () => {
        const onChange = vi.fn();
        const draw = (value: string) =>
            act(async () => {
                root.render(<ReasoningSlider levels={LEVELS[5]} value={value} onChange={onChange} />);
            });

        await draw('low');
        aim();

        // Stops sit 67.5px apart from 15px: the pointer goes to the second, then the third.
        await pointer('pointerdown', 85);
        await pointer('pointermove', 150);

        expect(onChange.mock.calls).toEqual([['medium'], ['high']]);

        // The second level comes back while the pointer is on the third; the pointer then moves a little and goes back to the second.
        await draw('medium');
        await pointer('pointermove', 152);

        expect(onChange).toHaveBeenCalledTimes(2);

        await pointer('pointermove', 85);

        // The daemon is on the third level, so the second has to be asked for again.
        expect(onChange.mock.calls).toEqual([['medium'], ['high'], ['medium']]);
    });

    it('asks for a level again with a key when a drag to it never came back as the value', async () => {
        const onChange = vi.fn();

        await act(async () => {
            root.render(<ReasoningSlider levels={LEVELS[5]} value="low" onChange={onChange} />);
        });
        aim();
        await pointer('pointerdown', 85);
        await pointer('pointerup', 85);

        expect(onChange.mock.calls).toEqual([['medium']]);

        await key('ArrowRight');

        expect(onChange.mock.calls).toEqual([['medium'], ['medium']]);
    });

    it('keeps reporting from where it is when a level never came back as the value', async () => {
        const onChange = vi.fn();

        await act(async () => {
            root.render(<ReasoningSlider levels={LEVELS[5]} value="low" onChange={onChange} />);
        });
        aim();
        await pointer('pointerdown', 285);
        await pointer('pointermove', 290);

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith('max');

        await pointer('pointerup', 290);
        // A new press starts from the value again: the same level is asked for once more.
        await pointer('pointerdown', 285);

        expect(onChange).toHaveBeenCalledTimes(2);
    });
});
