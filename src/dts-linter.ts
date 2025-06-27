#!/usr/bin/env node

import cp, { execFileSync } from "child_process";
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
import { parseArgs } from "node:util"; // Node.js 18+ built-in

const isDebugging = __dirname.endsWith("src");
const serverPath = isDebugging
  ? path.join(__dirname, "..", "dist", "server.js")
  : path.join(__dirname, "server.js");

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

const schema = z.object({
  files: z.array(z.string(), { required_error: "Missing --files" }),
  includes: z.array(z.string()).optional().default([]),
  bindings: z.array(z.string()).optional().default([]),
  logLevel: z.enum(["none", "verbose", "issues"]).optional().default("none"),
  formating: z.boolean().optional().default(false),
  diagnostics: z.boolean().optional().default(false),
  outFile: z.string().optional(),
});

const { values } = parseArgs({
  options: {
    files: { type: "string", multiple: true },
    includes: { type: "string", multiple: true },
    bindings: { type: "string", multiple: true },
    logLevel: { type: "string" },
    formating: { type: "boolean" },
    diagnostics: { type: "boolean" },
    outFile: { type: "string" },
  },
  strict: true,
});

const parsed = schema.safeParse(values);

if (!parsed.success) {
  console.error("❌ Invalid CLI input:\n", parsed.error.format());
  process.exit(1);
}

const argv = parsed.data;

type LogLevel = "none" | "verbose" | "issues";
const files = argv.files;
const dtsIncludes = argv.includes;
const bindings = argv.bindings;
const logLevel = argv.logLevel as LogLevel;
const formating = argv.formating;
const diagnostics = argv.diagnostics;
const outFile = argv.outFile;

run(files, logLevel, dtsIncludes, bindings, outFile).catch((err) => {
  console.error("Error validating files:", err);
  process.exit(1);
});

let i = 0;
let total = files.length;

async function run(
  filePaths: string[],
  logLevel: LogLevel,
  includesPaths: string[],
  Bindings: string[],
  outFile?: string
) {
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
      console.log(`[LSP ${level}] ${params.message}`);
    });
  }

  connection.onRequest("workspace/workspaceFolders", () => {
    // Return workspace folders your client is aware of
    return [
      {
        uri: `file://${process.cwd()}`,
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
        autoChangeContext: true,
        allowAdhocContexts: true,
        defaultLockRenameEdits: [],
      },
    },
  });

  const workspaceFolders = [{ uri: toFileUri(process.cwd()), name: "root" }];

  await connection.sendRequest("initialize", {
    processId: process.pid,
    rootUri: `file://${process.cwd()}`,
    capabilities: {},
    workspaceFolders,
  });

  await connection.sendNotification("initialized");

  const completedPaths = new Set<string>();
  const diffs: string[] = [];
  const paths = Array.from(new Set(filePaths)).sort((a, b) => {
    const getPriority = (file: string): number => {
      if (file.endsWith(".dts")) return 0;
      if (file.endsWith(".dtsi")) return 1;

      return 2;
    };

    return getPriority(a) - getPriority(b);
  });
  let formatingErrors: { file: string; context: ContextListItem }[] = [];
  let diagnosticIssues: {
    file: string;
    message: string;
    context: ContextListItem;
  }[] = [];

  for (const filePath of paths) {
    i++;
    const text = fs.readFileSync(filePath, "utf8");

    const textDocument: TextDocumentItem = {
      uri: `file://${filePath}`,
      languageId: "devicetree",
      version: 0,
      text,
    };

    connection.sendNotification("textDocument/didOpen", {
      textDocument,
    });

    const context = await waitForNewActiveContext(connection);
    const files = filePath.endsWith(".overlay")
      ? [context.mainDtsPath.file]
      : [
          ...flatFileTree(context.mainDtsPath),
          ...context.overlays.flatMap(flatFileTree),
        ];

    await Promise.all(
      files.map(async (f) => {
        if (completedPaths.has(f) || f.endsWith(".h") || !existsSync(f)) {
          return;
        }

        if (formating) {
          const diff = await formatFile(connection, f);
          completedPaths.add(f);
          if (diff) {
            formatingErrors.push({
              file: f,
              context,
            });
            if (outFile) {
              diffs.push(diff);
            }
          }
        }

        if (diagnostics && !filePath.endsWith(".overlay")) {
          const issues = await fileDiagnosticIssues(connection, f);
          if (issues?.length) {
            diagnosticIssues.push({
              file: f,
              context,
              message: issues
                .map(
                  (issue) =>
                    `${issue.message}: {${JSON.stringify(
                      issue.range.start
                    )}}-{${JSON.stringify(issue.range.end)}}`
                )
                .join("\n\t\t"),
            });
          }
        }
      })
    );

    connection.sendNotification("textDocument/didClose", {
      textDocument: {
        uri: `file://${filePath}`,
      },
    });

    await waitForNewContextDeleted(connection);
  }

  if (outFile) {
    fs.writeFileSync(outFile, diffs.join("\n\n"));
  }

  console.log("Processed", completedPaths.size, "files");
  connection.dispose();
  lspProcess.kill();

  if (formatingErrors.length)
    console.log(
      `${formatingErrors.length} of ${completedPaths.size} Failed formating checks`
    );
  else console.log(`All files passed formating`);

  if (diagnosticIssues.length) {
    console.log("Diagnostic issues summary");
    console.log(
      diagnosticIssues
        .map(
          (issue) =>
            `File: ${issue.file}\n\tBoard File: ${issue.context.mainDtsPath.file}\n\tIssues:\n\t\t${issue.message}`
        )
        .join("\n")
    );
    console.log(
      `${diagnosticIssues.length} of ${completedPaths.size} Failed diagnostic checks`
    );
  } else console.log(`All files passed diagnostic checks`);

  process.exit(formatingErrors.length || diagnosticIssues ? 1 : 0);
}

const flatFileTree = (file: File): string[] => {
  return [file.file, ...file.includes.flatMap((f) => flatFileTree(f))];
};

const formatFile = async (connection: MessageConnection, absPath: string) => {
  const params: DocumentFormattingParams = {
    textDocument: {
      uri: `file://${absPath}`,
    },
    options: {
      tabSize: 4,
      insertSpaces: false,
      trimTrailingWhitespace: true,
    },
  };

  const diff = (await connection.sendRequest(
    "devicetree/formatingDiff",
    params
  )) as string | undefined;

  if (diff) {
    console.error(`[${i}/${total}] ❌ ${absPath}`);

    if (logLevel !== "none") {
      console.log(diff);
    }
    return diff;
  } else {
    console.log(`[${i}/${total}] ✅ ${absPath} is correctly formatted.`);
  }
};

const fileDiagnosticIssues = async (
  connection: MessageConnection,
  absPath: string
) => {
  const issues = (
    ((await connection.sendRequest("devicetree/diagnosticIssues", {
      uri: `file://${absPath}`,
    })) as Diagnostic[] | undefined) ?? []
  ).filter(
    (issue) =>
      issue.severity === DiagnosticSeverity.Error ||
      issue.severity === DiagnosticSeverity.Warning
  );

  if (issues.length) {
    console.error(
      `[${i}/${total}] ❌ ${absPath} has ${issues.length} diagnostic errors!`
    );

    if (logLevel !== "none") {
      console.log(
        issues.map(
          (issue) =>
            `${issue.message}: ${JSON.stringify(
              issue.range.start
            )}${JSON.stringify(issue.range.end)}`
        )
      );
    }

    return issues;
  } else {
    console.log(`[${i}/${total}] ✅ ${absPath} has no diagnostic errors.`);
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
