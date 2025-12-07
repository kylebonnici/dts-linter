# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.3.7-hotfix2] - 2025-12-07

### Fixed

- Bump up `devicetree-language-server` to version 0.7.2-hotfix1 to address:
  - Formatting of properties when under nodes
  - Formatting of Node when defined inside a Macro block
  - Formatting of property values when these exceed wordWrapColumn

## [0.3.6] - 2025-11-04

### Change

- Harden starting of dts-lsp server by using the absolute path of Node.js
  that was used to start the dts-linter it self

## [0.3.5] - 2025-11-04

### Fixed

- Bump up `devicetree-language-server` to version 0.6.7 to address:
  - Formatting issue with trailing whitespace on windows.
- Fixed issue with dts-linter not starting up at all on windows.

## [0.3.4] - 2025-11-02

### Fixed

- Bump up `devicetree-language-server` to version 0.6.6 to address:
  - Formatting of comments used in MACRO params.

## [0.3.3] - 2025-10-29

### Fixed

- Bump up `devicetree-language-server` to version 0.6.4 to address:
  - Formatting issue where arguments of a MACRO call are forced on one line.
  - Formatter would not format first value after `(` properly when the value
    is not on the same line as `(`
  - Issue with parser when processing files that use macros to generate code.

## [0.3.2] - 2025-10-24

### Fixed

- Bump up `devicetree-language-server` to version 0.6.3 to address `undefined` in
  annotation messages.

## [0.3.1] - 2025-10-24

### Fixed

- JSON output is now written directly to stdout and awaited before process exists
  to prevent truncation caused by buffered output.

## [0.3.0] - 2025-10-22

### Added

- `--threads` Flag to process files in parallel. Default is 1

### Changed

- Renamed `--outputType` flag to `--outputFormat`
- Renamed `--outFile` flag to `--patchFile`
- Renamed `--files` flag to `--file`
- Renamed `--includes` flag to `--include`
- Renamed `--bindings` flag to `--binding`
- JSON Output will return one Object result at the end

## [0.2.1] - 2025-09-16

### Added

- `--outputType` Flag to configure output type. Defaults to auto.
- `--version` Flag to return the version of the dts-linter.

### Changed

- Moved `--annotate` flag to `--outputType`

## [0.2.0] - 2025-09-16

### Added

- `--annotate` Flag to force output to be GitHub Actions-compatible annotations.

## [0.1.2] - 2025-09-15

### Changes

- Make output dist smaller

### Fixed

- Output message for cwd used when `--files` is not used

## [0.1.1] - 2025-09-15

### Fixed

- Output message when using `--formatFixAll`

## [0.1.0] - 2025-09-12

### Added

- First stable release
