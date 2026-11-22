import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { FileIcon } from '@clowdy/components/FileIcon';
import { For } from '@clowdy/components/For';
import { INPUT_CONTROL_AFFIX, SearchInput } from '@clowdy/components/Input';
import { GridList, GridListHeader, GridListItem, GridListSection, Menu, MenuItem } from '@clowdy/components/List';
import { PanelContent, PanelEmptyRow, PanelEmptyState, PanelLoadingState } from '@clowdy/components/Panel';
import { Popover, PopoverScroll, PopoverTrigger } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { Check, Close, Sliders } from '@clowdy/icons/14';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';

import { basename, dirname } from '../../paths';
import { Highlighted } from '../Highlighted';
import styles from './SearchView.module.css';

import type { FileManager } from '../../FileManager';
import type { SearchMatch, SearchResult } from '../../provider';
import type { TextSearch } from '../../search/TextSearch';

/** Typing searches once it pauses this long. */
const TYPING_DELAY = 250;
/** Characters of a line kept before its first match, so the match shows in a narrow panel. */
const LEAD = 24;

const OPTIONS = [
    { option: 'matchCase', label: 'Match case' },
    { option: 'wholeWord', label: 'Match whole word' },
] as const;

function countOf(count: number, noun: string): string {
    return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

function matchesIn(file: SearchResult['files'][number]): number {
    return file.matches.reduce((sum, match) => sum + match.ranges.length, 0);
}

/** The preview without its indentation, cut to start a little before its first match. */
function visiblePreview({ preview, ranges }: SearchMatch): Pick<SearchMatch, 'preview' | 'ranges'> {
    const first = ranges[0]?.start ?? 0;
    const indent = preview.length - preview.trimStart().length;
    const cut = Math.max(Math.min(indent, first), first - LEAD);
    const ellipsis = cut > indent ? '…' : '';
    const shift = cut - ellipsis.length;

    return {
        preview: ellipsis + preview.slice(cut),
        ranges: ranges.map(range => ({ start: range.start - shift, end: range.end - shift })),
    };
}

/** Opens the file with the match's first range selected. */
function openMatch(manager: FileManager, path: string, { line, column, ranges }: SearchMatch): void {
    const [first] = ranges;
    const length = first ? first.end - first.start : 0;

    void manager.open(path, { from: { line, column }, to: { line, column: column + length } });
}

function FileMatches({ manager, file }: { manager: FileManager; file: SearchResult['files'][number] }) {
    const folder = dirname(file.path);
    const count = matchesIn(file);

    return (
        <GridListSection>
            <GridListHeader sticky className={styles.file} title={file.path}>
                <FileIcon path={file.path} kind="file" className={styles.fileIcon} />
                <Text truncate variant="sm" color="default" className={styles.fileName}>
                    {basename(file.path)}
                </Text>
                <Show when={folder}>
                    <Text truncate color="secondary" className={styles.folder}>{`${folder}/`}</Text>
                </Show>
                <Show when={count > 1}>
                    <span className={styles.count}>{count}</span>
                </Show>
            </GridListHeader>
            <For each={file.matches}>
                {match => {
                    const { preview, ranges } = visiblePreview(match);

                    return (
                        <GridListItem
                            key={match.line}
                            id={`${file.path}:${match.line}`}
                            textValue={preview}
                            className={styles.match}
                            onAction={() => openMatch(manager, file.path, match)}
                        >
                            <span className={styles.preview}>
                                <Highlighted text={preview} ranges={ranges} />
                            </span>
                        </GridListItem>
                    );
                }}
            </For>
        </GridListSection>
    );
}

/**
 * The matches grouped by file, or why there are none. Apart from the form, so typing does not
 * render up to 2,000 rows again.
 */
const SearchResults = observer(function SearchResults({ manager }: { manager: FileManager }) {
    const { result, loading, error } = manager.search;

    if (error) {
        return (
            <PanelEmptyState
                title="Couldn’t search"
                description={<span className={styles.errorDetail}>{error}</span>}
            />
        );
    }

    if (!result) {
        return loading ? <PanelLoadingState /> : null;
    }

    if (result.files.length === 0) {
        return <PanelEmptyRow className={styles.empty}>No matches</PanelEmptyRow>;
    }

    const matches = result.files.reduce((sum, file) => sum + matchesIn(file), 0);

    return (
        <>
            <Text variant="xs" color="secondary" className={styles.summary}>
                {`${countOf(matches, 'result')} in ${countOf(result.files.length, 'file')}`}
            </Text>
            <GridList aria-label="Search results" size="sm" className={styles.list}>
                <For each={result.files}>{file => <FileMatches key={file.path} manager={manager} file={file} />}</For>
            </GridList>
            <Show when={result.truncated}>
                <PanelEmptyRow>Not every match is listed. Narrow the search to see the rest.</PanelEmptyRow>
            </Show>
        </>
    );
});

/** The query options in a menu that stays open, so several can be switched at once. Pressed while any is on. */
const SearchOptions = observer(function SearchOptions({
    search,
    slot,
    onChange,
}: {
    search: TextSearch;
    slot: string;
    onChange: () => void;
}) {
    return (
        <PopoverTrigger>
            <Button
                slot={slot}
                data-input-affix={INPUT_CONTROL_AFFIX}
                variant="filling"
                color="secondary"
                size="xs"
                iconOnly
                isPressed={OPTIONS.some(({ option }) => search[option])}
                aria-label="Search options"
                tooltip="Search options"
            >
                <Sliders aria-hidden />
            </Button>
            <Popover placement="bottom end" spacing="xs">
                <PopoverScroll>
                    <Menu
                        aria-label="Search options"
                        size="sm"
                        onAction={key => {
                            const option = key as (typeof OPTIONS)[number]['option'];

                            search.set({ [option]: !search[option] });
                            onChange();
                        }}
                    >
                        <For each={OPTIONS}>
                            {({ option, label }) => (
                                <MenuItem key={option} id={option} endAffix={search[option] ? <Check /> : undefined}>
                                    {label}
                                </MenuItem>
                            )}
                        </For>
                    </Menu>
                </PopoverScroll>
            </Popover>
        </PopoverTrigger>
    );
});

/**
 * The Search tab: the query with its options, and the matches grouped by file. Its state lives in
 * `manager.search`, so it outlives the view.
 */
export const SearchView = observer(function SearchView({ manager }: { manager: FileManager }) {
    const { search, searchRequests } = manager;
    const queryInput = useRef<HTMLInputElement>(null);
    const typing = useRef<ReturnType<typeof setTimeout>>(undefined);

    // Focus the query when the tab opens and on each `showSearch`.
    useEffect(() => {
        queryInput.current?.focus();
        queryInput.current?.select();
    }, [searchRequests]);

    useEffect(() => () => clearTimeout(typing.current), []);

    const setQuery = (query: string) => {
        search.set({ query });
        clearTimeout(typing.current);
        typing.current = setTimeout(() => void search.run(), TYPING_DELAY);
    };

    const runNow = () => {
        clearTimeout(typing.current);
        void search.run();
    };

    // Results stay listed while a new search runs, so the field shows that one is running.
    const refreshing = search.loading && search.result !== null;

    return (
        <div className={styles.root}>
            <Box padding="lg" className={styles.query}>
                <SearchInput
                    size="sm"
                    aria-label="Search text"
                    placeholder="Search"
                    inputRef={queryInput}
                    value={search.query}
                    onChange={setQuery}
                    onKeyDown={event => {
                        if (event.key === 'Enter') {
                            runNow();
                        }
                    }}
                >
                    {/* Direct children, as SearchInput reads each `slot`. They replace its clear button, so it comes back here. */}
                    {refreshing ? <Spinner slot="suffix" size="xs" aria-label="Searching" /> : null}
                    {!refreshing && search.query ? (
                        <Button
                            slot="suffix"
                            data-input-affix={INPUT_CONTROL_AFFIX}
                            variant="filling"
                            size="xs"
                            iconOnly
                            tooltip="Clear"
                            onPress={() => setQuery('')}
                        >
                            <Close aria-hidden />
                        </Button>
                    ) : null}
                    <SearchOptions slot="suffix" search={search} onChange={runNow} />
                </SearchInput>
            </Box>
            <PanelContent contentClass={styles.results}>
                <SearchResults manager={manager} />
            </PanelContent>
        </div>
    );
});
