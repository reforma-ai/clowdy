import { CodeHighlighter } from '@clowdy/components/CodeHighlighter';
import { Show } from '@clowdy/components/Show';
import { getLanguageFromPath } from '@clowdy/lib';

import { parseCodeFenceInfo } from '../codeCitation';
import { FileChip } from '../FileChip';
import { sanitizeStreamdownProps } from '../sanitizeStreamdownProps';

import type { HTMLAttributes, ReactNode } from 'react';
import type { ExtraProps } from 'streamdown';

type StreamdownCodeProps = Omit<ExtraProps, keyof ExtraProps> & HTMLAttributes<HTMLElement> & {
    className?: string;
    children?: ReactNode;
    onScroll?: unknown;
};

/** Fenced code: a block with a language is highlighted as it is; one that names a file (` ```src/a.ts ` or ` ```12:20:src/a.ts `) gets the file's chip over it and its line numbers. */
export function StreamdownCodeBlock(props: ExtraProps) {
    const { className, children, onScroll: _onScroll, ...rest } = sanitizeStreamdownProps(props) as StreamdownCodeProps;
    const parsed = parseCodeFenceInfo(className);
    const code = children?.toString() ?? '';
    const file = parsed.kind === 'file' ? parsed : undefined;
    const language = file ? getLanguageFromPath(file.path) : parsed.kind === 'language' ? parsed.language : 'text';
    const lines = file?.startLine != null && file.endLine != null ? `${ file.startLine }-${ file.endLine }` : undefined;

    return (
        <div data-streamdown="code-block">
            <Show when={ file }>
                { cited => (
                    <div data-streamdown="code-block-header">
                        <FileChip path={ cited.path } lines={ lines } />
                    </div>
                ) }
            </Show>

            <CodeHighlighter
                data-streamdown="code-block-body"
                className={ className }
                collapseThresholdLines={ 24 }
                language={ language }
                code={ code }
                dedent
                showLineNumbers={ lines !== undefined }
                startingLineNumber={ file?.startLine }
                { ...rest }
            />
        </div>
    );
}
