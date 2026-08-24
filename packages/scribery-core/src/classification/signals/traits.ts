import {
    FILE_TRAIT,
    FILE_TRAIT_ORDER,
} from "../constants/classification.js";
import type {
    ClassificationEvidence,
    ClassificationEvidenceSignal,
    FileTrait,
} from "../contracts/classification.js";
import type { TraitSignalResult } from "../contracts/signals.js";
import {
    getClassificationExtension,
    getClassificationFilename,
    normalizeClassificationPath,
} from "../utils/path.js";

const LOCKFILE_NAMES = new Set([
    "cargo.lock",
    "composer.lock",
    "gemfile.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "yarn.lock",
]);

const CONFIGURATION_EXTENSIONS = new Set([
    "conf",
    "config",
    "ini",
    "toml",
    "yaml",
    "yml",
]);
const CONFIGURATION_FILENAMES = new Set([
    "composer.json",
    "package.json",
    "package-lock.json",
]);

const DOCUMENTATION_EXTENSIONS = new Set(["adoc", "md", "markdown", "rst"]);
const DECLARATION_EXTENSIONS = new Set(["h", "hpp", "pyi"]);

interface TraitEvidenceSource {
    signal: ClassificationEvidenceSignal;
    detail: string;
    confidence: number;
}

export function classifyTraits(
    path: string,
    byteLength: number,
    decodedSample: string | undefined,
): TraitSignalResult {
    const normalizedPath = normalizeClassificationPath(path).toLowerCase();
    const filename = getClassificationFilename(normalizedPath);
    const extension = getClassificationExtension(normalizedPath);
    const evidenceByTrait = new Map<FileTrait, TraitEvidenceSource>();
    const addTrait = (
        trait: FileTrait,
        source: TraitEvidenceSource,
    ): void => {
        if (!evidenceByTrait.has(trait)) {
            evidenceByTrait.set(trait, source);
        }
    };

    if (byteLength === 0) {
        addTrait(FILE_TRAIT.EMPTY, {
            signal: "byte-sample",
            detail: "file has zero bytes",
            confidence: 1,
        });
    }

    if (LOCKFILE_NAMES.has(filename)) {
        addTrait(FILE_TRAIT.LOCKFILE, {
            signal: "filename",
            detail: filename,
            confidence: 1,
        });
    }

    if (
        filename.startsWith(".env") ||
        filename === ".editorconfig" ||
        CONFIGURATION_FILENAMES.has(filename) ||
        /^(?:jsconfig|tsconfig)(?:\.[^.]+)?\.json$/u.test(filename) ||
        (extension !== undefined && CONFIGURATION_EXTENSIONS.has(extension))
    ) {
        addTrait(FILE_TRAIT.CONFIGURATION, {
            signal: filename.startsWith(".") ? "filename" : "extension",
            detail: filename,
            confidence: 0.95,
        });
    }

    if (
        /^(?:readme|changelog|license|contributing|authors)(?:\.|$)/.test(filename) ||
        (extension !== undefined && DOCUMENTATION_EXTENSIONS.has(extension))
    ) {
        addTrait(FILE_TRAIT.DOCUMENTATION, {
            signal: /^(?:readme|changelog|license|contributing|authors)(?:\.|$)/.test(
                filename,
            )
                ? "filename"
                : "extension",
            detail: filename,
            confidence: 0.95,
        });
    }

    if (
        /(^|\/)(?:__tests__|tests?|specs?)(\/|$)/.test(normalizedPath) ||
        /(?:^|\.)(?:test|spec)\.[^.]+$/.test(filename) ||
        /_test\.go$/.test(filename) ||
        /^test_.*\.py$/.test(filename)
    ) {
        addTrait(FILE_TRAIT.TEST, {
            signal: "path",
            detail: normalizedPath,
            confidence: 0.95,
        });
    }

    if (
        /\.d\.(?:ts|mts|cts)$/.test(filename) ||
        (extension !== undefined && DECLARATION_EXTENSIONS.has(extension))
    ) {
        addTrait(FILE_TRAIT.DECLARATION, {
            signal: "filename",
            detail: filename,
            confidence: 0.95,
        });
    }

    if (
        /(^|\/)(?:dist|build|generated|gen)(\/|$)/.test(normalizedPath) ||
        /(?:\.generated\.|\.g\.|\.designer\.)/.test(filename) ||
        (decodedSample !== undefined &&
            /(?:@generated|generated code|do not edit)/i.test(decodedSample))
    ) {
        addTrait(FILE_TRAIT.GENERATED, {
            signal:
                decodedSample !== undefined &&
                /(?:@generated|generated code|do not edit)/i.test(decodedSample)
                    ? "byte-sample"
                    : "path",
            detail: normalizedPath,
            confidence: 0.95,
        });
    }

    if (
        /\.min\.(?:css|js|mjs|cjs)$/.test(filename) ||
        isProbablyMinified(decodedSample)
    ) {
        addTrait(FILE_TRAIT.MINIFIED, {
            signal: /\.min\.(?:css|js|mjs|cjs)$/.test(filename)
                ? "filename"
                : "byte-sample",
            detail: filename,
            confidence: 0.9,
        });
    }

    const traits = FILE_TRAIT_ORDER.filter((trait) => evidenceByTrait.has(trait));
    const evidence: ClassificationEvidence[] = traits.map((trait) => {
        const source = evidenceByTrait.get(trait);

        if (source === undefined) {
            throw new Error(`Missing evidence for trait ${trait}`);
        }

        return {
            signal: source.signal,
            conclusion: { kind: "trait", value: trait },
            confidence: source.confidence,
            detail: source.detail,
        };
    });

    return { traits, evidence };
}

function isProbablyMinified(content: string | undefined): boolean {
    if (content === undefined || content.length < 500) {
        return false;
    }

    const lines = content.split(/\r?\n/);
    let longestLine = 0;
    let whitespaceCount = 0;

    for (const line of lines) {
        longestLine = Math.max(longestLine, line.length);
    }

    for (const character of content) {
        if (/\s/.test(character)) {
            whitespaceCount += 1;
        }
    }

    return longestLine >= 500 && whitespaceCount / content.length < 0.1;
}
