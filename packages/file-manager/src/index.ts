export { FileManager } from './FileManager';
export { basename, decodeUtf8, dirname, extname, isPathWithin, normalizePath } from './paths';
export { FileSystemError } from './provider';

export type { Tabs, TabsSnapshot } from './documents/Tabs';
export type {
    DocumentEditor,
    DocumentStatus,
    DocumentView,
    TextDocument,
    TextPosition,
    TextSelection,
} from './documents/TextDocument';
export type { ActiveEditor, FileManagerOptions } from './FileManager';
export type { FileOperations, MoveOptions } from './FileOperations';
export type {
    FileChange,
    FileContent,
    FileEntry,
    FileKind,
    FileSystemCapabilities,
    FileSystemErrorCode,
    FileSystemErrorOptions,
    FileSystemProvider,
    MoveOperation,
    Notify,
    OverwriteOptions,
    SaveParticipant,
    SearchMatch,
    SearchQuery,
    SearchResult,
    SearchService,
    WatchEvent,
    WriteOptions,
} from './provider';
export type { TextSearch } from './search/TextSearch';
export type { FileTree, FileTreeStatus } from './tree/FileTree';
