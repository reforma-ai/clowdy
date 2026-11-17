import { cn } from '@clowdy/lib';
import { useState } from 'react';

import { Show } from '../Show';
import { Text } from '../Text';
import styles from './Avatar.module.css';

import type { HTMLAttributes, ReactNode, Ref } from 'react';

export type AvatarSize = 'xxs' | 'sm' | 'md';

export interface AvatarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
    ref?: Ref<HTMLDivElement>;
    size?: AvatarSize;
    color?: 'secondary' | 'primary';
    rounded?: boolean;
    src?: string;
    alt?: string;
    fallback?: ReactNode;
    title?: ReactNode;
    description?: ReactNode;
    className?: string;
}

export function Avatar({
    size = 'md',
    color = 'secondary',
    rounded,
    src,
    alt,
    fallback,
    title,
    description,
    className,
    ...attrs
}: AvatarProps) {
    const [isError, setIsError] = useState(false);
    const shouldShowImage = Boolean(src) && !isError;
    const hasText = title != null || description != null;

    const avatarNode = (
        <div
            data-size={ size }
            data-color={ color }
            data-rounded={ rounded }
            className={ styles.avatar }
        >
            <Show when={ shouldShowImage }>
                <img
                    src={ src }
                    alt={ alt }
                    className={ styles.image }
                    onError={ () => setIsError(true) }
                />
            </Show>

            <Show when={ !shouldShowImage }>
                <div className={ styles.fallback }>
                    { fallback }
                </div>
            </Show>
        </div>
    );

    if (!hasText) {
        return (
            <div className={ cn(styles.root, className) } { ...attrs }>
                { avatarNode }
            </div>
        );
    }

    return (
        <div
            className={ cn(styles.root, styles.withInfo, className) }
            { ...attrs }
        >
            { avatarNode }

            <div className={ styles.infoBlock }>
                <Show when={ title != null }>
                    <Text variant="heading-5" truncate>{ title }</Text>
                </Show>
                <Show when={ description != null }>
                    <Text variant="sm" color="secondary" truncate>{ description }</Text>
                </Show>
            </div>
        </div>
    );
}

Avatar.displayName = 'Avatar';

