import { ChevronDown, ChevronUp } from '@clowdy/icons/8';
import { cn } from '@clowdy/lib';
import { createContext, use } from 'react';
import {
    composeRenderProps,
    Cell as RACCell,
    Column as RACColumn,
    Row as RACRow,
    Table as RACTable,
    TableBody as RACTableBody,
    TableFooter as RACTableFooter,
    TableHeader as RACTableHeader,
    type CellProps as RACCellProps,
    type ColumnProps as RACColumnProps,
    type RowProps as RACRowProps,
    type TableBodyProps as RACTableBodyProps,
    type TableFooterProps as RACTableFooterProps,
    type TableHeaderProps as RACTableHeaderProps,
    type TableProps as RACTableProps,
} from 'react-aria-components';

import { Scrollable } from '../Scrollable';
import styles from './Table.module.css';

import type { Ref } from 'react';

export type TableSize = 'xs' | 'sm' | 'md';
export type TableAlign = 'start' | 'center' | 'end';

export interface TableProps extends RACTableProps {
    size?: TableSize;
    /** Cap the scroller. Header sticks while rows scroll. */
    maxHeight?: number | string;
    scrollClassName?: string;
    scrollRef?: Ref<HTMLDivElement>;
}

export interface TableHeadProps extends RACColumnProps {
    align?: TableAlign;
}

export interface TableCellProps extends RACCellProps {
    align?: TableAlign;
}

export type TableHeaderProps<T extends object = object> = RACTableHeaderProps<T>;
export type TableBodyProps<T extends object = object> = RACTableBodyProps<T>;
export type TableFooterProps<T extends object = object> = RACTableFooterProps<T>;
export type TableRowProps<T extends object = object> = RACRowProps<T>;

/** When true, cell/column chrome must not keep focus (display tables). */
const TableStaticContext = createContext(true);

/** Ref callback: blur the element whenever it takes focus itself. RAC drops `onFocus` on Column/Cell. */
function rejectChromeFocus(element: HTMLElement | null) {
    if (!element) {
        return;
    }

    const blur = () => element.blur();

    element.addEventListener('focus', blur);

    return () => element.removeEventListener('focus', blur);
}

export function Table({
    size = 'sm',
    selectionMode = 'none',
    className,
    scrollClassName,
    scrollRef,
    maxHeight,
    ...props
}: TableProps) {
    const interactive = selectionMode !== 'none' || props.onRowAction != null;
    const cap = maxHeight != null;

    return (
        <TableStaticContext value={ !interactive }>
            <Scrollable
                containerRef={ scrollRef }
                className={ cn(styles.viewport, scrollClassName) }
                contentClass={ styles.viewportContent }
                horizontal
                vertical={ cap }
                data-max-height={ cap ? '' : undefined }
                style={ cap
                    ? { maxHeight: typeof maxHeight === 'number' ? `${ maxHeight }px` : maxHeight }
                    : undefined }
            >
                <RACTable
                    { ...props }
                    selectionMode={ selectionMode }
                    data-size={ size }
                    data-interactive={ interactive || undefined }
                    className={ composeRenderProps(className, className => cn(styles.table, className)) }
                />
            </Scrollable>
        </TableStaticContext>
    );
}

export function TableHeader<T extends object>({ className, ...props }: TableHeaderProps<T>) {
    return <RACTableHeader { ...props } className={ composeRenderProps(className, className => cn(styles.header, className)) } />;
}

export function TableBody<T extends object>({ className, ...props }: TableBodyProps<T>) {
    return <RACTableBody { ...props } className={ composeRenderProps(className, className => cn(styles.body, className)) } />;
}

export function TableFooter<T extends object>({ className, ...props }: TableFooterProps<T>) {
    return <RACTableFooter { ...props } className={ cn(styles.footer, className) } />;
}

export function TableHead({
    align,
    className,
    children,
    ...props
}: TableHeadProps) {
    const isStatic = use(TableStaticContext);

    return (
        <RACColumn
            { ...props }
            data-align={ align }
            className={ composeRenderProps(className, className => cn(styles.head, className)) }
            ref={ isStatic && !props.allowsSorting ? rejectChromeFocus : undefined }
        >
            { typeof children === 'function'
                ? children
                : ({ allowsSorting }) => (
                    <span className={ styles.headInner }>
                        <span className={ styles.headLabel }>{ children }</span>
                        { allowsSorting
                            ? (
                                <span className={ styles.sort } aria-hidden>
                                    <ChevronUp className={ styles.sortUp } />
                                    <ChevronDown className={ styles.sortDown } />
                                </span>
                            )
                            : null }
                    </span>
                ) }
        </RACColumn>
    );
}

export function TableRow<T extends object>({ className, ...props }: TableRowProps<T>) {
    return <RACRow { ...props } className={ composeRenderProps(className, className => cn(styles.row, className)) } />;
}

export function TableCell({
    align,
    className,
    ...props
}: TableCellProps) {
    const isStatic = use(TableStaticContext);

    return (
        <RACCell
            { ...props }
            data-align={ align }
            className={ composeRenderProps(className, className => cn(styles.cell, className)) }
            ref={ isStatic ? rejectChromeFocus : undefined }
        />
    );
}

Table.displayName = 'Table';
TableHeader.displayName = 'TableHeader';
TableBody.displayName = 'TableBody';
TableFooter.displayName = 'TableFooter';
TableHead.displayName = 'TableHead';
TableRow.displayName = 'TableRow';
TableCell.displayName = 'TableCell';
