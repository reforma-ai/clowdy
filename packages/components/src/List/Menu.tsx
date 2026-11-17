import { cn, mergeRefs } from '@clowdy/lib';
import { useLayoutEffect, useRef, useState } from 'react';
import {
    Header as AriaHeader,
    Menu as AriaMenu,
    MenuItem as AriaMenuItem,
    MenuSection as AriaMenuSection,
    Separator as AriaSeparator,
    MenuTrigger,
    SubmenuTrigger,
    type MenuItemProps as AriaMenuItemProps,
    type MenuProps as AriaMenuProps,
    type MenuSectionProps as AriaMenuSectionProps,
    type SeparatorProps as AriaSeparatorProps,
} from 'react-aria-components';

import { Tooltip } from '../Tooltip';
import { resolveOverlayWidth, type OverlayWidth } from '../utils/resolveOverlayWidth';
import styles from './ListBox.module.css';
import { renderListRowItemContent } from './listRowItemContent';
import { useListHoverHighlight } from './useListHoverHighlight';
import { useScrollActiveListItem } from './useScrollActiveListItem';

import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';

export type {
    Key,
    MenuTriggerProps,
    SubmenuTriggerProps,
} from 'react-aria-components';

export {
    MenuTrigger,
    SubmenuTrigger,
};

export type MenuSize = 'sm' | 'md' | 'lg';

export interface MenuProps<T extends object = object> extends Omit<AriaMenuProps<T>, 'className' | 'style'> {
    className?: string;
    size?: MenuSize;
    interactive?: boolean;
    style?: CSSProperties;
    width?: OverlayWidth;
}

export interface MenuItemSlots {
    icon?: ReactNode;
    description?: ReactNode;
    startAffix?: ReactNode;
    endAffix?: ReactNode;
    stacked?: boolean;
}

export type MenuItemProps<T extends object = object> = Omit<AriaMenuItemProps<T>, 'className'>
  & MenuItemSlots & {
      className?: string;
      text?: string;
      isDanger?: boolean;
  };

/** Command / action list (RAC **Menu**). For picker content in a popover, wrap **`ListBox`** in **`PopoverScroll`**. */
export function Menu<T extends object>({
    className,
    size = 'sm',
    selectionMode = 'none',
    interactive = true,
    style: styleProp,
    width,
    ...props
}: MenuProps<T>) {
    const listRef = useRef<HTMLDivElement>(null);

    useListHoverHighlight(listRef, interactive);

    const widthStyle = resolveOverlayWidth(width);

    const style = (widthStyle != null || styleProp != null)
        ? { ...styleProp, ...widthStyle }
        : undefined;

    return (
        <AriaMenu
            className={ cn(styles.list, styles.menuList, className) }
            style={ style }
            selectionMode={ selectionMode }
            data-size={ size }
            data-interactive={ interactive || undefined }
            { ...props }
            ref={ listRef }
        />
    );
}

export function MenuItem<T extends object>({
    startAffix,
    icon,
    text,
    description,
    endAffix,
    stacked,
    children,
    className,
    isDanger,
    ref,
    ...props
}: MenuItemProps<T> & { ref?: Ref<HTMLDivElement> }) {
    const itemRef = useRef<HTMLDivElement>(null);
    const textValue = text || props.textValue || (typeof children === 'string' ? children : undefined);
    const [descriptionTruncated, setDescriptionTruncated] = useState(false);

    const scrollRef = useScrollActiveListItem(itemRef);

    useLayoutEffect(() => {
        if (typeof description !== 'string' || description.length === 0) {
            return;
        }

        const node = itemRef.current?.querySelector(`.${ CSS.escape(styles.itemDescription) }`);

        if (!(node instanceof HTMLElement)) {
            return;
        }

        const update = () => {
            const truncated = node.scrollWidth > node.clientWidth + 1;

            setDescriptionTruncated(current => (current === truncated ? current : truncated));
        };

        const frame = requestAnimationFrame(update);
        const observer = new ResizeObserver(update);

        observer.observe(node);

        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [description]);

    const item = (
        <AriaMenuItem
            ref={ mergeRefs(scrollRef, ref) }
            className={ cn(styles.item, stacked && styles.itemStacked, isDanger && styles.itemDanger, className) }
            textValue={ textValue }
            { ...props }
        >
            { renderListRowItemContent(children, {
                icon,
                description,
                startAffix,
                endAffix,
                stacked,
                textValue,
            }) }
        </AriaMenuItem>
    );

    if (typeof description !== 'string' || description.length === 0) {
        return item;
    }

    return (
        <Tooltip content={ description } placement="right" isDisabled={ !descriptionTruncated }>
            { item }
        </Tooltip>
    );
}

export function MenuSeparator({ className, ...props }: Omit<AriaSeparatorProps, 'className'> & { className?: string }) {
    return <AriaSeparator className={ cn(styles.menuSeparator, className) } { ...props } />;
}

export function MenuHeader({ className, sticky, ...props }: HTMLAttributes<HTMLElement> & { sticky?: boolean }) {
    return <AriaHeader className={ cn(styles.sectionHeader, className) } { ...props } data-sticky={ sticky || undefined } />;
}

export function MenuSection<T extends object>({ className, ...props }: Omit<AriaMenuSectionProps<T>, 'className'> & { className?: string }) {
    return <AriaMenuSection className={ cn(styles.section, className) } { ...props } />;
}

Menu.displayName = 'Menu';
MenuItem.displayName = 'MenuItem';
MenuSeparator.displayName = 'MenuSeparator';
MenuHeader.displayName = 'MenuHeader';
MenuSection.displayName = 'MenuSection';
