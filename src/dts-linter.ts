#!/usr/bin/env node

import cp from "child_process";
import { ContextListItem, File } from "devicetree-language-server-types";
import fs, { existsSync } from "fs";
import path from "path";
import { createMessageConnection, MessageConnection } from "vscode-jsonrpc";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import {
  TextDocumentItem,
  DocumentFormattingParams,
  Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver-protocol";

import { z } from "zod";
import { parseArgs } from "node:util";
import { relative, resolve } from "node:path";
import { applyPatch, createPatch } from "diff";
import * as core from "@actions/core";
import { globSync } from "glob";

const serverPath = require.resolve("devicetree-language-server/dist/server.js");

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
        env.TRAVIS) // Travis CI
  );
}

const schema = z.object({
  files: z.array(z.string().optional()).optional(),
  cwd: z.string().optional(),
  includes: z.array(z.string()).optional().default([]),
  bindings: z.array(z.string()).optional().default([]),
  logLevel: z.enum(["none", "verbose"]).optional().default("none"),
  format: z.boolean().optional().default(false),
  formatFixAll: z.boolean().optional().default(false),
  processIncludes: z.boolean().optional().default(false),
  diagnostics: z.boolean().optional().default(false),
  diagnosticsFull: z.boolean().optional().default(false),
  showInfoDiagnostics: z.boolean().optional().default(false),
  outFile: z.string().optional(),
  outputFormat: z
    .enum(["auto", "pretty", "annotations", "json"])
    .optional()
    .default("auto"),
  help: z.boolean().optional().default(false),
});
type SchemaType = z.infer<typeof schema>;

const helpString = `Usage: dts-linter [options]

Options:
  --files                                         List of input files (can be repeated).
  --cwd <path>                                    Set the current working directory.
  --includes                                      Paths (absolute or relative to CWD) to resolve includes (default: []).
  --bindings                                      Zephyr binding root directories (default: []).
  --logLevel <none|verbose>                       Set the logging verbosity (default: none).
  --format                                        Format the files specified in --files (default: false).
  --formatFixAll                                  Apply formatting changes directly to the files (default: false).
  --processIncludes                               Process includes for formatting or diagnostics (default: false).
  --diagnostics                                   Show basic syntax diagnostics for files (default: false).
  --diagnosticsFull                               Show full diagnostics for files (default: false).
  --showInfoDiagnostics                           Show information diagnostics
  --outFile <path>                                Write formatting diff output to this file (optional).
  --outputType <auto|pretty|annotations|json>     stdout output type.
  --help                                          Show help information (default: false).

Example:
  dts-linter --files file1.dts --files file2.dtsi --format --diagnostics`;

let argv: SchemaType;
try {
  const { values } = parseArgs({
    options: {
      files: { type: "string", multiple: true },
      cwd: { type: "string" },
      includes: { type: "string", multiple: true },
      bindings: { type: "string", multiple: true },
      logLevel: { type: "string" },
      format: { type: "boolean" },
      formatFixAll: { type: "boolean" },
      processIncludes: { type: "boolean" },
      diagnostics: { type: "boolean" },
      diagnosticsFull: { type: "boolean" },
      showInfoDiagnostics: { type: "boolean" },
      outFile: { type: "string" },
      outputFormat: { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });

  const safeParseData = schema.safeParse(values);
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

const includesPaths = argv.includes;
const bindings = argv.bindings;
const logLevel = argv.logLevel as LogLevel;
const formatFixAll = argv.formatFixAll;
const format = argv.format || formatFixAll;
const diagnosticsFull = argv.diagnosticsFull;
const diagnostics = argv.diagnostics || diagnosticsFull;
const showInfoDiagnostics = argv.showInfoDiagnostics;
const processIncludes = argv.processIncludes || diagnosticsFull;
const outputFormat = argv.outputFormat;
const outFile = argv.outFile;

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

const log = (
  level: "warn" | "error" | "info",
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
  progressString?: string
) => {
  if (outputFormat === "json") {
    console.log(
      JSON.stringify({
        level,
        message,
        file: fileName,
        title: titleStr,
        startLine: start?.line,
        startCol: start?.col,
        endLine: end?.line,
        endCol: end?.col,
      })
    );
    return;
  }

  if (onGit) {
    if (level === "info") {
      core.info(message);
    } else {
      const action = level === "error" ? core.error : core.warning;
      action(message, {
        file: fileName ? relative(cwd, fileName) : undefined,
        startLine: start?.line,
        startColumn: start?.col,
        endLine: end?.line,
        endColumn: end?.col,
        title: titleStr,
      });
    }
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
      fileName ? file(fileName) : undefined,
      start ? startMsg(start.line, start.col) : undefined,
      end ? endMsg(end.line, end.col) : undefined,
      message,
    ]
      .filter((v) => !!v)
      .join(joinStr)}`
  );
};

type LogLevel = "none" | "verbose";
const cwd = argv.cwd ?? process.cwd();
if (!argv.files) {
  log("info", `Searching for '**/*.{dts,dtsi,overlay}' in ${cwd}`);
  argv.files = globSync(
    diagnosticsFull ? "**/*.{dts}" : "**/*.{dts,dtsi,overlay}",
    {
      cwd: argv.cwd,
      nodir: true,
    }
  );
}
const filePaths = (argv.files.filter((v) => v) as string[]).map((f) =>
  resolve(cwd, f)
);

let i = 0;
let total = filePaths.length;
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

run().catch((err) => {
  console.error("Error validating files:", err);
  process.exit(1);
});

const diagnosticSeverityToString = (
  severity: DiagnosticSeverity = DiagnosticSeverity.Hint
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

async function run() {
  const lspProcess = cp.spawn(serverPath, ["--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  lspProcess.stderr.on("data", (chunk) => {
    console.error("LSP stderr:", chunk.toString());
  });

  const connection = createMessageConnection(
    new StreamMessageReader(lspProcess.stdout),
    new StreamMessageWriter(lspProcess.stdin)
  );

  if (logLevel === "verbose") {
    connection.onNotification("window/logMessage", (params) => {
      const levelMap: Record<number, string> = {
        1: "ERROR",
        2: "WARN",
        3: "INFO",
        4: "LOG",
      };

      const level = levelMap[params.type as number] || "LOG";
      log("info", `[LSP ${level}] ${params.message}`);
    });
  }

  connection.onRequest("workspace/workspaceFolders", () => {
    // Return workspace folders your client is aware of
    return [
      {
        uri: `file://${cwd}`,
        name: "root",
      },
    ];
  });

  connection.listen();

  connection.sendNotification("workspace/didChangeConfiguration", {
    settings: {
      devicetree: {
        defaultIncludePaths: includesPaths,
        defaultBindingType: "Zephyr",
        defaultZephyrBindings: bindings,
        cwd,
        autoChangeContext: true,
        allowAdhocContexts: true,
        defaultLockRenameEdits: [],
      },
    },
  });

  const workspaceFolders = [{ uri: toFileUri(cwd), name: "root" }];

  await connection.sendRequest("initialize", {
    processId: process.pid,
    rootUri: toFileUri(cwd),
    capabilities: {},
    workspaceFolders,
  });

  await connection.sendNotification("initialized");

  const completedPaths = new Set<string>();
  const diffApplied = new Set<string>();

  const paths = Array.from(new Set(filePaths)).sort((a, b) => {
    const getPriority = (file: string): number => {
      if (file.endsWith(".dts")) return 0;
      if (file.endsWith(".dtsi")) return 1;

      return 2;
    };

    return getPriority(a) - getPriority(b);
  });

  for (const filePath of paths) {
    i++;
    const text = fs.readFileSync(filePath, "utf8");

    const textDocument: TextDocumentItem = {
      uri: toFileUri(filePath),
      languageId: "devicetree",
      version: 0,
      text,
    };

    let files = [filePath];
    let context: ContextListItem | undefined;

    if (diagnostics || processIncludes) {
      connection.sendNotification("textDocument/didOpen", {
        textDocument,
      });

      context = await waitForNewActiveContext(connection);
      files = [
        ...flatFileTree(context.mainDtsPath),
        ...context.overlays.flatMap(flatFileTree),
      ].filter(
        (f) =>
          !f.endsWith(".h") &&
          existsSync(f) &&
          (processIncludes || paths.includes(f))
      );
    }

    const isMainFile = (f: string) => f === filePath;
    const progressString = (isMainFile: boolean, j: number) =>
      isMainFile
        ? `[${i}/${total}]`
        : `[${j}/${files.length - 1}]`.padEnd(
            (files.length - 1).toString().length * 2 + 3,
            " "
          );

    if (format) {
      await Promise.all(
        files.map(async (f, j) => {
          const mainFile = isMainFile(f);
          const indent = progressString(mainFile, j);

          try {
            await formatFile(
              connection,
              f,
              mainFile,
              indent,
              mainFile ? text : fs.readFileSync(f, "utf8"),
              context
            );
          } catch (e: any) {
            formattingErrors.push({
              file: f,
              context,
            });
            const message =
              (e?.data as Diagnostic[] | undefined)
                ?.map(
                  (issue) =>
                    `[${diagnosticSeverityToString(issue.severity)}] ${
                      issue.message
                    }: ${JSON.stringify(issue.range.start)}-${JSON.stringify(
                      issue.range.end
                    )}`
                )
                .join("\n\t\t") ?? "";
            log(
              "error",
              `\n\t\t${message}`,
              f,
              "Synatx error.",
              undefined,
              undefined,
              indent
            );
          }

          completedPaths.add(f);
        })
      );
    }

    if (diagnostics && context) {
      await Promise.all(
        files.map(async (f, j) => {
          const mainFile = isMainFile(f);
          if (filePath.endsWith(".dts") || !diagnosticsFull) {
            const issues = await fileDiagnosticIssues(
              connection,
              f,
              mainFile,
              progressString(mainFile, j)
            );
            if (issues?.length) {
              if (!diagnosticIssues.has(f)) {
                diagnosticIssues.set(f, []);
              }
              diagnosticIssues.get(f)?.push({
                maxSeverity: issues.reduce(
                  (p, c) =>
                    (c.severity ?? DiagnosticSeverity.Hint) < p
                      ? c.severity ?? DiagnosticSeverity.Hint
                      : p,
                  DiagnosticSeverity.Hint as DiagnosticSeverity
                ),
                context,
                message: issues
                  .map(
                    (issue) =>
                      `[${diagnosticSeverityToString(issue.severity)}] ${
                        issue.message
                      }: ${JSON.stringify(issue.range.start)}-${JSON.stringify(
                        issue.range.end
                      )}`
                  )
                  .join("\n\t\t"),
              });
            }
          } else {
            skippeddDiagnosticChecks.add(f);
            log(
              "warn",
              "Check can only be done on full context!",
              f,
              undefined,
              undefined,
              undefined,
              `${mainFile ? "" : "\t"}`,
              progressString(mainFile, j)
            );
          }

          completedPaths.add(f);
        })
      );
    }

    if (diagnostics || processIncludes) {
      connection.sendNotification("textDocument/didClose", {
        textDocument: {
          uri: `file://${filePath}`,
        },
      });

      await waitForNewContextDeleted(connection);
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

  if (outFile) {
    fs.writeFileSync(outFile, Array.from(diffs.values()).join("\n\n"));
  }

  log("info", `Processed ${completedPaths.size} files`);
  connection.dispose();
  lspProcess.kill();

  if (format && !onGit) {
    if (formattingErrors.length - formattingApplied.length)
      log(
        "error",
        `${formattingErrors.length - formattingApplied.length} of ${
          completedPaths.size
        } Failed formatting checks`
      );

    if (formattingApplied.length)
      log(
        "info",
        `${formattingApplied.length} of ${formattingErrors.length} formatted in place.`
      );

    if (!formattingErrors.length) log("info", `All files passed formatting`);
  }

  if (diagnosticIssues.size) {
    if (outputFormat === "pretty" || (outputFormat === "auto" && !onGit)) {
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
                      v.context.mainDtsPath.file
                    )}\n\tIssues:\n\t\t${v.message}`
                )
                .join("\n\t")}\n${grpEnd()}`
          )
          .join("\n")
      );

      log(
        "error",
        `${diagnosticIssues.size} of ${completedPaths.size} file failed diagnostic checks`
      );

      if (skippeddDiagnosticChecks.size) {
        log(
          "warn",
          `${skippeddDiagnosticChecks.size} of ${completedPaths.size} Skipped diagnostic checks`
        );
      }
    }

    const errOrWarn = Array.from(diagnosticIssues).filter((i) =>
      i[1].some((ii) => ii.maxSeverity <= DiagnosticSeverity.Warning)
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
        `${errOrWarn.length} of ${completedPaths.size} Failed diagnostic checks`
      );
    }
  }

  process.exit(
    formattingErrors.length - formattingApplied.length || diagnosticIssues.size
      ? 1
      : 0
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
  context?: ContextListItem
) => {
  const params: DocumentFormattingParams & { text?: string } = {
    textDocument: {
      uri: `file://${absPath}`,
    },
    options: {
      tabSize: 8,
      insertSpaces: false,
      trimTrailingWhitespace: true,
    },
    text: originalText,
  };

  const newText = (await connection.sendRequest(
    "devicetree/formattingText",
    params
  )) as string | undefined;

  const indent = mainFile ? "" : "\t";

  if (newText && newText !== originalText) {
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
      progressString
    );

    if (diffs.has(absPath)) {
      if (diffs.get(absPath) !== diff && outFile) {
        log(
          "warn",
          "Multiple diffs for the same file. This diff will not be in the generated file!",
          absPath,
          undefined,
          undefined,
          undefined,
          indent,
          progressString
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
      progressString
    );
  }
};

let processedDiagnosticChecks = new Set<string>();
let skippeddDiagnosticChecks = new Set<string>();
const fileDiagnosticIssues = async (
  connection: MessageConnection,
  absPath: string,
  mainFile: boolean,
  progressString: string
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
      (issue.severity === DiagnosticSeverity.Information && showInfoDiagnostics)
  );

  const indent = mainFile ? "" : "\t";

  if (issues.length) {
    issues.forEach((issue, i) =>
      log(
        issue.severity === DiagnosticSeverity.Error
          ? "error"
          : issue.severity === DiagnosticSeverity.Warning
          ? "warn"
          : "warn",
        issue.message,
        onGit ? absPath : i ? "\t" : `${absPath}\n${indent}\t`,
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
        i ? "" : progressString
      )
    );

    return issues;
  } else {
    log(
      "info",
      `No diagnostic errors in ${relative(cwd, absPath)}`,
      undefined,
      undefined,
      undefined,
      undefined,
      indent,
      progressString
    );
  }
};

function waitForNewActiveContext(
  connection: MessageConnection,
  timeoutMs = 60000
): Promise<ContextListItem> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for devicetree/newActiveContext"));
      d.dispose();
    }, timeoutMs);

    const d = connection.onNotification(
      "devicetree/newActiveContext",
      (param: ContextListItem) => {
        clearTimeout(timeout);
        resolve(param);
        d.dispose();
      }
    );
  });
}

function waitForNewContextDeleted(
  connection: MessageConnection,
  timeoutMs = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for devicetree/contextDeleted"));
      d.dispose();
    }, timeoutMs);

    const d = connection.onNotification("devicetree/contextDeleted", () => {
      clearTimeout(timeout);
      resolve();
      d.dispose();
    });
  });
}
