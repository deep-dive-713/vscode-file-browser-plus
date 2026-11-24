# File Browser Plus

An integrated, keyboard driven file selector for VS Code, inspired by Emacs's
[Helm](https://emacs-helm.github.io/helm/) file selector, with some of the details you get from
Emacs's dired.

This is a fork of [File Browser](https://github.com/bodil/vscode-file-browser) (`bodil.file-browser`)
by Bodil Stokke. The original features are unchanged; the additions are listed below.

![screenshot](images/file-browser.gif)

## Features

From the original File Browser:

- A fully keyboard driven file open dialog: bind `file-browser-plus.open` to `Ctrl+O` (or
  `C-x C-f` if you're an Emacs expat) and enjoy the lack of OS file dialog clutter.
- Start typing a file name to quickly find it in the current folder. Use `Tab` to autocomplete.
- Automatically create files and folders just by typing their names and selecting the option that
  appears.
- Easy navigation in and out of folders by using the left and right arrow keys.
- Navigate to your home folder by typing `~/` into the search box, or step up to the parent folder
  by typing `../`.
- Perform file operations like rename and delete by stepping into a file with the right arrow key,
  or by hitting `Ctrl+A` on any file or folder.

Added in File Browser Plus:

- Names with numbers are sorted in natural order (`Example_2` comes before `Example_10`).
- Each entry shows its permissions (`drwxr-xr-x`), its size (`4.0K`, like `ls -lh`) and, for
  symbolic links, where the link points to. Each can be turned off in the settings. Permissions
  are not shown on Windows.
- Change permissions from the actions (`Ctrl+A`): enter an octal mode (`755`) or a symbolic one
  (`u+x,go-w`), like `chmod`. Not available on Windows.
- Create a folder in the listed folder with the "New folder" button in the title bar, the
  `file-browser-plus.newFolder` command, or from the actions. Use `/` to create nested folders.
- Create a new file from the actions, too.
- Folder sizes are not calculated while listing, to keep the list fast. Choose "Calculate folder
  size" in the actions of a folder to add up its size in the background. The result is shown next
  to the folder until the browser is closed. It stops when you list another folder or after
  `file-browser-plus.folderSizeTimeLimit` seconds (10 by default), and then shows the size found
  so far.
- Files have an "Open to the side" button, and there is a `file-browser-plus.openToSide` command
  to bind to a key.
- When the typed text does not match a file exactly, "Open as new file" is listed last instead of
  being selected, so `Enter` opens the best matching existing file.

Permissions, sizes and link targets are read with Node.js directly, so they are shown only for
files on disk (including the remote side of Remote - SSH and WSL, where the extension runs).

## Settings

| Setting                                 | Default | Meaning                                        |
| --------------------------------------- | ------- | ---------------------------------------------- |
| `file-browser-plus.showPermissions`     | `true`  | Show permissions such as `drwxr-xr-x`          |
| `file-browser-plus.showSize`            | `true`  | Show file sizes                                |
| `file-browser-plus.showLinkTarget`      | `true`  | Show where symbolic links point to             |
| `file-browser-plus.folderSizeTimeLimit` | `10`    | Seconds before a folder size calculation stops |

The settings of the original extension (`hideDotfiles`, `hideIgnoredFiles` and so on) are
available under `file-browser-plus.` as well. Both extensions can be installed at the same time,
as the commands, settings and the `inFileBrowserPlus` context key have their own names.

## Credits

Based on [File Browser](https://github.com/bodil/vscode-file-browser) by Bodil Stokke. It also
includes changes adapted from pull requests to the original repository:

- [#57](https://github.com/bodil/vscode-file-browser/pull/57) by niontrix: fix the folder name
  being repeated when stepping into a folder with `Tab`
- [#53](https://github.com/bodil/vscode-file-browser/pull/53) by carlosflorencio: open a file to
  the side from a button or a command
- [#24](https://github.com/bodil/vscode-file-browser/pull/24) by rbadapanda: fewer keystrokes for
  opening existing files, new files from the actions, activation on startup

## Licence

Copyright 2020 Bodil Stokke (original File Browser)

Modifications copyright 2026 deep-dive-713 (File Browser Plus)

This program is free software: you can redistribute it and/or modify it under the terms of the GNU
Lesser General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
General Public License for more details.

You should have received a copy of the GNU Lesser General Public License along with this program. If
not, see <https://www.gnu.org/licenses/>.

## Code of Conduct

Please note that this project is released with a [Contributor Code of Conduct][coc]. By
participating in this project you agree to abide by its terms.

[coc]: https://github.com/deep-dive-713/vscode-file-browser-plus/blob/master/CODE_OF_CONDUCT.md
