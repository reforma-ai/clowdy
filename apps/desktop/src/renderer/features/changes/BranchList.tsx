import { Button } from '@clowdy/components/Button';
import { copyWithFeedback } from '@clowdy/components/CopyButton';
import { Menu, MenuItem } from '@clowdy/components/List';
import { Popover, useContextMenu } from '@clowdy/components/Popover';
import { Separator } from '@clowdy/components/Separator';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { Copy, Plus, Trash } from '@clowdy/icons/14';
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useState } from 'react';

import { homeFolder } from '../../shared/homeFolder';
import { PickerList } from '../../shared/PickerPopover';
import styles from './BranchPicker.module.css';
import { branchOptions, UNAVAILABLE_BRANCH_GROUP } from './branchChoices';
import { SwitchReasons } from './SwitchReasons';

import type { BranchSwitch } from './BranchSwitch';

/** The list of the popover: the branches in their groups with a filter, and the row that opens the form of a new one. A press on a branch switches to it, and the popover shuts when that was made. */
export function BranchList({
    model,
    current,
    onSwitched,
    onCreate,
    onDelete,
}: {
    model: BranchSwitch;
    current: string | undefined;
    onSwitched: () => void;
    onCreate: () => void;
    onDelete: (branch: string, remote: boolean) => void;
}) {
    const { listing } = model;
    const options = useMemo(() => (listing ? branchOptions(listing, homeFolder.path) : []), [listing]);
    const [showUnavailable, setShowUnavailable] = useState(false);
    const [query, setQuery] = useState('');
    const hasUnavailable = options.some(option => option.group === UNAVAILABLE_BRANCH_GROUP);
    const visibleOptions = useMemo(
        () =>
            showUnavailable || query.trim()
                ? options
                : options.filter(option => option.group !== UNAVAILABLE_BRANCH_GROUP),
        [options, query, showUnavailable]
    );
    const contextMenu = useContextMenu();
    const [menuBranch, setMenuBranch] = useState<string>();
    const local = listing?.local.find(branch => branch.name === menuBranch);
    const remote = !local && listing?.remote.find(branch => branch.name === menuBranch);
    const { close } = contextMenu;
    useEffect(() => () => close(), [close, model]);

    const selectMenuBranch = (row: Element | null) => {
        const name = row?.getAttribute('data-key');
        if (!name || !options.some(option => option.id === name)) return false;

        setMenuBranch(name);
        return true;
    };

    const openMenu = (event: MouseEvent) => {
        if (selectMenuBranch((event.target as Element).closest('[role="option"][data-key]')))
            contextMenu.areaProps.onContextMenu(event);
    };

    const openMenuFromKey = (event: KeyboardEvent) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;

        const target = event.target as Element;
        const activeId = target.getAttribute('aria-activedescendant');
        const active = activeId ? document.getElementById(activeId) : target;
        const row = active?.closest('[role="option"][data-key]') ?? null;

        if (!row || !event.currentTarget.contains(row) || !selectMenuBranch(row)) return;

        event.preventDefault();
        event.stopPropagation();
        const rect = row.getBoundingClientRect();
        contextMenu.openAt(rect.left, rect.bottom);
    };

    const deleteDisabled = model.busy || menuBranch === listing?.defaultBranch || local?.heldBy !== undefined;

    const deleteBranch = () => {
        if (!menuBranch || (!local && !remote) || deleteDisabled) return;
        close();
        onDelete(menuBranch, Boolean(remote));
    };

    const copyBranchName = () => {
        const branch = options.find(option => option.id === menuBranch);
        if (!branch) return;
        close();
        copyWithFeedback(branch.label, () => toast.success({ message: 'Branch name copied' }));
    };

    const pick = async (name: string) => {
        const outcome = await model.switchTo(name);

        if (outcome.ok && outcome.result.warning === undefined) onSwitched();
        // A hook's complaint is read before the popover goes: the list is read again so it is true.
        else if (outcome.ok) void model.load();
    };

    return (
        <div className={styles.body} onContextMenu={openMenu} onKeyDown={openMenuFromKey}>
            {listing ? (
                <PickerList
                    options={visibleOptions}
                    selectedIds={current === undefined ? [] : [current]}
                    aria-label="Branches"
                    placeholder="Filter branches"
                    onQueryChange={setQuery}
                    onPick={name => void pick(name)}
                />
            ) : (
                <div className={styles.status} role="status">
                    {model.loading ? <Spinner size="xs" /> : null}
                    <Text variant="xs" color="secondary">
                        {model.loading ? 'Loading branches' : 'No branches to show'}
                    </Text>
                </div>
            )}
            {hasUnavailable && !showUnavailable && !query.trim() && (
                <Button
                    variant="ghost"
                    color="secondary"
                    size="sm"
                    className={styles.reveal}
                    onPress={() => setShowUnavailable(true)}
                >
                    Show unavailable branches
                </Button>
            )}
            <SwitchReasons model={model} />
            <Separator spacing={0} />
            <div className={styles.footer}>
                <Button
                    variant="filling"
                    color="secondary"
                    size="sm"
                    fullWidth
                    className={styles.action}
                    contentClassName={styles.actionContent}
                    isDisabled={!listing}
                    onPress={onCreate}
                >
                    <Plus aria-hidden="true" />
                    New branch…
                </Button>
            </div>
            {contextMenu.isOpen && (local || remote) && (
                <Popover
                    {...contextMenu.popoverProps}
                    placement="bottom start"
                    spacing="xs"
                    data-branch-context-menu=""
                >
                    <Menu
                        aria-label="Branch actions"
                        size="sm"
                        onAction={key => {
                            if (key === 'copy') copyBranchName();
                            else if (key === 'delete') deleteBranch();
                        }}
                    >
                        <MenuItem id="copy" icon={<Copy aria-hidden="true" />} text="Copy branch name" />
                        <MenuItem
                            id="delete"
                            icon={<Trash aria-hidden="true" />}
                            text="Delete branch…"
                            isDanger
                            isDisabled={deleteDisabled}
                        />
                    </Menu>
                </Popover>
            )}
        </div>
    );
}
