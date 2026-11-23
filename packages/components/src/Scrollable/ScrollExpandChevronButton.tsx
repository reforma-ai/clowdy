import { ChevronDown } from '@clowdy/icons/8';

import { Button, type ButtonProps } from '../Button';

import type { FC } from 'react';

export type ScrollExpandChevronButtonProps = {
    expanded: boolean;
    /** When the scroll region is collapsed (preview); activating expands to full content. */
    labelExpand: string;
    /** When full content is shown; activating collapses back to the preview height. */
    labelCollapse: string;
} & Omit<ButtonProps, 'children' | 'aria-expanded' | 'aria-label' | 'type'>;

/** Bottom-centered overlay control used with {@link Scrollable} `overlay` + height clamp on the scroll root. */
export const ScrollExpandChevronButton: FC<ScrollExpandChevronButtonProps> = ({
    expanded,
    labelExpand,
    labelCollapse,
    className,
    variant = 'transparent',
    size = 'xs',
    ...buttonRest
}) => (
    <Button
        {...buttonRest}
        type="button"
        variant={variant}
        size={size}
        className={className}
        aria-expanded={expanded}
        aria-label={expanded ? labelCollapse : labelExpand}
        fullWidth
    >
        <ChevronDown aria-hidden aria-expanded={expanded} className="chevron" />
    </Button>
);
