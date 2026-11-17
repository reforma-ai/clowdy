import { CodeHighlighter } from '@clowdy/components/CodeHighlighter';
import { marked, type Token, type Tokens } from 'marked';
import { useMemo, type ReactNode } from 'react';

import styles from './Markdown.module.css';

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function isSafeLink(href: string): boolean {
    const url = URL.parse(href);

    return url !== null && SAFE_LINK_PROTOCOLS.has(url.protocol);
}

/** Inline tokens as React nodes. Raw HTML is shown as text and images as their alt text: nothing is injected. */
function renderInline(tokens: Token[] | undefined): ReactNode {
    return tokens?.map((token, index) => {
        switch (token.type) {
            case 'strong':
                return <strong key={ index }>{ renderInline((token as Tokens.Strong).tokens) }</strong>;
            case 'em':
                return <em key={ index }>{ renderInline((token as Tokens.Em).tokens) }</em>;
            case 'del':
                return <del key={ index }>{ renderInline((token as Tokens.Del).tokens) }</del>;
            case 'codespan':
                return <code key={ index }>{ (token as Tokens.Codespan).text }</code>;
            case 'br':
                return <br key={ index } />;
            case 'link': {
                const link = token as Tokens.Link;
                const label = renderInline(link.tokens);

                return isSafeLink(link.href)
                    ? <a key={ index } href={ link.href } title={ link.title ?? undefined } target="_blank" rel="noreferrer noopener">{ label }</a>
                    : <span key={ index }>{ label }</span>;
            }
            case 'image':
                return <span key={ index }>{ (token as Tokens.Image).text }</span>;
            case 'text': {
                const text = token as Tokens.Text;

                return text.tokens ? <span key={ index }>{ renderInline(text.tokens) }</span> : text.text;
            }
            default:
                return (token as { text?: string }).text ?? token.raw;
        }
    });
}

function renderBlocks(tokens: Token[]): ReactNode {
    return tokens.map((token, index) => {
        switch (token.type) {
            case 'space':
            case 'checkbox':
                return null;
            case 'paragraph':
                return <p key={ index }>{ renderInline((token as Tokens.Paragraph).tokens) }</p>;
            case 'text':
                // A list item's own text, outside any paragraph.
                return <span key={ index }>{ renderInline((token as Tokens.Text).tokens ?? [token]) }</span>;
            case 'heading': {
                const heading = token as Tokens.Heading;

                return <div key={ index } className={ styles.heading } role="heading" aria-level={ Math.min(heading.depth + 2, 6) }>{ renderInline(heading.tokens) }</div>;
            }
            case 'list': {
                const list = token as Tokens.List;
                const items = list.items.map((item, itemIndex) => (
                    <li key={ itemIndex } data-task={ item.task || undefined }>
                        { item.task && <input type="checkbox" checked={ item.checked === true } disabled aria-label={ item.checked ? 'Done' : 'Not done' } /> }
                        { renderBlocks(item.tokens) }
                    </li>
                ));

                return list.ordered ? <ol key={ index } start={ list.start === '' ? undefined : list.start }>{ items }</ol> : <ul key={ index }>{ items }</ul>;
            }
            case 'code': {
                const code = token as Tokens.Code;

                return <CodeHighlighter key={ index } className={ styles.code } language={ code.lang?.split(/\s/)[0] || 'text' } code={ code.text } />;
            }
            case 'blockquote':
                return <blockquote key={ index }>{ renderBlocks((token as Tokens.Blockquote).tokens) }</blockquote>;
            case 'hr':
                return <hr key={ index } />;
            case 'table': {
                const table = token as Tokens.Table;

                return (
                    <table key={ index }>
                        <thead>
                            <tr>{ table.header.map((cell, cellIndex) => <th key={ cellIndex } align={ cell.align ?? undefined }>{ renderInline(cell.tokens) }</th>) }</tr>
                        </thead>
                        <tbody>
                            { table.rows.map((row, rowIndex) => (
                                <tr key={ rowIndex }>{ row.map((cell, cellIndex) => <td key={ cellIndex } align={ cell.align ?? undefined }>{ renderInline(cell.tokens) }</td>) }</tr>
                            )) }
                        </tbody>
                    </table>
                );
            }
            default:
                // Raw HTML and anything unknown is text.
                return <p key={ index }>{ token.raw }</p>;
        }
    });
}

/** Assistant text: Markdown rendered into elements, never into HTML. */
export function Markdown({ text }: { text: string }) {
    const blocks = useMemo(() => renderBlocks(marked.lexer(text)), [text]);

    return <div className={ styles.markdown }>{ blocks }</div>;
}
