import { Menu, MenuHeader, MenuItem, MenuSection } from '@clowdy/components/List';
import { PopoverScroll } from '@clowdy/components/Popover';
import { Copy } from '@clowdy/icons/14';

import { useKindOnDisk } from '../files/useKindOnDisk';
import { type Place, placePath } from '../sidePanel/currentPlace';
import { ExtraMenuSection, type OpenMenuExtra, OpenWithMenu } from './OpenWithMenu';
import { openEffects } from './openApps';
import { absolutePath, type OpenTarget } from './openTarget';
import { useFolderGit } from './useFolderGit';

import type { ProjectId } from '@clowdy/protocol';

/** What a path inside a place is to the menus: where it is on the disk and where it is inside the place, a file unless the caller knows better. */
export function placeTarget(
    projectId: ProjectId,
    place: Place,
    relative: string,
    kind: OpenTarget['kind'] = 'file'
): OpenTarget {
    return {
        projectId,
        folder: place.folder,
        ...(place.workspace && { workspace: place.workspace }),
        path: absolutePath(placePath(place), relative),
        relative,
        kind,
    };
}

export interface PathMenuProps {
    target: OpenTarget;
    /** The caller's own items, which stay when the path is not on the disk (`Discard changes…` on a deleted file). */
    extra?: readonly OpenMenuExtra[];
    /** The caller expects the path to be gone (a deleted file): it gets the menu of a path that is not there at once, and the full one only if the disk proves it wrong. */
    expectGone?: boolean;
    /** Called when an item is pressed: a menu that is not in a `MenuTrigger` shuts itself here. */
    onClose?: () => void;
}

/** The menu of a path that is not on the disk (an agent named a file it has not made, a file that was deleted or moved): it says so, and keeps the copies of the path and the caller's own items, the things that still work. */
function AbsentMenu({ target, extra = [], onClose }: Omit<PathMenuProps, 'expectGone'>) {
    return (
        <PopoverScroll>
            <Menu
                aria-label="File actions"
                size="sm"
                onAction={key => {
                    onClose?.();

                    const own = extra.find(item => item.id === key);

                    if (own) own.run();
                    else openEffects.copy(key === 'copyRelative' ? target.relative : target.path);
                }}
            >
                <MenuSection aria-label="Path">
                    <MenuHeader>{`This ${target.kind === 'directory' ? 'folder' : 'file'} doesn't exist`}</MenuHeader>
                    <MenuItem id="copyPath" icon={<Copy aria-hidden="true" />} textValue="Copy path">
                        Copy path
                    </MenuItem>
                    {target.relative !== '' && (
                        <MenuItem id="copyRelative" icon={<Copy aria-hidden="true" />} textValue="Copy relative path">
                            Copy relative path
                        </MenuItem>
                    )}
                </MenuSection>
                <ExtraMenuSection extra={extra} />
            </Menu>
        </PopoverScroll>
    );
}

/**
 * The menu of a path that is in a folder of the project, to go inside a `Popover`: the same as everywhere (`OpenWithMenu`), with the git facts of its folder read when it opens. A
 * path written with no trailing slash is taken for a file until the disk says it is a folder (the terminal, `Open in Finder` and the `/tree/` page of GitHub follow). When the disk says the path is not there,
 * nothing in that menu could work on it, so it gives way to a menu of the copies of the path.
 */
export function PathMenu({ target, extra, expectGone = false, onClose }: PathMenuProps) {
    const git = useFolderGit(target.projectId, target.folder.id, target.workspace);
    const kind = useKindOnDisk(target.projectId, target, target.relative);

    if (kind === null || (kind === undefined && expectGone))
        return <AbsentMenu target={target} extra={extra} onClose={onClose} />;

    return (
        <OpenWithMenu
            target={kind ? { ...target, kind } : target}
            git={git}
            extra={extra}
            onClose={onClose}
            aria-label="File actions"
        />
    );
}
