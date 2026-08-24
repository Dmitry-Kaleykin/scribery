#!/usr/bin/env node

import { createRequire } from "node:module";

import { runScriberyMcpServer } from "./mcp/index.js";
import { serializeError } from "scribery-core";

const packageMetadata = createRequire(import.meta.url)("../package.json") as {
    version: string;
};

try {
    await runScriberyMcpServer(process.argv.slice(2), packageMetadata.version);
} catch (error: unknown) {
    const failure = serializeError(error);
    console.error(JSON.stringify({
        error: failure.code ?? "mcp-server-failed",
        message: failure.message,
        ...(failure.details === undefined ? {} : { details: failure.details }),
        ...(failure.cause === undefined ? {} : { cause: failure.cause }),
    }));
    process.exitCode = 1;
}
