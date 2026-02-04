#!/usr/bin/env node

import cp from "child_process";
import {
  Context,
  ContextListItem,
  File,
} from "devicetree-language-server-types";
import fs, { existsSync } from "fs";
import path from "path";
import { createMessageConnection, MessageConnection } from "vscode-jsonrpc";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

import { z } from "zod";
import { parseArgs } from "node:util";
import { basename, relative, resolve } from "node:path";
import { applyPatch, createPatch } from "diff";
import { globSync } from "glob";
import pkg from "../package.json";
import {
  Diagnostic,
  DiagnosticSeverity,
  TextDocumentItem,
} from "vscode-languageserver-types";
import { error } from "node:console";

const serverPath = require.resolve("devicetree-language-server/dist/server.js");
interface ContextConfig {
  mainFile: string;
  includePaths?: string[];
  bindingPaths?: string[];
  overlayRuns?: string[][];
  onlyRunWithOverlays?: boolean;
}

interface LSPWorker {
  id: number;
  process: cp.ChildProcess;
  connection: MessageConnection;
  busy: boolean;
}

class LSPWorkerPool {
  private workers: LSPWorker[] = [];
  private queue: Array<() => void> = [];

  constructor(
    private poolSize: number,
    private cwd: string,
    private includesPaths: string[],
    private bindings: string[],
    private logLevel: LogLevel,
  ) {}

  async initialize(): Promise<void> {
    const initPromises = [];
    for (let i = 0; i < this.poolSize; i++) {
      initPromises.push(this.createWorker(i));
    }
    await Promise.all(initPromises);
  }

  private async createWorker(id: number): Promise<void> {
    const lspProcess = cp.spawn(process.execPath, [serverPath, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    lspProcess.stderr.on("data", (chunk) => {
      if (this.logLevel === "verbose") {
        console.error(`LSP Worker ${id} stderr:`, chunk.toString());
      }
    });

    const connection = createMessageConnection(
      new StreamMessageReader(lspProcess.stdout),
      new StreamMessageWriter(lspProcess.stdin),
    );

    if (this.logLevel === "verbose") {
      connection.onNotification("window/logMessage", (params) => {
        const levelMap: Record<number, string> = {
          1: "ERROR",
          2: "WARN",
          3: "INFO",
          4: "LOG",
        };

        const level = levelMap[params.type as number] || "LOG";
        log("info", `[LSP Worker ${id} ${level}] ${params.message}`);
      });
    }

    connection.onRequest("workspace/workspaceFolders", () => {
      return [
        {
          uri: `file://${this.cwd}`,
          name: "root",
        },
      ];
    });

    connection.listen();

    connection.sendNotification("workspace/didChangeConfiguration", {
      settings: {
        devicetree: {
          defaultIncludePaths: this.includesPaths,
          defaultBindingType: "Zephyr",
          defaultZephyrBindings: this.bindings,
          cwd: this.cwd,
          autoChangeContext: true,
          allowAdhocContexts: true,
          defaultLockRenameEdits: [],
        },
      },
    });

    const workspaceFolders = [{ uri: toFileUri(this.cwd), name: "root" }];

    await connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: toFileUri(this.cwd),
      capabilities: {},
      workspaceFolders,
    });

    await connection.sendNotification("initialized");

    const worker: LSPWorker = {
      id,
      process: lspProcess,
      connection,
      busy: false,
    };

    this.workers.push(worker);
  }

  async getAvailableWorker(): Promise<LSPWorker> {
    return new Promise((resolve) => {
      const availableWorker = this.workers.find((w) => !w.busy);
      if (availableWorker) {
        availableWorker.busy = true;
        resolve(availableWorker);
      } else {
        this.queue.push(() => {
          const worker = this.workers.find((w) => !w.busy);
          if (worker) {
            worker.busy = true;
            resolve(worker);
          }
        });
      }
    });
  }

  releaseWorker(worker: LSPWorker): void {
    worker.busy = false;
    const nextTask = this.queue.shift();
    if (nextTask) {
      nextTask();
    }
  }

  async dispose(): Promise<void> {
    for (const worker of this.workers) {
      worker.connection.dispose();
      worker.process.kill();
    }
    this.workers = [];
  }
}

function toFileUri(filePath: string): string {
  let resolvedPath = path.resolve(filePath);
  // On Windows, convert backslashes to forward slashes
  resolvedPath = resolvedPath.replace(/\\/g, "/");
  // Ensure it starts with a slash
  if (!resolvedPath.startsWith("/")) {
    resolvedPath = "/" + resolvedPath;
  }
  return `file://${resolvedPath}`;
}

function isGitCI(): boolean {
  const env = process.env;

  return Boolean(
    env.CI &&
    (env.GITHUB_ACTIONS || // GitHub Actions
      env.GITLAB_CI || // GitLab CI
      env.BITBUCKET_BUILD_NUMBER || // Bitbucket Pipelines
      env.CIRCLECI || // CircleCI
      env.TRAVIS), // Travis CI
  );
}

const schema = z.object({
  file: z.array(z.string().optional()).optional(),
  cwd: z.string().optional(),
  include: z.array(z.string()).optional().default([]),
  binding: z.array(z.string()).optional().default([]),
  logLevel: z.enum(["none", "verbose"]).optional().default("none"),
  format: z.boolean().optional().default(false),
  formatFixAll: z.boolean().optional().default(false),
  processIncludes: z.boolean().optional().default(false),
  diagnostics: z.boolean().optional().default(false),
  diagnosticsFull: z.boolean().optional().default(false),
  diagnosticsConfig: z.string().optional(),
  showInfoDiagnostics: z.boolean().optional().default(false),
  patchFile: z.string().optional(),
  outputFormat: z
    .enum(["auto", "pretty", "annotations", "json"])
    .optional()
    .default("auto"),
  threads: z.number().int().min(1).optional().default(1),
  version: z.boolean().optional().default(false),
  help: z.boolean().optional().default(false),
});
type SchemaType = z.infer<typeof schema>;

const helpString = `Usage: dts-linter [options]

Options:
  --file                                          List of input files (can be repeated).
  --cwd <path>                                    Set the current working directory.
  --include                                       Paths (absolute or relative to CWD) to resolve includes (default: []).
  --binding                                       Zephyr binding root directories (default: []).
  --logLevel <none|verbose>                       Set the logging verbosity (default: none).
  --format                                        Format the files specified in --file (default: false).
  --formatFixAll                                  Apply formatting changes directly to the files (default: false).
  --diagnostics                                   Show basic syntax diagnostics for files (default: false).
  --diagnosticsFull                               Show full diagnostics for files (default: false).
  --diagnosticsConfig <path>                      Path to diagnostics configuration file.
  --showInfoDiagnostics                           Show information diagnostics
  --patchFile <path>                              Write formatting diff output to this file (optional).
  --outputFormat <auto|pretty|annotations|json>   stdout output type.
  --threads <number>                              Number of parallel LSP instances to use (default: 1).
  --version                                       Show version information (default: false).
  --help                                          Show help information (default: false).

Example:
  dts-linter --file file1.dts --file file2.dtsi --format --diagnostics --threads 4`;

let argv: SchemaType;
try {
  const { values } = parseArgs({
    options: {
      file: { type: "string", multiple: true },
      cwd: { type: "string" },
      include: { type: "string", multiple: true },
      binding: { type: "string", multiple: true },
      logLevel: { type: "string" },
      format: { type: "boolean" },
      formatFixAll: { type: "boolean" },
      diagnostics: { type: "boolean" },
      diagnosticsFull: { type: "boolean" },
      diagnosticsConfig: { type: "string" },
      showInfoDiagnostics: { type: "boolean" },
      patchFile: { type: "string" },
      outputFormat: { type: "string" },
      threads: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
  });

  // Convert threads string to number if provided
  const processedValues = {
    ...values,
    threads: values.threads ? parseInt(values.threads, 10) : undefined,
  };

  const safeParseData = schema.safeParse(processedValues);
  if (!safeParseData.success) {
    console.log(helpString);
    process.exit(1);
  }
  argv = safeParseData.data;
} catch {
  console.log(helpString);
  process.exit(1);
}

if (argv.help) {
  console.log("Invalid arguments");
  console.log(helpString);
  process.exit(0);
}

if (argv.version) {
  console.log(`${pkg.name} version ${pkg.version}`);
  process.exit(0);
}

const includesPaths = argv.include;
const bindings = argv.binding;
const logLevel = argv.logLevel as LogLevel;
const formatFixAll = argv.formatFixAll;
const format = argv.format || formatFixAll;
const diagnosticsFull = argv.diagnosticsFull;
const diagnostics = argv.diagnostics || diagnosticsFull;
const showInfoDiagnostics = argv.showInfoDiagnostics;
const outputFormat = argv.outputFormat;
const patchFile = argv.patchFile;
const threads = argv.threads;
const diagnosticsConfigPath = argv.diagnosticsConfig;

if (diagnosticsConfigPath && argv.file) {
  console.log(`Cannot use --diagnosticsConfig with --file option.`);
  process.exit(0);
}

const onGit =
  (isGitCI() && outputFormat === "auto") || outputFormat === "annotations";

const grpStart = () => (onGit ? "::group::" : "");
const grpEnd = () => (onGit ? "::endgroup::" : "");

const file = (file: string) =>
  onGit ? `file=${relative(cwd, file)}` : relative(cwd, file);
const startMsg = (line: number, col?: number) =>
  onGit
    ? `line=${line}${col ? `,col=${col}` : ""}`
    : `line: ${line} ${col ? `col=${col}` : ""}`;
const endMsg = (line: number, col?: number) =>
  onGit
    ? `endLine=${line}${col ? `,endColumn=${col}` : ""}`
    : `endLine: ${line} ${col ? `endColumn=${col}` : ""}`;

const joinStr = onGit ? "," : " ";

type Level = "warn" | "error" | "info";
const levelToGitAnnotation = (level: Level) => {
  switch (level) {
    case "error":
      return "::error";
    case "warn":
      return "::warning";
    case "info":
      return "::notice";
  }
};

const gitAnnotation = (
  level: Level,
  message: string,
  fileName?: string,
  titleStr?: string,

  start?: {
    col?: number;
    line: number;
  },
  end?: {
    col?: number;
    line: number;
  },
) => {
  const items = [
    fileName ? `file=${fileName}` : null,
    start ? `line=${start.line}` : null,
    start?.col ? `col=${start.col}` : null,
    end ? `endLine=${end.line}` : null,
    end?.col ? `endColumn=${end.col}` : null,
    titleStr ? `title=${titleStr}` : null,
  ].filter((i) => !!i);
  console.log(`${levelToGitAnnotation(level)} ${items.join(",")}::${message}`);
};

const log = (
  level: Level,
  message: string,
  fileName?: string,
  titleStr?: string,

  start?: {
    col?: number;
    line: number;
  },
  end?: {
    col?: number;
    line: number;
  },
  indent?: string,
  progressString?: string,
) => {
  if (outputFormat === "json") {
    jsonOut.issues.push({
      level,
      message: message.trim(),
      file: fileName ? relative(cwd, fileName.trim()) : undefined,
      title: titleStr?.trim(),
      startLine: start?.line,
      startCol: start?.col,
      endLine: end?.line,
      endCol: end?.col,
    });
    return;
  }

  if (onGit) {
    gitAnnotation(
      level,
      message,
      fileName ? relative(cwd, fileName) : undefined,
      titleStr,
      start,
      end,
    );
    return;
  }

  if (level === "info") {
    console.log(`✅ ${indent ?? ""}${progressString ?? ""} ${message}`);
    return;
  }

  console.log(
    `${level === "error" ? "❌" : "⚠️"} ${indent ?? ""}${
      progressString ?? ""
    } ${[
      fileName?.trim() ? file(fileName) : fileName,
      start ? startMsg(start.line, start.col) : undefined,
      end ? endMsg(end.line, end.col) : undefined,
      message,
    ]
      .filter((v) => !!v)
      .join(joinStr)}`,
  );
};

type LogLevel = "none" | "verbose";
const cwd = argv.cwd ?? process.cwd();

type Issue = {
  level: string;
  message: string;
  title?: string;
  file?: string;
  startLine?: number;
  startCol?: number;
  endLine?: number;
  endCol?: number;
};
const jsonOut: { cwd: string; issues: Issue[] } = {
  cwd,
  issues: [],
};

if (!argv.diagnosticsConfig && !argv.file) {
  const globString = diagnosticsFull ? "**/*.{dts}" : "**/*.{dts,dtsi,overlay}";
  log("info", `Searching for '${globString}' in ${cwd}`);
  argv.file = globSync(globString, {
    cwd: argv.cwd,
    nodir: true,
  });
}

const configs: ContextConfig[] = [];
if (argv.diagnosticsConfig) {
  const configContent = fs.readFileSync(
    resolve(cwd, argv.diagnosticsConfig),
    "utf8",
  );
  try {
    const parsedConfig = JSON.parse(configContent) as ContextConfig[];
    configs.push(
      ...parsedConfig.map((c) => ({
        ...c,
        mainFile: resolve(cwd, c.mainFile),
        includePaths: c.includePaths?.map((p) => resolve(cwd, p)),
        bindingPaths: c.bindingPaths?.map((p) => resolve(cwd, p)),
        overlayRuns: c.overlayRuns?.map((or) => or.map((p) => resolve(cwd, p))),
      })),
    );
  } catch (e) {
    console.log(`Failed to parse diagnostics config file: ${e}`);
    process.exit(1);
  }
} else if (argv.file) {
  configs.push(
    ...argv.file
      .filter((f) => !!f)
      .map<ContextConfig>((f) => ({
        mainFile: resolve(cwd, f!),
      })),
  );
}

const diffs = new Map<string, string>();
let formattingErrors: { file: string; context?: ContextListItem }[] = [];
let formattingApplied: { file: string; context?: ContextListItem }[] = [];
let diagnosticIssues = new Map<
  string,
  {
    maxSeverity: DiagnosticSeverity;
    message: string;
    context: ContextListItem;
  }[]
>();
const completedPaths = new Set<string>();
const diffApplied = new Set<string>();

run().catch((err) => {
  console.error("Error validating files:", err);
  process.exit(1);
});

const diagnosticSeverityToString = (
  severity: DiagnosticSeverity = DiagnosticSeverity.Hint,
): string => {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "error";
    case DiagnosticSeverity.Warning:
      return "warn";
    case DiagnosticSeverity.Information:
      return "info";
    case DiagnosticSeverity.Hint:
      return "hint";
  }
};

async function contextDiagnostics(
  worker: LSPWorker,
  run: Context,
  fileIndex: number,
  context: ContextListItem,
) {
  await worker.connection.sendRequest("devicetree/setActive", {
    id: context.id,
  });

  const isMainFile = (f: string) => f === run.dtsFile;
  const progressString = (isMainFile: boolean, j: number) =>
    isMainFile
      ? `[${fileIndex}/${numberOfRuns}]`
      : `[${j}/${files.length - 1}]`.padEnd(
          (files.length - 1).toString().length * 2 + 3,
          " ",
        );

  const files = [
    ...flatFileTree(context.mainDtsPath),
    ...context.overlays.flatMap(flatFileTree),
  ].filter((f) => !f.endsWith(".h") && existsSync(f));

  await Promise.all(
    files.map(async (f, j) => {
      const mainFile = isMainFile(f);
      if (run.dtsFile.endsWith(".dts") || !diagnosticsFull) {
        const issues = await fileDiagnosticIssues(
          worker.connection,
          f,
          mainFile,
          progressString(mainFile, j),
          run,
        );
        if (issues?.length) {
          if (!diagnosticIssues.has(f)) {
            diagnosticIssues.set(f, []);
          }
          diagnosticIssues.get(f)?.push({
            maxSeverity: issues.reduce(
              (p, c) =>
                (c.severity ?? DiagnosticSeverity.Hint) < p
                  ? (c.severity ?? DiagnosticSeverity.Hint)
                  : p,
              DiagnosticSeverity.Hint as DiagnosticSeverity,
            ),
            context,
            message: issues
              .map(
                (issue) =>
                  `[${diagnosticSeverityToString(issue.severity)}] ${
                    issue.message
                  }: ${JSON.stringify(issue.range.start)}-${JSON.stringify(
                    issue.range.end,
                  )}`,
              )
              .join("\n\t\t"),
          });
        }
      } else {
        skippedDiagnosticChecks.add(f);
        log(
          "warn",
          "Check can only be done on full context!",
          f,
          undefined,
          undefined,
          undefined,
          `${mainFile ? "" : "\t"}`,
          progressString(mainFile, j),
        );
      }

      completedPaths.add(f);
    }),
  );
  worker.connection.sendRequest("devicetree/removeContext", {
    id: context.id,
    name: run.ctxName,
  });

  await waitForNewContextDeleted(worker.connection, context.id);
}

async function processFileWithWorker(
  worker: LSPWorker,
  config: ContextConfig,
  configIndex: number,
): Promise<void> {
  const text = fs.readFileSync(config.mainFile, "utf8");

  let files = [config.mainFile];
  let context: ContextListItem | undefined;

  if (diagnostics) {
    const runs: Context[] = [];
    if (!config.onlyRunWithOverlays) {
      runs.push({
        ctxName: `dts-linter:${config.mainFile}-no-overlays`,
        dtsFile: config.mainFile,
        includePaths: config.includePaths,
        zephyrBindings: config.bindingPaths,
        cwd,
      } satisfies Context);
    }
    (config.overlayRuns ?? []).forEach((overlaySet, i) => {
      runs.push({
        ctxName: `dts-linter:${config.mainFile}-overlay-run-${i}`,
        dtsFile: config.mainFile,
        overlays: overlaySet,
        includePaths: config.includePaths,
        zephyrBindings: config.bindingPaths,
        cwd,
      } satisfies Context);
    });

    const ctx = await Promise.all(
      runs.map((run) =>
        worker.connection.sendRequest("devicetree/requestContext", run),
      ) as Promise<ContextListItem>[],
    );

    await runs.reduce(
      (prev, cur, index) =>
        prev.finally(() =>
          contextDiagnostics(
            worker,
            cur,
            calcNumberOfRuns(configs.slice(0, configIndex)) + index + 1,
            ctx[index],
          ),
        ),
      Promise.resolve(),
    );
  }

  const isMainFile = (f: string) => f === config.mainFile;
  const progressString = (isMainFile: boolean, j: number) =>
    isMainFile
      ? `[${configIndex}/${numberOfRuns}]`
      : `[${j}/${files.length - 1}]`.padEnd(
          (files.length - 1).toString().length * 2 + 3,
          " ",
        );

  if (format) {
    await Promise.all(
      files.map(async (f, j) => {
        const mainFile = isMainFile(f);
        const indent = progressString(mainFile, j);

        try {
          await formatFile(
            worker.connection,
            f,
            mainFile,
            indent,
            mainFile ? text : fs.readFileSync(f, "utf8"),
            context,
          );
        } catch (e: any) {
          formattingErrors.push({
            file: f,
            context,
          });

          if (outputFormat === "json") {
            (e?.data as Diagnostic[] | undefined)?.map((issue) => {
              log(
                "error",
                issue.message,
                f,
                "Syntax error.",
                {
                  line: issue.range.start.line + 1,
                  col: issue.range.start.character,
                },
                {
                  line: issue.range.end.line + 1,
                  col: issue.range.end.character,
                },
              );
            });
          } else {
            const message =
              (e?.data as Diagnostic[] | undefined)
                ?.map(
                  (issue) =>
                    `[${diagnosticSeverityToString(issue.severity)}] ${
                      issue.message
                    }: ${JSON.stringify(issue.range.start)}-${JSON.stringify(
                      issue.range.end,
                    )}`,
                )
                .join("\n\t\t") ?? "";
            log(
              "error",
              `\n\t\t${message}`,
              f,
              "Syntax error.",
              undefined,
              undefined,
              indent,
            );
          }
        }

        completedPaths.add(f);
      }),
    );
  }

  if (formatFixAll) {
    files
      .filter((f) => !diffApplied.has(f))
      .forEach((f) => {
        const diff = diffs.get(f);
        if (diff) {
          const result = applyPatch(fs.readFileSync(f, "utf8"), diff);
          if (result) {
            diffApplied.add(f);
            fs.writeFileSync(f, result, "utf8");
            formattingApplied.push({ file: f, context });
          } else {
            log("error", "Failed to apply changes to file", f);
          }
        }
      });
  }
}

const calcNumberOfRuns = (configs: ContextConfig[]) =>
  configs.reduce((acc, curr) => {
    return (
      acc + (curr.overlayRuns?.length ?? 0) + (curr.onlyRunWithOverlays ? 0 : 1)
    );
  }, 0);

const numberOfRuns = calcNumberOfRuns(configs);

async function run() {
  const workerPool = new LSPWorkerPool(
    threads,
    cwd,
    includesPaths,
    bindings,
    logLevel,
  );

  await workerPool.initialize();

  // Process files in parallel using the worker pool
  const fileProcessingPromises = configs.map(async (config, index) => {
    const worker = await workerPool.getAvailableWorker();

    await processFileWithWorker(worker, config, index).finally(() => {
      workerPool.releaseWorker(worker);
    });
  });

  await Promise.all(fileProcessingPromises);

  if (patchFile) {
    fs.writeFileSync(patchFile, Array.from(diffs.values()).join("\n\n"));
  }

  await workerPool.dispose();

  if (outputFormat === "json") {
    await new Promise<void>((resolve) => {
      process.stdout.write(JSON.stringify(jsonOut, undefined, 4), () =>
        resolve(),
      );
    });
  } else {
    log("info", `Processed ${completedPaths.size} files`);
    if (format && !onGit) {
      if (formattingErrors.length - formattingApplied.length)
        log(
          "error",
          `${formattingErrors.length - formattingApplied.length} of ${
            completedPaths.size
          } Failed formatting checks`,
        );

      if (formattingApplied.length)
        log(
          "info",
          `${formattingApplied.length} of ${formattingErrors.length} formatted in place.`,
        );

      if (!formattingErrors.length) log("info", `All files passed formatting`);
    }

    if (diagnosticIssues.size) {
      if (outputFormat === "pretty" || outputFormat === "auto") {
        console.log("Diagnostic issues summary");

        console.log(
          Array.from(diagnosticIssues.entries())
            .flatMap(
              ([k, vs]) =>
                `${grpStart()}File: ${relative(cwd, k)}\n\t${vs
                  .flatMap(
                    (v) =>
                      `Board File: ${relative(
                        cwd,
                        v.context.mainDtsPath.file,
                      )}${v.context.overlays.length ? `, Overlays: ${v.context.overlays.map((p) => basename(p.file)).join(" ")}` : ""}\n\tIssues:\n\t\t${v.message.replaceAll(
                        "[error]",
                        "[err]",
                      )}`,
                  )
                  .join("\n\t")}\n${grpEnd()}`,
            )
            .join("\n"),
        );

        log(
          "error",
          `${diagnosticIssues.size} of ${completedPaths.size} file failed diagnostic checks`,
        );

        if (skippedDiagnosticChecks.size) {
          log(
            "warn",
            `${skippedDiagnosticChecks.size} of ${completedPaths.size} Skipped diagnostic checks`,
          );
        }
      }

      const errOrWarn = Array.from(diagnosticIssues).filter((i) =>
        i[1].some((ii) => ii.maxSeverity <= DiagnosticSeverity.Warning),
      );
      const hasWarnOrError = !!errOrWarn.length;

      if (
        processedDiagnosticChecks.size === completedPaths.size &&
        !hasWarnOrError
      ) {
        log("info", "All files passed diagnostic checks");
      } else {
        log(
          "error",
          `${errOrWarn.length} of ${completedPaths.size} Failed diagnostic checks`,
        );
      }
    }
  }

  process.exit(
    formattingErrors.length - formattingApplied.length || diagnosticIssues.size
      ? 1
      : 0,
  );
}

const flatFileTree = (file: File): string[] => {
  return [file.file, ...file.includes.flatMap((f) => flatFileTree(f))];
};

const formatFile = async (
  connection: MessageConnection,
  absPath: string,
  mainFile: boolean,
  progressString: string,
  originalText: string,
  context?: ContextListItem,
) => {
  const params = {
    textDocument: {
      uri: `file://${absPath}`,
    },
    options: {
      tabSize: 8,
      insertSpaces: false,
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
      trimFinalNewlines: true,
    },
    text: originalText,
  };

  const result = (await connection.sendRequest(
    "devicetree/formattingText",
    params,
  )) as { text: string; diagnostics: Diagnostic[] } | undefined;

  const indent = mainFile ? "" : "\t";

  if (result && result.text !== originalText) {
    const newText = result?.text;
    const relativePath = relative(cwd, absPath);
    const diff = createPatch(`a/${relativePath}`, originalText, newText);
    log(
      "error",
      diff,
      absPath,
      "Not correctly formatted.",
      undefined,
      undefined,
      indent,
      progressString,
    );

    if (outputFormat === "json" || outputFormat === "annotations") {
      result.diagnostics.forEach((issue) => {
        log(
          "error",
          issue.message,
          absPath,
          undefined,
          {
            line: issue.range.start.line + 1,
            col: issue.range.start.character,
          },
          {
            line: issue.range.end.line + 1,
            col: issue.range.end.character,
          },
        );
      });
    }

    if (diffs.has(absPath)) {
      if (diffs.get(absPath) !== diff && patchFile) {
        log(
          "warn",
          "Multiple diffs for the same file. This diff will not be in the generated file!",
          absPath,
          undefined,
          undefined,
          undefined,
          indent,
          progressString,
        );
      }
    } else {
      formattingErrors.push({
        file: absPath,
        context,
      });
      diffs.set(absPath, diff);
    }

    return diff;
  } else {
    log(
      "info",
      `${relative(cwd, absPath)} is correctly formatted`,
      undefined,
      undefined,
      undefined,
      undefined,
      indent,
      progressString,
    );
  }
};

let processedDiagnosticChecks = new Set<string>();
let skippedDiagnosticChecks = new Set<string>();
const fileDiagnosticIssues = async (
  connection: MessageConnection,
  absPath: string,
  isMainFile: boolean,
  progressString: string,
  run: Context,
) => {
  processedDiagnosticChecks.add(absPath);
  const issues = (
    ((await connection.sendRequest("devicetree/diagnosticIssues", {
      uri: `file://${absPath}`,
      full: diagnosticsFull,
    })) as Diagnostic[] | undefined) ?? []
  ).filter(
    (issue) =>
      issue.severity === DiagnosticSeverity.Error ||
      issue.severity === DiagnosticSeverity.Warning ||
      (issue.severity === DiagnosticSeverity.Information &&
        showInfoDiagnostics),
  );

  const indent = isMainFile ? "" : "\t";

  if (issues.length) {
    issues.forEach((issue, i) => {
      const errorLevel =
        issue.severity === DiagnosticSeverity.Error
          ? "error"
          : issue.severity === DiagnosticSeverity.Warning
            ? "warn"
            : "warn";
      const message =
        outputFormat === "json"
          ? `Board File: ${run.dtsFile}${run.overlays?.length ? `, Overlays: ${run.overlays.map((f) => relative(cwd, f)).join(" ")}` : ""}, Message: ${issue.message}`
          : issue.message;
      const file =
        onGit || outputFormat === "json"
          ? absPath
          : i
            ? "\t"
            : isMainFile
              ? `${absPath}${run.overlays?.length ? ` (Overlays: ${run.overlays.map((f) => relative(cwd, f)).join(" ")})` : ""}\n${indent}\t`
              : `${absPath}\n${indent}\t`;
      const progressStr = i ? "" : progressString;
      log(
        errorLevel,
        message,
        file,
        undefined,
        {
          line: issue.range.start.line + 1,
          col: issue.range.start.character,
        },
        {
          line: issue.range.end.line + 1,
          col: issue.range.end.character,
        },
        indent,
        progressStr,
      );
    });

    return issues;
  } else {
    log(
      "info",
      `No diagnostic errors in ${relative(cwd, absPath)}${run.overlays?.length ? ` (Overlays: ${run.overlays.map((f) => relative(cwd, f)).join(" ")})` : ""}`,
      undefined,
      undefined,
      undefined,
      undefined,
      indent,
      progressString,
    );
  }
};

function waitForNewContextDeleted(
  connection: MessageConnection,
  id: string,
  timeoutMs = 6000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for devicetree/contextDeleted"));
      d.dispose();
    }, timeoutMs);

    const d = connection.onNotification(
      "devicetree/contextDeleted",
      (ctx: ContextListItem) => {
        if (ctx.id !== id) return;
        clearTimeout(timeout);
        resolve();
        d.dispose();
      },
    );
  });
}
