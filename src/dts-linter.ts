#!/usr/bin/env node

import cp from "child_process";
import { ContextListItem, File } from "devicetree-language-server-types";
import { createPatch } from "diff";
import fs, { existsSync } from "fs";
import path, { basename } from "path";
import { fileURLToPath } from "url";
import { createMessageConnection, MessageConnection } from "vscode-jsonrpc";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import {
  TextDocumentItem,
  DocumentFormattingParams,
  TextEdit,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

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

const argv = yargs(hideBin(process.argv))
  .option("files", {
    type: "array",
    describe: "List of files to format",
    demandOption: true,
  })
  .option("logLevel", {
    type: "string",
    choices: ["none", "verbose", "diff"],
    default: "none",
    describe: "Log level for output",
  })
  .option("outFile", {
    type: "string",
    describe: "Path for diff file",
  })
  .strict()
  .help()
  .parseSync();

type LogLevel = "none" | "verbose" | "diff";
const files = argv.files as string[];
const logLevel = argv.logLevel as LogLevel;
const outFile: string | undefined = argv.outFile;

run(files, logLevel, outFile).catch((err) => {
  console.error("Error validating files:", err);
  process.exit(1);
});

async function run(filePaths: string[], logLevel: LogLevel, outFile?: string) {
  const lspPath = "./dist/server.js";

  const lspProcess = cp.spawn(lspPath, ["--stdio"], {
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
        defaultIncludePaths: [],
        defaultBindingType: "Zephyr",
        defaultZephyrBindings: [],
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
  const paths = new Set(filePaths);
  let error = 0;
  for (const filePath of paths) {
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
    const files = [
      ...flatFileTree(context.mainDtsPath),
      ...context.overlays.flatMap(flatFileTree),
    ];

    await Promise.all(
      files.map(async (f) => {
        if (!paths.has(f) || completedPaths.has(f)) {
          return;
        }

        const diff = await formatFile(connection, f);
        completedPaths.add(f);
        if (diff) {
          error++;
          if (outFile) {
            diffs.push(diff);
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

  console.log("Processed ", filePaths.length, "files");
  connection.dispose();
  lspProcess.kill();

  if (error) {
    console.log(`${error} of ${filePaths.length} Failed`);
    process.exit(1);
  } else {
    console.log("All files passed");
    process.exit(0);
  }
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
    console.error(`❌ ${absPath}`);

    if (logLevel !== "none") {
      console.log(diff);
    }
    return diff;
  } else {
    console.log(`✅ ${absPath} is correctly formatted.`);
  }
};

function waitForNewActiveContext(
  connection: MessageConnection,
  timeoutMs = 5000
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
