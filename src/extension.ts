import * as vscode from "vscode";
import { Uri, FileType, QuickInputButton, ThemeIcon, ViewColumn } from "vscode";
import * as FS from "fs";
import * as OS from "os";
import * as OSPath from "path";

import { Result, None, Option, Some } from "@bodil/opt";
import { Path, endsWithPathSeparator } from "./path";
import { Rules } from "./filter";
import { FileItem, fileRecordCompare, openToSideButton, updateDescription } from "./fileitem";
import { action, Action } from "./action";
import {
    EntryDetails,
    canUseNodeFs,
    folderSize,
    isWindows,
    modeString,
    octalString,
    parseChmod,
    readAllDetails,
    sizeString,
} from "./stat";

export enum ConfigItem {
    RemoveIgnoredFiles = "removeIgnoredFiles",
    HideDotfiles = "hideDotfiles",
    HideIgnoreFiles = "hideIgnoredFiles",
    IgnoreFileTypes = "ignoreFileTypes",
    LabelIgnoredFiles = "labelIgnoredFiles",
    ShowPermissions = "showPermissions",
    ShowSize = "showSize",
    ShowLinkTarget = "showLinkTarget",
    FolderSizeTimeLimit = "folderSizeTimeLimit",
}

export function config<A>(item: ConfigItem): A | undefined {
    return vscode.workspace.getConfiguration("file-browser-plus").get(item);
}

let active: Option<FileBrowser> = None;

function setContext(state: boolean) {
    vscode.commands.executeCommand("setContext", "inFileBrowserPlus", state);
}

interface AutoCompletion {
    index: number;
    items: FileItem[];
}

class FileBrowser {
    current: vscode.QuickPick<FileItem>;
    path: Path;
    file: Option<string>;
    items: FileItem[] = [];
    pathHistory: { [path: string]: Option<string> };
    inActions: boolean = false;
    keepAlive: boolean = false;
    updating: boolean = false;
    disposed: boolean = false;
    autoCompletion?: AutoCompletion;
    /** Computed folder sizes for this session, keyed by the folder's file system path. */
    folderSizes = new Map<string, string>();
    /** Increased for every folder size calculation, so an older one can tell it is stale. */
    sizeJob: number = 0;

    actionsButton: QuickInputButton = {
        iconPath: new ThemeIcon("ellipsis"),
        tooltip: "Actions on selected file",
    };
    newFolderButton: QuickInputButton = {
        iconPath: new ThemeIcon("new-folder"),
        tooltip: "New folder in this folder",
    };
    stepOutButton: QuickInputButton = {
        iconPath: new ThemeIcon("arrow-left"),
        tooltip: "Step out of folder",
    };
    stepInButton: QuickInputButton = {
        iconPath: new ThemeIcon("arrow-right"),
        tooltip: "Step into folder",
    };

    constructor(path: Path, file: Option<string>) {
        this.path = path;
        this.file = file;
        this.pathHistory = { [this.path.id]: this.file };
        this.current = vscode.window.createQuickPick();
        this.current.buttons = [
            this.actionsButton,
            this.newFolderButton,
            this.stepOutButton,
            this.stepInButton,
        ];
        this.current.placeholder = "Preparing the file list...";
        this.current.onDidHide(() => {
            if (!this.keepAlive) {
                this.dispose();
            }
        });
        this.current.onDidAccept(this.onDidAccept.bind(this));
        this.current.onDidChangeValue(this.onDidChangeValue.bind(this));
        this.current.onDidTriggerButton(this.onDidTriggerButton.bind(this));
        this.current.onDidTriggerItemButton(this.onDidTriggerItemButton.bind(this));
        this.update().then(() => {
            this.current.placeholder = "Type a file name here to search or open a new file";
            this.current.busy = false;
        });
    }

    dispose() {
        this.disposed = true;
        setContext(false);
        this.current.dispose();
        active = None;
    }

    hide() {
        this.current.hide();
        setContext(false);
    }

    show() {
        setContext(true);
        this.current.show();
    }

    /** The folder whose contents are listed (the parent of the selected item while in actions). */
    folderPath(): Path {
        if (!this.inActions) {
            return this.path;
        }
        const parent = this.path.clone();
        parent.pop();
        return parent;
    }

    async update() {
        // FIXME: temporary and UGLY fix of https://github.com/bodil/vscode-file-browser/issues/35.
        // Brought in from here https://github.com/atariq11700/vscode-file-browser/commit/a2525d01f262f17dac2c478e56640c9ce1f65713.
        // this.current.enabled = false;
        // `updating` keeps the value reset below from being handled as typing
        // (https://github.com/bodil/vscode-file-browser/pull/57).
        this.updating = true;
        this.current.show();
        this.current.busy = true;
        this.current.title = this.path.fsPath;
        this.current.value = "";

        const nodeFs = canUseNodeFs(this.path.uri);
        const canChmod = nodeFs && !isWindows;
        const stat = (await Result.await(vscode.workspace.fs.stat(this.path.uri))).unwrap();
        if (stat && this.inActions && (stat.type & FileType.File) === FileType.File) {
            this.items = [
                action("$(file) Open this file", Action.OpenFile),
                action("$(split-horizontal) Open this file to the side", Action.OpenFileBeside),
                action("$(edit) Rename this file", Action.RenameFile),
                action("$(trash) Delete this file", Action.DeleteFile),
            ];
            if (canChmod) {
                this.items.push(
                    action(
                        `$(key) Change permissions${await this.modeHint()}`,
                        Action.ChangePermissions,
                    ),
                );
            }
            this.items.push(
                action("$(new-file) New file in this folder", Action.NewFile),
                action("$(new-folder) New folder in this folder", Action.NewFolderHere),
            );
            this.current.items = this.items;
        } else if (
            stat &&
            this.inActions &&
            (stat.type & FileType.Directory) === FileType.Directory
        ) {
            this.items = [
                action("$(folder-opened) Open this folder", Action.OpenFolder),
                action(
                    "$(folder-opened) Open this folder in a new window",
                    Action.OpenFolderInNewWindow,
                ),
                action("$(edit) Rename this folder", Action.RenameFile),
                action("$(trash) Delete this folder", Action.DeleteFile),
            ];
            if (nodeFs) {
                this.items.push(action("$(dashboard) Calculate folder size", Action.FolderSize));
            }
            if (canChmod) {
                this.items.push(
                    action(
                        `$(key) Change permissions${await this.modeHint()}`,
                        Action.ChangePermissions,
                    ),
                );
            }
            this.items.push(
                action("$(new-file) New file in the parent folder", Action.NewFile),
                action("$(new-folder) New folder in the parent folder", Action.NewFolderHere),
            );
            this.current.items = this.items;
        } else if (stat && (stat.type & FileType.Directory) === FileType.Directory) {
            const records = await vscode.workspace.fs.readDirectory(this.path.uri);
            records.sort(fileRecordCompare);
            const details: Map<string, EntryDetails> = nodeFs
                ? await readAllDetails(
                      this.path.fsPath,
                      records.map(([name]) => name),
                  )
                : new Map();
            let items = records.map((entry) => {
                const item = new FileItem(entry, details.get(entry[0]));
                const size = this.folderSizes.get(OSPath.join(this.path.fsPath, entry[0]));
                if (size !== undefined) {
                    item.extraDescription = size;
                    updateDescription(item);
                }
                return item;
            });
            if (config(ConfigItem.HideIgnoreFiles)) {
                const rules = await Rules.forPath(this.path);
                items = rules.filter(this.path, items);
            }
            if (config(ConfigItem.RemoveIgnoredFiles)) {
                items = items.filter((item) => item.alwaysShow);
            }
            this.items = items;
            this.current.items = items;
            this.current.activeItems = items.filter((item) => this.file.value === item.name);
        } else {
            this.items = [action("$(new-folder) Create this folder", Action.NewFolder)];
            this.current.items = this.items;
        }
        this.current.enabled = true;
        this.current.busy = false;
        this.updating = false;
    }

    /** ` (now rwxr-xr-x 755)` for the selected item, or an empty string. */
    async modeHint(): Promise<string> {
        const st = await FS.promises.lstat(this.path.fsPath).catch(() => undefined);
        return st ? ` (now ${modeString(st.mode)} ${octalString(st.mode)})` : "";
    }

    onDidChangeValue(value: string, isAutoComplete = false) {
        if (this.inActions || this.updating) {
            return;
        }

        if (!isAutoComplete) {
            this.autoCompletion = undefined;
        }

        const existingItem = this.items.find((item) => item.name === value);
        if (value === "") {
            this.current.items = this.items;
            this.current.activeItems = [];
        } else if (existingItem !== undefined) {
            this.current.items = this.items;
            this.current.activeItems = [existingItem];
        } else {
            endsWithPathSeparator(value).match(
                (path) => {
                    if (path === "~") {
                        this.stepIntoFolder(Path.fromFilePath(OS.homedir()));
                    } else if (path === "..") {
                        this.stepOut();
                    } else {
                        this.stepIntoFolder(this.path.append(path));
                    }
                },
                () => {
                    // Put "open as new file" last and don't select it, so that Enter opens the
                    // best matching existing file (https://github.com/bodil/vscode-file-browser/issues/19).
                    // When nothing matches, it is the only item left and gets selected.
                    const newItem = {
                        label: `$(new-file) ${value}`,
                        name: value,
                        description: "Open as new file",
                        alwaysShow: true,
                        action: Action.NewFile,
                    };
                    this.current.items = [...this.items, newItem];
                },
            );
        }
    }

    onDidTriggerButton(button: QuickInputButton) {
        if (button === this.stepInButton) {
            this.stepIn();
        } else if (button === this.stepOutButton) {
            this.stepOut();
        } else if (button === this.actionsButton) {
            this.actions();
        } else if (button === this.newFolderButton) {
            this.newFolder();
        }
    }

    onDidTriggerItemButton(event: vscode.QuickPickItemButtonEvent<FileItem>) {
        if (event.button === openToSideButton) {
            this.openFile(this.path.append(event.item.name).uri, ViewColumn.Beside);
        }
    }

    activeItem(): Option<FileItem> {
        return Option.from(this.current.activeItems[0]);
    }

    async stepIntoFolder(folder: Path) {
        if (!this.path.equals(folder)) {
            this.path = folder;
            this.file = this.pathHistory[this.path.id] || None;
            await this.update();
        }
    }

    async stepIn() {
        this.activeItem().ifSome(async (item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (item.fileType !== undefined) {
                if ((item.fileType & FileType.Directory) === FileType.Directory) {
                    await this.stepIntoFolder(this.path.append(item.name));
                } else if ((item.fileType & FileType.File) === FileType.File) {
                    this.path.push(item.name);
                    this.file = None;
                    this.inActions = true;
                    await this.update();
                }
            }
        });
    }

    async stepOut() {
        this.inActions = false;
        if (!this.path.atTop()) {
            this.pathHistory[this.path.id] = this.activeItem().map((item) => item.name);
            this.file = this.path.pop();
            await this.update();
        }
    }

    async actions() {
        if (this.inActions) {
            return;
        }
        await this.activeItem().match(
            async (item) => {
                this.inActions = true;
                this.path.push(item.name);
                this.file = None;
                await this.update();
            },
            async () => {
                this.inActions = true;
                this.file = None;
                await this.update();
            },
        );
    }

    openActiveToSide() {
        if (this.inActions) {
            return;
        }
        this.activeItem().ifSome((item) => {
            if (item.fileType !== undefined && (item.fileType & FileType.File) === FileType.File) {
                this.openFile(this.path.append(item.name).uri, ViewColumn.Beside);
            }
        });
    }

    tabCompletion(tabNext: boolean) {
        if (this.inActions) {
            return;
        }

        if (this.autoCompletion) {
            const length = this.autoCompletion.items.length;
            const step = tabNext ? 1 : -1;
            this.autoCompletion.index = (this.autoCompletion.index + length + step) % length;
        } else {
            const items = this.items.filter((i) =>
                i.name.toLowerCase().startsWith(this.current.value.toLowerCase()),
            );
            this.autoCompletion = {
                index: tabNext ? 0 : items.length - 1,
                items,
            };
        }

        const newIndex = this.autoCompletion.index;
        const length = this.autoCompletion.items.length;
        if (newIndex < length) {
            // This also checks out when items is empty
            const item = this.autoCompletion.items[newIndex];
            this.current.value = item.name;
            if (length === 1 && item.fileType === FileType.Directory) {
                this.current.value += "/";
            }

            this.onDidChangeValue(this.current.value, true);
        }
    }

    onDidAccept() {
        this.autoCompletion = undefined;
        this.activeItem().ifSome((item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (
                item.fileType !== undefined &&
                (item.fileType & FileType.Directory) === FileType.Directory
            ) {
                this.stepIn();
            } else {
                this.openFile(this.path.append(item.name).uri);
            }
        });
    }

    openFile(uri: Uri, column: ViewColumn = ViewColumn.Active) {
        this.dispose();
        vscode.workspace
            .openTextDocument(uri)
            .then((doc) => vscode.window.showTextDocument(doc, column));
    }

    async rename() {
        const uri = this.path.uri;
        const stat = await vscode.workspace.fs.stat(uri);
        const isDir = (stat.type & FileType.Directory) === FileType.Directory;
        const fileName = this.path.pop().getOrElse(() => {
            throw new Error("Can't rename an empty file name!");
        });
        const fileType = isDir ? "folder" : "file";
        const workspaceFolder = this.path.getWorkspaceFolder().map((wsf) => wsf.uri);
        const relPath = workspaceFolder
            .chain((workspaceFolder) => new Path(uri).relativeTo(workspaceFolder))
            .getOr(fileName);
        const extension = OSPath.extname(relPath);
        const startSelection = relPath.length - fileName.length;
        const endSelection = startSelection + (fileName.length - extension.length);
        const result = await vscode.window.showInputBox({
            prompt: `Enter the new ${fileType} name`,
            value: relPath,
            valueSelection: [startSelection, endSelection],
        });
        this.file = Some(fileName);
        if (result !== undefined) {
            const newUri = workspaceFolder.match(
                (workspaceFolder) => Uri.joinPath(workspaceFolder, result),
                () => Uri.joinPath(this.path.uri, result),
            );
            if ((await Result.await(vscode.workspace.fs.rename(uri, newUri))).isOk()) {
                this.file = Some(OSPath.basename(result));
            } else {
                vscode.window.showErrorMessage(`Failed to rename ${fileType} "${fileName}"`);
            }
        }
    }

    /** Ask for a name and create a folder in the listed folder (like `+` in dired). */
    async newFolder() {
        const dir = this.folderPath();
        this.keepAlive = true;
        this.hide();
        const name = await vscode.window.showInputBox({
            prompt: `New folder in ${dir.fsPath}`,
            placeHolder: "Folder name (use / to create nested folders)",
            validateInput: (value) => (value.trim() === "" ? "Enter a folder name" : undefined),
        });
        this.path = dir;
        this.inActions = false;
        if (name !== undefined) {
            const created = await Result.await(
                vscode.workspace.fs.createDirectory(Uri.joinPath(dir.uri, name.trim())),
            );
            if (created.isOk()) {
                this.file = Some(name.trim().split(/[\\/]/)[0]);
            } else {
                vscode.window.showErrorMessage(`Failed to create folder "${name}"`);
            }
        }
        this.show();
        this.keepAlive = false;
        await this.update();
    }

    /** Ask for a name and open it as a new, unsaved file in the listed folder. */
    async newFile() {
        const dir = this.folderPath();
        this.keepAlive = true;
        this.hide();
        const name = await vscode.window.showInputBox({
            prompt: `New file in ${dir.fsPath}`,
            placeHolder: "File name",
            validateInput: (value) => (value.trim() === "" ? "Enter a file name" : undefined),
        });
        this.keepAlive = false;
        if (name !== undefined) {
            this.openFile(Uri.joinPath(dir.uri, name.trim()).with({ scheme: "untitled" }));
        } else {
            this.path = dir;
            this.inActions = false;
            this.show();
            await this.update();
        }
    }

    /** Change the permissions of the selected item (like `M` in dired). */
    async changePermissions() {
        const target = this.path.fsPath;
        this.keepAlive = true;
        this.hide();
        const st = await FS.promises.stat(target).catch(() => undefined);
        if (st) {
            const result = await vscode.window.showInputBox({
                prompt: `Permissions of ${OSPath.basename(target)}: now ${modeString(
                    st.mode,
                )} (${octalString(st.mode)}). Enter octal (644) or symbolic (u+x,go-w).`,
                value: octalString(st.mode),
                validateInput: (value) => {
                    const parsed = parseChmod(value, st.mode, st.isDirectory());
                    return typeof parsed === "string" ? parsed : undefined;
                },
            });
            if (result !== undefined) {
                const mode = parseChmod(result, st.mode, st.isDirectory());
                if (typeof mode === "number") {
                    const changed = await FS.promises.chmod(target, mode).then(
                        () => true,
                        () => false,
                    );
                    if (!changed) {
                        vscode.window.showErrorMessage(
                            `Failed to change permissions of "${OSPath.basename(target)}"`,
                        );
                    }
                }
            }
        } else {
            vscode.window.showErrorMessage(`Can't read "${target}"`);
        }
        this.file = this.path.pop();
        this.inActions = false;
        this.show();
        this.keepAlive = false;
        await this.update();
    }

    /**
     * Add up the size of the selected folder in the background and show it next to the
     * folder. Stops when the browser is closed, another folder is listed, or the time limit
     * (`file-browser-plus.folderSizeTimeLimit`) passes.
     */
    async calculateFolderSize() {
        const folder = this.path.fsPath;
        const name = this.path.pop().getOrElse(() => {
            throw new Error("Can't calculate the size of an empty folder name!");
        });
        const parent = this.path.clone();
        const job = ++this.sizeJob;
        this.inActions = false;
        this.file = Some(name);
        this.folderSizes.set(folder, "$(sync~spin) calculating size…");
        await this.update();

        const limitSeconds = config<number>(ConfigItem.FolderSizeTimeLimit) ?? 10;
        const result = await folderSize(
            folder,
            limitSeconds * 1000,
            () => this.disposed || this.sizeJob !== job || !this.path.equals(parent),
        );
        if (this.disposed) {
            return;
        }
        if (this.sizeJob !== job || !this.path.equals(parent)) {
            this.folderSizes.delete(folder);
            return;
        }
        const files = result.files.toLocaleString("en-US");
        this.folderSizes.set(
            folder,
            result.partial
                ? `Σ ≥ ${sizeString(result.bytes)} (${files}+ files, stopped after ${limitSeconds}s)`
                : `Σ ${sizeString(result.bytes)} (${files} files)`,
        );
        this.refreshFolderSize(name, folder);
    }

    /** Show the stored folder size on the item without listing the folder again. */
    refreshFolderSize(name: string, folder: string) {
        const item = this.items.find((i) => i.name === name);
        if (!item || this.inActions) {
            return;
        }
        item.extraDescription = this.folderSizes.get(folder);
        updateDescription(item);
        const activeName = this.activeItem().map((i) => i.name);
        const value = this.current.value;
        this.current.items = this.items;
        if (value === "") {
            this.current.activeItems = this.items.filter((i) => activeName.value === i.name);
        }
    }

    async runAction(item: FileItem) {
        switch (item.action) {
            case Action.NewFolder: {
                await vscode.workspace.fs.createDirectory(this.path.uri);
                await this.update();
                break;
            }
            case Action.NewFile: {
                if (item.name && item.name.length > 0) {
                    const uri = this.path.append(item.name).uri;
                    this.openFile(uri.with({ scheme: "untitled" }));
                } else {
                    await this.newFile();
                }
                break;
            }
            case Action.NewFolderHere: {
                await this.newFolder();
                break;
            }
            case Action.ChangePermissions: {
                await this.changePermissions();
                break;
            }
            case Action.FolderSize: {
                await this.calculateFolderSize();
                break;
            }
            case Action.OpenFile: {
                const path = this.path.clone();
                if (item.name && item.name.length > 0) {
                    path.push(item.name);
                }
                this.openFile(path.uri);
                break;
            }
            case Action.OpenFileBeside: {
                const path = this.path.clone();
                if (item.name && item.name.length > 0) {
                    path.push(item.name);
                }
                this.openFile(path.uri, ViewColumn.Beside);
                break;
            }
            case Action.RenameFile: {
                this.keepAlive = true;
                this.hide();
                await this.rename();
                this.show();
                this.keepAlive = false;
                this.inActions = false;
                this.update();
                break;
            }
            case Action.DeleteFile: {
                this.keepAlive = true;
                this.hide();
                const uri = this.path.uri;
                const stat = await vscode.workspace.fs.stat(uri);
                const isDir = (stat.type & FileType.Directory) === FileType.Directory;
                const fileName = this.path.pop().getOrElse(() => {
                    throw new Error("Can't delete an empty file name!");
                });
                const fileType = isDir ? "folder" : "file";
                const goAhead = `$(trash) Delete the ${fileType} "${fileName}"`;
                const result = await vscode.window.showQuickPick(["$(close) Cancel", goAhead], {});
                if (result === goAhead) {
                    const delOp = await Result.await(
                        vscode.workspace.fs.delete(uri, { recursive: isDir }),
                    );
                    if (delOp.isErr()) {
                        vscode.window.showErrorMessage(
                            `Failed to delete ${fileType} "${fileName}"`,
                        );
                    }
                }
                this.show();
                this.keepAlive = false;
                this.inActions = false;
                this.update();
                break;
            }
            case Action.OpenFolder: {
                vscode.commands.executeCommand("vscode.openFolder", this.path.uri);
                break;
            }
            case Action.OpenFolderInNewWindow: {
                vscode.commands.executeCommand("vscode.openFolder", this.path.uri, true);
                break;
            }
            default:
                throw new Error(`Unhandled action ${item.action}`);
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    setContext(false);

    const register = (name: string, callback: () => unknown) =>
        context.subscriptions.push(
            vscode.commands.registerCommand(`file-browser-plus.${name}`, callback),
        );

    register("open", () => {
        const document = vscode.window.activeTextEditor?.document;
        const workspaceFolder =
            vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        let path = new Path(workspaceFolder?.uri || Uri.file(OS.homedir()));
        let file: Option<string> = None;
        if (document && !document.isUntitled) {
            path = new Path(document.uri);
            file = path.pop();
        }
        active = Some(new FileBrowser(path, file));
        setContext(true);
    });
    register("rename", () =>
        active
            .chainNone(() => {
                const document = vscode.window.activeTextEditor?.document;
                const workspaceFolder =
                    vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
                const path = new Path(
                    document?.uri || workspaceFolder?.uri || Uri.file(OS.homedir()),
                );
                active = Some(new FileBrowser(path, None));
                setContext(true);
                return active;
            })
            .ifSome((active) => active.rename()),
    );
    register("stepIn", () => active.ifSome((active) => active.stepIn()));
    register("stepOut", () => active.ifSome((active) => active.stepOut()));
    register("actions", () => active.ifSome((active) => active.actions()));
    register("tabNext", () => active.ifSome((active) => active.tabCompletion(true)));
    register("tabPrev", () => active.ifSome((active) => active.tabCompletion(false)));
    register("openToSide", () => active.ifSome((active) => active.openActiveToSide()));
    register("newFolder", () => active.ifSome((active) => active.newFolder()));
}

export function deactivate() {}
