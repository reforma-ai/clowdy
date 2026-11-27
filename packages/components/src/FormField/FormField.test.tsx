// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SettingsLayout } from '../SettingsLayout';
import { Switch } from '../Switch';
import { Textarea } from '../Textarea';
import { FormField } from './FormField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('FormField with a Textarea', () => {
    it('labels a disabled textarea and leaves no React prop on the element', () => {
        act(() =>
            root.render(
                <FormField layout="vertical" isDisabled>
                    <FormField.Label>Command</FormField.Label>
                    <Textarea />
                </FormField>
            )
        );

        const textarea = container.querySelector('textarea')!;
        const label = container.querySelector('label')!;

        expect([
            label.htmlFor === textarea.id,
            textarea.disabled,
            textarea.hasAttribute('isdisabled'),
            textarea.hasAttribute('isinvalid'),
        ]).toEqual([true, true, false, false]);
    });
});

describe('SettingsLayout.Row', () => {
    it('names its switch by the title and describes it by the description', () => {
        act(() =>
            root.render(
                <SettingsLayout.Row title="Sleep" description="Keep the Mac awake while agents work">
                    <Switch />
                </SettingsLayout.Row>
            )
        );

        const control = container.querySelector('input')!;
        const text = (attribute: string) => document.getElementById(control.getAttribute(attribute)!)?.textContent;

        expect([text('aria-labelledby'), text('aria-describedby')]).toEqual([
            'Sleep',
            'Keep the Mac awake while agents work',
        ]);
    });
});
