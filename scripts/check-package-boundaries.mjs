import { readdir, readFile } from "node:fs/promises";
import { extname, relative } from "node:path";

const workspaceRoot = new URL("../", import.meta.url);
const rules = [
    {
        directory: "packages/scribery-core/src",
        forbidden: ["scribery-code", "scribery-documents", "scribery"],
    },
    {
        directory: "packages/scribery-code/src",
        forbidden: ["scribery-documents", "scribery"],
    },
    {
        directory: "packages/scribery-documents/src",
        forbidden: ["scribery-code", "scribery"],
    },
];
const failures = [];
const coreOrchestrationFiles = [
    "packages/scribery-core/src/indexing/build-engine.ts",
    "packages/scribery-core/src/indexing/documents/document-processor.ts",
];
const forbiddenCoreCompositions = [
    "CastChunkingStrategy",
    "SlidingWindowChunkingStrategy",
    "DefaultFileClassifier",
    "DefaultDocumentDecoder",
    "createInitialParserRegistry",
];

for (const rule of rules) {
    const root = new URL(`${rule.directory}/`, workspaceRoot);
    for (const file of await sourceFiles(root)) {
        const source = await readFile(file, "utf8");
        for (const dependency of rule.forbidden) {
            const pattern = new RegExp(
                `(?:from\\s+|import\\s*\\()(["'])${dependency}\\1`,
                "u",
            );
            if (pattern.test(source)) {
                failures.push(
                    `${relative(workspaceRoot.pathname, file.pathname)} imports ${dependency}`,
                );
            }
        }
    }
}

for (const relativePath of coreOrchestrationFiles) {
    const file = new URL(relativePath, workspaceRoot);
    const source = await readFile(file, "utf8");
    for (const composition of forbiddenCoreCompositions) {
        if (source.includes(composition)) {
            failures.push(
                `${relativePath} composes concrete runtime capability ${composition}`,
            );
        }
    }
}

if (failures.length > 0) {
    throw new Error(`Package boundary violations:\n${failures.join("\n")}`);
}

async function sourceFiles(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
        if (entry.isDirectory()) {
            result.push(...await sourceFiles(child));
        } else if (extname(entry.name) === ".ts") {
            result.push(child);
        }
    }
    return result;
}
