import { cn } from '@clowdy/lib';
import { Children, createContext, isValidElement, type ReactNode, use, useId } from 'react';
import {
    Provider,
    Label as RACLabel,
    type LabelProps as RACLabelProps,
    SelectContext,
    SwitchContext,
    TextAreaContext,
    TextFieldContext,
} from 'react-aria-components';

import { Show } from '../Show';
import { DEFAULT_SLOT, SlotContext } from '../Slot';
import { Text } from '../Text';
import styles from './FormField.module.css';

export type FormFieldSize = 'xs' | 'sm' | 'md' | 'lg';
export type FormFieldLayout = 'horizontal' | 'vertical';
export type FormFieldLabelPlacement = 'start' | 'top' | 'bottom';
export type FormFieldLabelAlign = 'start' | 'center' | 'end';

export interface FormFieldProps {
    size?: FormFieldSize;
    layout?: FormFieldLayout;
    labelPlacement?: FormFieldLabelPlacement;
    labelAlign?: FormFieldLabelAlign;
    isDisabled?: boolean;
    isInvalid?: boolean;
    className?: string;
    id?: string;
    children: ReactNode;
}

export interface FormFieldLabelProps extends Omit<RACLabelProps, 'className' | 'children'> {
    className?: string;
    children: ReactNode;
}

export interface FormFieldDescriptionProps {
    className?: string;
    children: ReactNode;
}

export interface FormFieldErrorProps {
    className?: string;
    children: ReactNode;
}

const LABEL_VARIANT = {
    xs: 'xs',
    sm: 'sm',
    md: 'heading-5',
    lg: 'heading-4',
} as const;

const DESCRIPTION_VARIANT = {
    xs: 'xs',
    sm: 'xs',
    md: 'sm',
    lg: 'md',
} as const;

interface FormFieldContextValue {
    size: FormFieldSize;
    controlId: string;
    descriptionId: string;
    errorId: string;
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null);

function useFormFieldContext(slot: string): FormFieldContextValue {
    const context = use(FormFieldContext);

    if (!context) {
        throw new Error(`${slot} must be used within FormField`);
    }

    return context;
}

function labelPlacementFor(
    layout: FormFieldLayout,
    labelPlacement: FormFieldLabelPlacement | undefined
): FormFieldLabelPlacement {
    return labelPlacement ?? (layout === 'horizontal' ? 'start' : 'top');
}

function FormFieldLabel({ className, children, ...props }: FormFieldLabelProps) {
    const { size, controlId } = useFormFieldContext('FormField.Label');
    const content = typeof children === 'string' ? <Text variant={LABEL_VARIANT[size]}>{children}</Text> : children;

    return (
        <RACLabel {...props} htmlFor={controlId} data-slot="label" className={cn(styles.label, className)}>
            {content}
        </RACLabel>
    );
}

function FormFieldDescription({ className, children }: FormFieldDescriptionProps) {
    const { size, descriptionId } = useFormFieldContext('FormField.Description');

    return (
        <Text
            id={descriptionId}
            slot="description"
            data-slot="description"
            variant={DESCRIPTION_VARIANT[size]}
            color="secondary"
            className={cn(styles.description, className)}
        >
            {children}
        </Text>
    );
}

function FormFieldError({ className, children }: FormFieldErrorProps) {
    const { errorId } = useFormFieldContext('FormField.Error');

    if (children == null || children === false || children === '') {
        return null;
    }

    return (
        <Text
            id={errorId}
            data-slot="error"
            role="alert"
            variant="xs"
            color="danger"
            className={cn(styles.error, className)}
        >
            {children}
        </Text>
    );
}

function splitSlots(children: ReactNode) {
    const control: ReactNode[] = [];
    let label: ReactNode;
    let description: ReactNode;
    let error: ReactNode;

    Children.forEach(children, child => {
        if (isValidElement(child) && child.type === FormFieldLabel) {
            label = child;

            return;
        }

        if (isValidElement(child) && child.type === FormFieldDescription) {
            description = child;

            return;
        }

        if (isValidElement(child) && child.type === FormFieldError) {
            error = child;

            return;
        }

        control.push(child);
    });

    return { label, description, error, control };
}

function FormFieldRoot({
    size = 'md',
    layout = 'horizontal',
    labelPlacement,
    labelAlign = 'start',
    isDisabled,
    isInvalid,
    className,
    id,
    children,
}: FormFieldProps) {
    const controlId = useId();
    const descriptionId = useId();
    const errorId = useId();
    const placement = labelPlacementFor(layout, labelPlacement);
    const { label, description, error, control } = splitSlots(children);
    const packCopy = Boolean(description) && placement !== 'bottom';
    const describedBy =
        [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
    const fieldProps = {
        id: controlId,
        isDisabled: isDisabled || undefined,
        isInvalid: isInvalid || undefined,
        'aria-describedby': describedBy,
    };
    // RAC's TextArea is a bare `<textarea>` that spreads its context onto the DOM, so it gets only DOM props; `Textarea` reads the
    // disabled and invalid state from the SlotContext below.
    const textAreaProps = { id: controlId, 'aria-describedby': describedBy };
    const slotProps = {
        isDisabled: isDisabled || undefined,
        isInvalid: isInvalid || undefined,
        'aria-describedby': describedBy,
    };

    return (
        <FormFieldContext value={{ size, controlId, descriptionId, errorId }}>
            <Provider
                values={[
                    [SlotContext, { slots: { [DEFAULT_SLOT]: slotProps, description: { id: descriptionId } } }],
                    [TextFieldContext, fieldProps],
                    [TextAreaContext, textAreaProps],
                    [SelectContext, fieldProps],
                    [SwitchContext, fieldProps],
                ]}
            >
                <div
                    id={id}
                    className={cn(styles.field, className)}
                    data-size={size}
                    data-layout={layout}
                    data-label-placement={placement}
                    data-label-align={labelAlign}
                    data-has-control={control.length > 0 || error ? '' : undefined}
                    data-has-description={description ? '' : undefined}
                    data-has-error={error ? '' : undefined}
                    data-disabled={isDisabled || undefined}
                    data-invalid={isInvalid || undefined}
                >
                    {packCopy ? (
                        <div data-slot="copy" className={styles.copy}>
                            {label}
                            {description}
                        </div>
                    ) : (
                        label
                    )}
                    <Show when={control.length > 0 || error}>
                        <div data-slot="control" className={styles.control}>
                            <div className={styles.controlBody}>{control}</div>
                            {error}
                        </div>
                    </Show>
                    <Show when={!packCopy && description}>{description}</Show>
                </div>
            </Provider>
        </FormFieldContext>
    );
}

export const FormField = Object.assign(FormFieldRoot, {
    Label: FormFieldLabel,
    Description: FormFieldDescription,
    Error: FormFieldError,
});

FormFieldRoot.displayName = 'FormField';
FormFieldLabel.displayName = 'FormField.Label';
FormFieldDescription.displayName = 'FormField.Description';
FormFieldError.displayName = 'FormField.Error';
