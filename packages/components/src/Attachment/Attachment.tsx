import { IMAGE_EXTENSIONS } from '@clowdy/constants';
import { Close, File } from '@clowdy/icons/12';
import { Refresh } from '@clowdy/icons/14';
import { cn, extractExtension, formatFileSize } from '@clowdy/lib';
import {
    Children,
    useState,
    type ComponentProps,
    type HTMLAttributes,
} from 'react';

import { Button } from '../Button';
import { FileIcon } from '../FileIcon';
import { Image } from '../Image';
import { Lightbox } from '../Lightbox';
import { Show } from '../Show';
import { Spinner } from '../Spinner';
import { Text } from '../Text';
import styles from './Attachment.module.css';

/** What a card needs to know about a file. Not tied to any transport or storage. */
export type AttachmentData = {
    id?: string;
    /** Display name; wins over `filename`. */
    title?: string;
    filename?: string;
    url?: string;
    /** Local preview (e.g. a `blob:` URL) shown before `url` exists; wins over `url`. */
    preview?: string;
    /** IANA media type. */
    mediaType?: string;
    /** Bytes. */
    size?: number;
};

export type AttachmentsSize = 'sm' | 'md';

export type AttachmentsProps = HTMLAttributes<HTMLDivElement> & {
    /** How big the card is: its preview, its text and its width. @default 'md' */
    size?: AttachmentsSize;
    /**
     * Max cards shown before a "+N" control that reveals the rest; unset or non-positive shows all.
     * Pass each `<Attachment />` as a **direct child** (e.g. `items.map(...)`) so the list can be split;
     * one wrapper child counts as one item.
     */
    defaultLimitCount?: number;
    /** Tooltip of the "+N" control. @default 'Show more' */
    showMoreLabel?: string;
};

/** A wrapping row of {@link Attachment} cards. */
export function Attachments({
    size = 'md',
    defaultLimitCount,
    showMoreLabel = 'Show more',
    className,
    children,
    ...props
}: AttachmentsProps) {
    const [expanded, setExpanded] = useState(false);
    const items = Children.toArray(children);
    const limit = Math.floor(defaultLimitCount ?? 0);
    const collapsed = limit > 0 && !expanded && items.length > limit;
    const hiddenCount = collapsed ? items.length - limit : 0;

    return (
        <div
            className={ cn(styles.attachments, className) }
            data-slot="attachments"
            data-size={ size }
            { ...props }
        >
            { collapsed ? items.slice(0, limit) : items }

            <Show when={ collapsed }>
                <Button
                    className={ styles.showMore }
                    type="button"
                    variant="ghost"
                    size="unset"
                    data-slot="attachments-show-more"
                    tooltip={ showMoreLabel }
                    tooltipPlacement="top"
                    onPress={ () => setExpanded(true) }
                >
                    <Text variant="label">{ `+${ hiddenCount }` }</Text>
                </Button>
            </Show>
        </div>
    );
}

export type AttachmentProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
    data: AttachmentData;
    /** Spinner in place of the preview. Hides remove and sets `aria-busy`. */
    loading?: boolean;
    /** Red outline and dimmed preview. With `onRetry`, a retry button sits over the preview. */
    error?: boolean;
    /** Shows the retry button while `error`. */
    onRetry?: () => void;
    /** Shows the remove button (not while `loading`). Leave unset for a read-only card. */
    onRemove?: () => void;
    /**
     * Makes the whole card a button. Remove stays a sibling, so no `<button>` nests in another.
     * Ignored while `loading` or `error`.
     */
    onPress?: ComponentProps<typeof Button>['onPress'];
};

/** One attachment card: image preview or file icon beside the name and size, with loading, error, retry and remove states. */
export function Attachment({
    data,
    loading = false,
    error = false,
    onRetry,
    onRemove,
    onPress,
    className,
    ...props
}: AttachmentProps) {
    const label = attachmentLabel(data);
    const interactive = onPress !== undefined && !loading && !error;
    const removable = onRemove !== undefined && !loading;
    const size = data.size === undefined ? undefined : formatFileSize(data.size);

    const content = (
        <>
            <Show
                when={ !loading }
                fallback={
                    <div className={ cn(styles.preview, styles.previewLoading) }>
                        <Spinner size="xs" />
                    </div>
                }
            >
                <Show when={ error } fallback={ <AttachmentPreview data={ data } label={ label } /> }>
                    <div className={ cn(styles.preview, styles.previewError) }>
                        <AttachmentPreview data={ data } label={ label } />
                        <Show when={ onRetry }>
                            <Button
                                type="button"
                                variant="filled"
                                rounded
                                size="unset"
                                iconOnly
                                className={ styles.retryButton }
                                aria-label={ `Retry ${ label }` }
                                tooltip="Retry"
                                tooltipPlacement="top"
                                onPress={ onRetry }
                            >
                                <Refresh />
                            </Button>
                        </Show>
                    </div>
                </Show>
            </Show>

            <div className={ styles.info }>
                <Text variant="label" truncate>{ label }</Text>
                <Show when={ size }>
                    <Text variant="label" truncate className={ styles.infoDetail }>{ size }</Text>
                </Show>
            </div>
        </>
    );

    return (
        <div
            className={ cn(
                styles.attachment,
                interactive && styles.pressable,
                error && styles.attachmentError,
                className
            ) }
            role="group"
            aria-label={ label }
            aria-busy={ loading || undefined }
            data-slot="attachment"
            data-attachment-id={ data.id ?? data.filename }
            data-interactive={ interactive || undefined }
            data-removable={ removable || undefined }
            data-loading={ loading || undefined }
            data-error={ error || undefined }
            { ...props }
        >
            <Show when={ interactive } fallback={ content }>
                <Button
                    type="button"
                    variant="transparent"
                    color="inherit"
                    size="unset"
                    fullWidth
                    truncate
                    className={ styles.attachmentHit }
                    aria-label={ label }
                    onPress={ onPress }
                >
                    { content }
                </Button>
            </Show>

            <Show when={ removable }>
                <Button
                    className={ styles.removeButton }
                    type="button"
                    variant="filled"
                    size="unset"
                    iconOnly
                    aria-label={ `Remove ${ label }` }
                    tooltip="Remove"
                    tooltipPlacement="top"
                    onPress={ onRemove }
                >
                    <Close />
                </Button>
            </Show>
        </div>
    );
}

/** An {@link Attachment} whose image opens in a {@link Lightbox} on press. Other files render as a plain card. */
export function PreviewableAttachment(props: AttachmentProps) {
    const src = imageSource(props.data);

    if (!src) {
        return <Attachment { ...props } />;
    }

    return (
        <Lightbox src={ src } alt={ attachmentLabel(props.data) }>
            { open => <Attachment { ...props } onPress={ open } /> }
        </Lightbox>
    );
}

/** The image when there is one to show, else the file's icon. A source that fails to load falls back to the icon. */
function AttachmentPreview({ data, label }: { data: AttachmentData; label: string }) {
    const src = imageSource(data);
    const [failedSrc, setFailedSrc] = useState<string>();

    return (
        <Show
            when={ src && src !== failedSrc }
            fallback={
                <div className={ cn(styles.preview, styles.previewIcon) }>
                    <Show when={ data.filename } fallback={ <File /> }>
                        { filename => <FileIcon path={ filename } kind="file" /> }
                    </Show>
                </div>
            }
        >
            <Image
                className={ cn(styles.preview, styles.previewImg) }
                src={ src }
                alt={ label }
                onError={ () => setFailedSrc(src) }
            />
        </Show>
    );
}

function isImage({ mediaType, filename, preview, url }: AttachmentData): boolean {
    return Boolean(mediaType?.startsWith('image/'))
        || [filename, preview, url].some(name => IMAGE_EXTENSIONS.includes(extractExtension(name) ?? ''));
}

/** The URL to draw, for an image only. */
function imageSource(data: AttachmentData): string | undefined {
    const src = data.preview ?? data.url;

    return src && isImage(data) ? src : undefined;
}

function attachmentLabel(data: AttachmentData): string {
    return data.title || data.filename || (isImage(data) ? 'Image' : 'Attachment');
}
