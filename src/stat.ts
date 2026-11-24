import * as FS from "fs";
import * as OSPath from "path";
import { Uri } from "vscode";

/** Extra information shown next to each entry. Only available for `file:` URIs. */
export interface EntryDetails {
    mode?: number;
    size?: number;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    linkTarget?: string;
}

export const isWindows = process.platform === "win32";

export function canUseNodeFs(uri: Uri): boolean {
    return uri.scheme === "file";
}

/** Read `lstat` (and the link target for symbolic links) of one entry. */
export async function readDetails(path: string): Promise<EntryDetails | undefined> {
    try {
        const st = await FS.promises.lstat(path);
        const details: EntryDetails = {
            mode: st.mode,
            size: st.size,
            isDirectory: st.isDirectory(),
            isSymbolicLink: st.isSymbolicLink(),
        };
        if (details.isSymbolicLink) {
            details.linkTarget = await FS.promises.readlink(path).catch(() => undefined);
            // Show the size of the file the link points to, like `ls -lL`.
            const target = await FS.promises.stat(path).catch(() => undefined);
            details.size = target && !target.isDirectory() ? target.size : undefined;
            details.isDirectory = target ? target.isDirectory() : false;
        }
        return details;
    } catch {
        return undefined;
    }
}

/** Read the details of many entries in parallel, a few at a time. */
export async function readAllDetails(
    dir: string,
    names: string[],
    concurrency = 64,
): Promise<Map<string, EntryDetails>> {
    const result = new Map<string, EntryDetails>();
    let next = 0;
    const worker = async () => {
        while (next < names.length) {
            const name = names[next++];
            const details = await readDetails(OSPath.join(dir, name));
            if (details) {
                result.set(name, details);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
    return result;
}

/** `drwxr-xr-x` style string, as printed by `ls -l`. */
export function modeString(mode: number): string {
    const S_IFMT = 0o170000;
    const types: { [key: number]: string } = {
        0o040000: "d",
        0o120000: "l",
        0o100000: "-",
        0o020000: "c",
        0o060000: "b",
        0o010000: "p",
        0o140000: "s",
    };
    const type = types[mode & S_IFMT] ?? "?";
    const bit = (mask: number, ch: string) => (mode & mask ? ch : "-");
    const special = (exec: boolean, set: boolean, on: string) =>
        set ? (exec ? on : on.toUpperCase()) : exec ? "x" : "-";
    return (
        type +
        bit(0o400, "r") +
        bit(0o200, "w") +
        special(!!(mode & 0o100), !!(mode & 0o4000), "s") +
        bit(0o040, "r") +
        bit(0o020, "w") +
        special(!!(mode & 0o010), !!(mode & 0o2000), "s") +
        bit(0o004, "r") +
        bit(0o002, "w") +
        special(!!(mode & 0o001), !!(mode & 0o1000), "t")
    );
}

/** Permission bits only, as an octal string such as `755` or `4755`. */
export function octalString(mode: number): string {
    const bits = mode & 0o7777;
    const text = bits.toString(8);
    return bits > 0o777 ? text.padStart(4, "0") : text.padStart(3, "0");
}

/** Human readable size, like `ls -lh` (1024 based). */
export function sizeString(size: number): string {
    const units = ["B", "K", "M", "G", "T", "P"];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    if (unit === 0) {
        return `${size}B`;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

/**
 * Parse a `chmod` mode: either octal (`644`, `0755`, `4755`) or symbolic (`u+x`, `go-w`,
 * `a=rX`, several clauses separated by commas). Returns the new permission bits, or an error
 * message.
 */
export function parseChmod(
    input: string,
    currentMode: number,
    isDirectory: boolean,
): number | string {
    const text = input.trim();
    if (/^[0-7]{1,4}$/.test(text)) {
        return parseInt(text, 8);
    }
    let mode = currentMode & 0o7777;
    for (const clause of text.split(",")) {
        const match = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause.trim());
        if (!match) {
            return `"${clause.trim()}" is not a valid mode. Use octal (755) or symbolic (u+x,go-w).`;
        }
        const [, whoText, op, permText] = match;
        const who = whoText === "" || whoText.includes("a") ? "ugo" : whoText;
        const anyExec = (mode & 0o111) !== 0;
        let mask = 0;
        for (const w of who) {
            const shift = w === "u" ? 6 : w === "g" ? 3 : 0;
            for (const p of permText) {
                if (p === "r") {
                    mask |= 0o4 << shift;
                } else if (p === "w") {
                    mask |= 0o2 << shift;
                } else if (p === "x" || (p === "X" && (isDirectory || anyExec))) {
                    mask |= 0o1 << shift;
                } else if (p === "s" && w === "u") {
                    mask |= 0o4000;
                } else if (p === "s" && w === "g") {
                    mask |= 0o2000;
                } else if (p === "t" && w === "o") {
                    mask |= 0o1000;
                }
            }
        }
        if (op === "+") {
            mode |= mask;
        } else if (op === "-") {
            mode &= ~mask;
        } else {
            let clear = 0;
            for (const w of who) {
                clear |= w === "u" ? 0o4700 : w === "g" ? 0o2070 : 0o1007;
            }
            mode = (mode & ~clear) | mask;
        }
    }
    return mode;
}

export interface FolderSize {
    bytes: number;
    files: number;
    /** True when the walk stopped early (time limit or cancel); `bytes` is then a lower bound. */
    partial: boolean;
}

/**
 * Add up the sizes of all files under `root`. Symbolic links are not followed.
 * Stops when `isCancelled()` becomes true or `timeLimitMs` passes.
 */
export async function folderSize(
    root: string,
    timeLimitMs: number,
    isCancelled: () => boolean,
): Promise<FolderSize> {
    const deadline = Date.now() + timeLimitMs;
    const result: FolderSize = { bytes: 0, files: 0, partial: false };
    const stack = [root];
    while (stack.length > 0) {
        if (isCancelled() || (timeLimitMs > 0 && Date.now() > deadline)) {
            result.partial = true;
            break;
        }
        const dir = stack.pop() as string;
        let entries: FS.Dirent[];
        try {
            entries = await FS.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        const files: string[] = [];
        for (const entry of entries) {
            const full = OSPath.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile()) {
                files.push(full);
            }
        }
        await Promise.all(
            files.map(async (file) => {
                const st = await FS.promises.lstat(file).catch(() => undefined);
                if (st) {
                    result.bytes += st.size;
                    result.files++;
                }
            }),
        );
    }
    return result;
}
