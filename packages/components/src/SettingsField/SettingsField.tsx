import { cn } from '@clowdy/lib';

import { FormField, type FormFieldProps } from '../FormField';
import styles from './SettingsField.module.css';

export type SettingsFieldLayout = FormFieldProps['layout'];

/** `size` densifies padding only — FormField stays `md` so labels keep `heading-5`. */
export type SettingsFieldProps = Omit<FormFieldProps, 'size'> & {
    size?: 'sm' | 'md';
};

function SettingsFieldRoot({ className, size = 'md', ...props }: SettingsFieldProps) {
    return (
        <FormField
            { ...props }
            size="md"
            className={ cn(styles.field, size === 'sm' && styles.sizeSm, className) }
        />
    );
}

export const SettingsField = Object.assign(SettingsFieldRoot, {
    Label: FormField.Label,
    Description: FormField.Description,
    Error: FormField.Error,
});

SettingsFieldRoot.displayName = 'SettingsField';
