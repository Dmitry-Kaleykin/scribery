#!/usr/bin/env node

import { createRequire } from "node:module";

import { ScriberyTuiApp } from "./app.js";

const packageMetadata = createRequire(import.meta.url)("../package.json") as { version: string };
const arguments_ = process.argv.slice(2);

if (arguments_.includes("--help") || arguments_.includes("-h")) {
    console.log(`Scribery TUI

Usage:
  scribery-tui

Options:
  -h, --help     Show this help
  -v, --version  Show the version

Run inside a source project to select its existing index automatically.`);
} else if (arguments_.includes("--version") || arguments_.includes("-v")) {
    console.log(packageMetadata.version);
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("scribery-tui requires an interactive terminal");
    process.exitCode = 1;
} else {
    try {
        await new ScriberyTuiApp().run();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
