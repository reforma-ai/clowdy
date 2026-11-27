import { cn } from '@clowdy/lib';
import { type ElementType, type HTMLAttributes, type ReactNode, useId } from 'react';
import {
    CheckboxContext,
    NumberFieldContext,
    Provider,
    RadioGroupContext,
    SelectContext,
    SwitchContext,
    TextAreaContext,
    TextFieldContext,
    ToggleButtonGroupContext,
} from 'react-aria-components';

import { Text } from '../Text';
import styles from './SettingsKit.module.css';

export interface SettingsSectionProps {
    title: string;
    /** A small count or chip after the title. */
    aside?: ReactNode;
    /** What the group is, under the heading. */
    description?: ReactNode;
    /** Usually a `SettingsLayout.Card`. */
    children?: ReactNode;
}

/** A group of settings: an `h2` that names the section, a line on what it is, and the card that holds them. */
function Section({ title, aside, description, children }: SettingsSectionProps) {
    const titleId = useId();

    return (
        <section className={styles.section} aria-labelledby={titleId}>
            <div className={styles.caption}>
                <div className={styles.heading}>
                    <Text as="h2" id={titleId} variant="heading-5" className={styles.title}>
                        {title}
                    </Text>
                    {aside}
                </div>
                {description && (
                    <Text variant="sm" color="secondary">
                        {description}
                    </Text>
                )}
            </div>
            {children}
        </section>
    );
}

export interface SettingsCardProps extends HTMLAttributes<HTMLElement> {
    /** `ul` for a card of `li` rows, `section` for a card that is a landmark of its own. */
    as?: 'div' | 'ul' | 'section';
    /** A hairline between the card's blocks. A card that draws its own dividers leaves it off. */
    divided?: boolean;
}

/** The surface settings sit on: a bordered plate on the float background. It has no padding: its rows and blocks bring the inset. */
function Card({ as: Tag = 'div', divided = false, className, ...props }: SettingsCardProps) {
    // `div`, `ul` and `section` take the same props here; the union of their element types does not.
    const Element = Tag as ElementType;

    return <Element {...props} className={cn(styles.card, className)} data-divided={divided || undefined} />;
}

export interface SettingsBlockProps extends HTMLAttributes<HTMLElement> {
    /** `li` for a block of a card that is a list. */
    as?: 'div' | 'li';
}

/** Anything in a card that is not a `Row`: a group of controls, a chart, a sign-in. It brings the card's inset; lay its content out with a class of the feature's own. */
function Block({ as: Tag = 'div', className, ...props }: SettingsBlockProps) {
    const Element = Tag as ElementType;

    return <Element {...props} className={cn(styles.block, className)} />;
}

export interface SettingsRowProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
    title: ReactNode;
    description?: ReactNode;
    /**
     * The control, at the end of the row. A switch, checkbox, text or number field, textarea, select, radio or toggle group in it is labelled by the
     * title and described by the description.
     */
    children?: ReactNode;
    /** The control goes under the text and takes the row's width. */
    stacked?: boolean;
    /** Full width under the row: a notice about it, an alert. */
    footer?: ReactNode;
    /** `li` for a row of a card that is a list. */
    as?: 'div' | 'li';
    /** The card's inset around the row (the default); off for a row inside a block or a list of the feature's own. */
    inset?: boolean;
    /** A fixed width for the control (`14rem`), so the controls of a card line up. */
    controlWidth?: string;
}

/** One setting: what it is, a line on what it does, and its control at the end, as in macOS and iOS settings. */
function Row({
    title,
    description,
    children,
    stacked = false,
    footer,
    as: Tag = 'div',
    inset = true,
    controlWidth,
    className,
    style,
    ...props
}: SettingsRowProps) {
    const Element = Tag as ElementType;
    const titleId = useId();
    const descriptionId = useId();
    const labelled = { 'aria-labelledby': titleId, 'aria-describedby': description ? descriptionId : undefined };

    return (
        <Element
            {...props}
            className={cn(styles.row, inset && styles.block, className)}
            style={controlWidth ? { ...style, '--settings-control-width': controlWidth } : style}
            data-stacked={stacked || undefined}
            data-control-width={controlWidth ? '' : undefined}
        >
            <div className={styles.text}>
                <Text id={titleId} variant="sm" weight="medium">
                    {title}
                </Text>
                {description && (
                    <Text id={descriptionId} variant="sm" color="secondary">
                        {description}
                    </Text>
                )}
            </div>
            {children && (
                <Provider
                    values={[
                        [SwitchContext, labelled],
                        [CheckboxContext, labelled],
                        [TextFieldContext, labelled],
                        [NumberFieldContext, labelled],
                        [TextAreaContext, labelled],
                        [SelectContext, labelled],
                        [RadioGroupContext, labelled],
                        [ToggleButtonGroupContext, labelled],
                    ]}
                >
                    <div className={styles.control}>{children}</div>
                </Provider>
            )}
            {footer && <div className={styles.footer}>{footer}</div>}
        </Element>
    );
}

Section.displayName = 'SettingsLayout.Section';
Card.displayName = 'SettingsLayout.Card';
Block.displayName = 'SettingsLayout.Block';
Row.displayName = 'SettingsLayout.Row';

export { Block, Card, Row, Section };
