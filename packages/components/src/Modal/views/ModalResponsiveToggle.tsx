import { observer } from 'mobx-react-lite';

import { Show } from '../../Show';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '../../ToggleButtonGroup';

import type { ModalInstance, ModalTabOptions } from '../typings';

export type ModalResponsiveToggleProps = {
    modal: ModalInstance;
    className?: string;
};

export const ModalResponsiveToggle = observer(({ modal, className }: ModalResponsiveToggleProps) => {
    const options = modal.currentOptions as ModalTabOptions;
    const adaptive = options?.adaptive;
    const responsiveModes = options?.responsiveModes;

    const responsiveModesList = (!adaptive || !responsiveModes)
        ? []
        : Object.keys(adaptive)
            .map((value) => {
                const meta = responsiveModes[value];

                if (!meta) {
                    return null;
                }

                return { value, icon: meta.icon, iconSize: meta.iconSize, tip: meta.tip };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);

    let responsiveMode = modal.responsiveMode;

    if (!responsiveModesList.some(item => item.value === responsiveMode)) {
        responsiveMode = 'all';
    }

    const showAdaptiveToggle = responsiveModesList.length > 1;

    return (
        <Show when={ showAdaptiveToggle }>
            <ToggleButtonGroup
                variant="transparent"
                selectedKeys={ responsiveMode ?? undefined }
                onSelectionChange={ (keys) => {
                    const key = keys.values().next().value;

                    if (key != null) {
                        modal.toggleResponsiveMode(String(key));
                    }
                } }
                className={ className }
            >
                { responsiveModesList.map(item => (
                    <ToggleButtonGroupItem key={ item.value } value={ item.value }>
                        { item.tip }
                    </ToggleButtonGroupItem>
                )) }
            </ToggleButtonGroup>
        </Show>
    );
});
