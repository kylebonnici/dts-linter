# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.3.1] - 2025-09-24

### Fixed

- JSON output is now written directly to stdout and awaited before process exists
  to prevent truncation caused by buffered output.

## [0.3.0] - 2025-09-22

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
