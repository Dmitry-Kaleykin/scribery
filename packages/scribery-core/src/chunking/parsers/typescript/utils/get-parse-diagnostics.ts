import type ts from "@typescript/typescript6";

interface ParsedSourceFile extends ts.SourceFile {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
}

export function getParseDiagnostics(
    sourceFile: ts.SourceFile,
): readonly ts.Diagnostic[] {
    const diagnostics = (sourceFile as ParsedSourceFile).parseDiagnostics;

    if (!Array.isArray(diagnostics)) {
        throw new Error(
            "The configured TypeScript compiler does not expose parse diagnostics",
        );
    }

    return diagnostics;
}
