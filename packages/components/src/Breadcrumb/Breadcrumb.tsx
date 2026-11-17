import { MOTION_EASE_UI } from '@clowdy/constants';
import { ChevronRight } from '@clowdy/icons/8';
import { cn } from '@clowdy/lib';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { Button, type ButtonProps } from '../Button';
import textStyles from '../Text/Text.module.css';
import styles from './Breadcrumb.module.css';

import type { ReactNode } from 'react';
import type { TextVariant } from '../types';

const ENTER_DURATION_S = 0.35;

export interface BreadcrumbProps {
    /** Typography; omit to inherit from the parent. Same tokens as `Text`. */
    variant?: TextVariant;
    className?: string;
    'aria-label'?: string;
    children: ReactNode;
}

function BreadcrumbRoot({
    variant,
    className,
    'aria-label': ariaLabel = 'Breadcrumb',
    children,
}: BreadcrumbProps) {
    return (
        <nav
            aria-label={ ariaLabel }
            className={ cn(styles.root, variant && textStyles[variant], className) }
        >
            <ol className={ styles.list }>
                <AnimatePresence initial={ false }>
                    { children }
                </AnimatePresence>
            </ol>
        </nav>
    );
}

function Sep() {
    return <ChevronRight className={ styles.sep } aria-hidden />;
}

export type BreadcrumbLinkProps = Pick<
    ButtonProps,
    'onPress' | 'href' | 'className' | 'children' | 'isDisabled' | 'target' | 'rel'
>;

function Link({ className, children, ...props }: BreadcrumbLinkProps) {
    return (
        <li className={ styles.item }>
            <Sep />
            <Button
                { ...props }
                className={ className }
                variant="inline"
                color="secondary"
                size="unset"
                truncate
            >
                { children }
            </Button>
        </li>
    );
}

export interface BreadcrumbPageProps {
    className?: string;
    children: ReactNode;
}

function Page({ className, children }: BreadcrumbPageProps) {
    const reducedMotion = useReducedMotion();

    return (
        <motion.li
            className={ styles.item }
            initial={ reducedMotion ? false : { opacity: 0.6, x: -10 } }
            animate={ { opacity: 1, x: 0 } }
            transition={ { duration: reducedMotion ? 0 : ENTER_DURATION_S, ease: MOTION_EASE_UI } }
        >
            <Sep />
            <span className={ cn(styles.page, className) } aria-current="page">
                { children }
            </span>
        </motion.li>
    );
}

export const Breadcrumb = Object.assign(BreadcrumbRoot, {
    Link,
    Page,
});

BreadcrumbRoot.displayName = 'Breadcrumb';
Link.displayName = 'Breadcrumb.Link';
Page.displayName = 'Breadcrumb.Page';
