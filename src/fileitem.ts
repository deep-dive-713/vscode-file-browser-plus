import { QuickPickItem, QuickInputButton, FileType, ThemeIcon } from "vscode";
import { Action } from "./action";
import { config, ConfigItem } from "./extension";
import { EntryDetails, isWindows, modeString, sizeString } from "./stat";

export const openToSideButton: QuickInputButton = {
    iconPath: new ThemeIcon("split-horizontal"),
    tooltip: "Open to the side",
};

export class FileItem implements QuickPickItem {
    name: string;
    label: string;
    alwaysShow: boolean;
    detail?: string;
    description?: string;
    fileType?: FileType;
    action?: Action;
    buttons?: QuickInputButton[];
    details?: EntryDetails;
    /** Shown after the other details, e.g. a computed folder size. */
    extraDescription?: string;

    constructor(record: [string, FileType], details?: EntryDetails) {
        const [name, fileType] = record;
        this.name = name;
        this.fileType = fileType;
        this.details = details;
        this.alwaysShow = config(ConfigItem.HideDotfiles) ? !name.startsWith(".") : true;
        switch (this.fileType) {
            case FileType.Directory:
                this.label = `$(folder) ${name}`;
                break;
            case FileType.Directory | FileType.SymbolicLink:
                this.label = `$(file-symlink-directory) ${name}`;
                break;
            case FileType.File | FileType.SymbolicLink:
                this.label = `$(file-symlink-file) ${name}`;
                this.buttons = [openToSideButton];
                break;
            default:
                this.label = `$(file) ${name}`;
                this.buttons = [openToSideButton];
                break;
        }
        updateDescription(this);
    }
}

/** Build the `description` (permissions, size, link target, extra text) of a file item. */
export function updateDescription(item: FileItem) {
    const parts: string[] = [];
    const d = item.details;
    if (d) {
        if (!isWindows && config(ConfigItem.ShowPermissions) && d.mode !== undefined) {
            parts.push(modeString(d.mode));
        }
        if (config(ConfigItem.ShowSize) && !d.isDirectory && d.size !== undefined) {
            parts.push(sizeString(d.size));
        }
        if (config(ConfigItem.ShowLinkTarget) && d.linkTarget !== undefined) {
            parts.push(`→ ${d.linkTarget}`);
        }
    }
    if (item.extraDescription) {
        parts.push(item.extraDescription);
    }
    item.description = parts.length > 0 ? parts.join("  ") : undefined;
}

export function itemIsDir(item: FileItem): boolean {
    if (item.fileType === undefined) {
        return false;
    }
    return (item.fileType & FileType.Directory) === FileType.Directory;
}

export function fileRecordCompare(left: [string, FileType], right: [string, FileType]): -1 | 0 | 1 {
    const [leftName, leftDir] = [
        left[0].toLowerCase(),
        (left[1] & FileType.Directory) === FileType.Directory,
    ];
    const [rightName, rightDir] = [
        right[0].toLowerCase(),
        (right[1] & FileType.Directory) === FileType.Directory,
    ];
    if (leftDir && !rightDir) {
        return -1;
    }
    if (rightDir && !leftDir) {
        return 1;
    }
    const order = leftName.localeCompare(rightName, undefined, { numeric: true });
    return order < 0 ? -1 : order > 0 ? 1 : 0;
}
