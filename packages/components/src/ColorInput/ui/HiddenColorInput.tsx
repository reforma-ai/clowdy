import { Show } from '../../Show';

export function HiddenColorInput({
    name,
    form,
    value,
    isDisabled,
}: {
    name?: string;
    form?: string;
    value: string;
    isDisabled?: boolean;
}) {
    return (
        <Show when={name}>
            {inputName => <input type="hidden" name={inputName} form={form} value={value} disabled={isDisabled} />}
        </Show>
    );
}
