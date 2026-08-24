import {
    LANGUAGE_BY_EXTENSION,
    LANGUAGE_BY_FILENAME,
    SHEBANG_LANGUAGE_RULES,
} from "../constants/languages.js";
import type { LanguageDescriptor } from "../constants/languages.js";
import type {
    ClassificationEvidence,
    ClassificationEvidenceSignal,
} from "../contracts/classification.js";
import type { LanguageSignalResult } from "../contracts/signals.js";
import {
    getClassificationExtension,
    getClassificationFilename,
} from "../utils/path.js";

interface LanguageCandidate extends LanguageDescriptor {
    signal: ClassificationEvidenceSignal;
    confidence: number;
    detail: string;
}

export function classifyLanguage(
    path: string,
    sample: Uint8Array,
): LanguageSignalResult {
    const filename = getClassificationFilename(path);
    const lowercaseFilename = filename.toLowerCase();
    const extension = getClassificationExtension(path);
    const shebang = readShebang(sample);
    const shebangCandidate = findShebangLanguage(shebang);
    const filenameDescriptor = LANGUAGE_BY_FILENAME[lowercaseFilename];
    const extensionDescriptor =
        extension === undefined ? undefined : LANGUAGE_BY_EXTENSION[extension];
    const candidates: LanguageCandidate[] = [];

    if (shebangCandidate !== undefined) {
        candidates.push({
            ...shebangCandidate,
            signal: "shebang",
            confidence: 0.98,
            detail: shebang ?? "recognized shebang",
        });
    }

    if (filenameDescriptor !== undefined) {
        candidates.push({
            ...filenameDescriptor,
            signal: "filename",
            confidence: 0.95,
            detail: filename,
        });
    }

    if (extensionDescriptor !== undefined && extension !== undefined) {
        candidates.push({
            ...extensionDescriptor,
            signal: "extension",
            confidence: 0.85,
            detail: `.${extension}`,
        });
    }

    const selected = candidates[0];
    const evidence: ClassificationEvidence[] = candidates.flatMap(
        candidateEvidence,
    );

    if (selected === undefined) {
        return { evidence };
    }

    return {
        language: selected.language,
        format: selected.format,
        evidence,
    };
}

function readShebang(sample: Uint8Array): string | undefined {
    if (sample[0] !== 0x23 || sample[1] !== 0x21) {
        return undefined;
    }

    const maximumLength = Math.min(sample.byteLength, 256);
    let shebang = "";

    for (let index = 0; index < maximumLength; index += 1) {
        const byte = sample[index];

        if (byte === undefined || byte === 0x0a || byte === 0x0d) {
            break;
        }

        if (byte > 0x7f) {
            return undefined;
        }

        shebang += String.fromCharCode(byte);
    }

    return shebang;
}

function findShebangLanguage(
    shebang: string | undefined,
): LanguageDescriptor | undefined {
    if (shebang === undefined) {
        return undefined;
    }

    const lowercaseShebang = shebang.toLowerCase();

    for (const rule of SHEBANG_LANGUAGE_RULES) {
        if (rule.pattern.test(lowercaseShebang)) {
            return { language: rule.language, format: rule.format };
        }
    }

    return undefined;
}

function candidateEvidence(
    candidate: LanguageCandidate,
): ClassificationEvidence[] {
    return [
        {
            signal: candidate.signal,
            conclusion: { kind: "language", value: candidate.language },
            confidence: candidate.confidence,
            detail: candidate.detail,
        },
        {
            signal: candidate.signal,
            conclusion: { kind: "format", value: candidate.format },
            confidence: candidate.confidence,
            detail: candidate.detail,
        },
    ];
}
