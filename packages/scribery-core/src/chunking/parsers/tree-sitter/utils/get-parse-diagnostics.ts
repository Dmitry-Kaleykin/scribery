import type { Node as TreeSitterNode } from "@vscode/tree-sitter-wasm";

import { throwIfChunkingAborted } from "../../../utils/throw-if-aborted.js";
import { MAX_TREE_SITTER_DIAGNOSTICS } from "../constants/runtime.js";

export interface TreeSitterParseDiagnostic {
    kind: "error" | "missing";
    nodeType: string;
    startOffset: number;
    endOffset: number;
}

export function getTreeSitterParseDiagnostics(
    rootNode: TreeSitterNode,
    path: string,
    signal?: AbortSignal,
): readonly TreeSitterParseDiagnostic[] {
    const diagnostics: TreeSitterParseDiagnostic[] = [];
    const pending = [rootNode];

    while (
        pending.length > 0 &&
        diagnostics.length < MAX_TREE_SITTER_DIAGNOSTICS
    ) {
        throwIfChunkingAborted(signal, path);

        const node = pending.pop();

        if (node === undefined) {
            break;
        }

        if (node.isError || node.isMissing) {
            diagnostics.push({
                kind: node.isMissing ? "missing" : "error",
                nodeType: node.type,
                startOffset: node.startIndex,
                endOffset: node.endIndex,
            });
        }

        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            const child = node.children[index];

            if (child !== null && child !== undefined) {
                pending.push(child);
            }
        }
    }

    if (diagnostics.length === 0 && rootNode.hasError) {
        diagnostics.push({
            kind: "error",
            nodeType: rootNode.type,
            startOffset: rootNode.startIndex,
            endOffset: rootNode.endIndex,
        });
    }

    return diagnostics;
}
