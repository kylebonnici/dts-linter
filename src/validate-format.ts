import cp from "child_process";
import { createPatch } from "diff";
import fs from "fs";
import path from "path";
import { createMessageConnection, MessageConnection } from "vscode-jsonrpc";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import {
  TextDocumentItem,
  DocumentFormattingParams,
  TextEdit,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";

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

async function run(filePaths: string[]) {
  const lspPath = "devicetree-language-server";

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

  let hasIssues = false;

  const diffs: string[] = [];
  for (const filePath of filePaths) {
    const absPath = path.resolve(filePath);
    const text = fs.readFileSync(absPath, "utf8");

    const textDocument: TextDocumentItem = {
      uri: `file://${absPath}`,
      languageId: "devicetree",
      version: 0,
      text,
    };

    connection.sendNotification("textDocument/didOpen", {
      textDocument,
    });
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

    await waitForNewActiveContext(connection);

    const edits = (await connection.sendRequest(
      "textDocument/formatting",
      params
    )) as TextEdit[];
    const newText = applyEdits(
      TextDocument.create(`file://${absPath}`, "devicetree", 0, text),
      edits
    );

    connection.sendNotification("textDocument/didClose", {
      textDocument: {
        uri: `file://${absPath}`,
      },
    });

    await waitForNewContextDeletedt(connection);

    const result = createPatch(`file://${absPath}`, text, newText);
    if (newText !== text) {
      console.error(`❌ Formatting issues in: ${filePath}`);
      hasIssues = true;
      console.log(result);
      diffs.push(result);
    } else {
      console.log(`✅ ${filePath} is correctly formatted.`);
    }
  }

  fs.writeFileSync(
    "/Users/kylebonnici/workspace/personal/linter/diff",
    diffs.join("\n\n")
  );

  console.log("Processed ", filePaths.length, "files");
  connection.dispose();
  lspProcess.kill();

  if (hasIssues) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Get CLI args
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: ts-node validate-format.ts <file1> [file2] ...");
  process.exit(1);
}

run(args).catch((err) => {
  console.error("Error validating files:", err);
  process.exit(1);
});

export function applyEdits(document: TextDocument, edits: TextEdit[]): string {
  const text = document.getText();

  // Enhanced sorting logic:
  const sorted = edits.slice().sort((a, b) => {
    const aStart = document.offsetAt(a.range.start);
    const bStart = document.offsetAt(b.range.start);

    if (aStart !== bStart) {
      return bStart - aStart; // reverse order
    }

    // If same start offset, sort by end offset descending (longer edits first)
    const aEnd = document.offsetAt(a.range.end);
    const bEnd = document.offsetAt(b.range.end);
    if (aEnd !== bEnd) {
      return bEnd - aEnd;
    }

    // Optionally: insertions before deletions (if newText is empty or not)
    const aIsInsertion = aStart === aEnd && a.newText.length > 0;
    const bIsInsertion = bStart === bEnd && b.newText.length > 0;
    if (aIsInsertion !== bIsInsertion) {
      return aIsInsertion ? 1 : -1; // insertions later
    }

    return 0; // stable
  });

  let result = text;
  for (const edit of sorted) {
    const start = document.offsetAt(edit.range.start);
    const end = document.offsetAt(edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }

  return result;
}

function waitForNewActiveContext(
  connection: MessageConnection,
  timeoutMs = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for devicetree/newActiveContext"));
      d.dispose();
    }, timeoutMs);

    const d = connection.onNotification("devicetree/newActiveContext", () => {
      clearTimeout(timeout);
      resolve();
      d.dispose();
    });
  });
}

function waitForNewContextDeletedt(
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
