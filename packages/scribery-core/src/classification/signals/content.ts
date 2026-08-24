import { TextDecoder } from "node:util";

import { CONTENT_KIND } from "../constants/classification.js";
import { BINARY_FILE_SIGNATURES } from "../constants/file-signatures.js";
import type {
    ClassificationEvidence,
    ClassificationInput,
    ContentKind,
} from "../contracts/classification.js";
import type { ContentSignalResult } from "../contracts/signals.js";
import { ClassificationError } from "../errors/classification-error.js";
import { ENCODING, UTF_8_BYTE_ORDER_MARK } from "../../shared/constants/encoding.js";
import type {
    EncodingSelectionSource,
    SupportedEncoding,
} from "../../shared/contracts/encoding.js";
import { normalizeEncodingLabel } from "../../shared/utils/normalize-encoding-label.js";

interface DecodedSampleClassification {
    contentKind: ContentKind;
    confidence: number;
}

export function classifyContent(input: ClassificationInput): ContentSignalResult {
    const encodingOverride = resolveEncodingLabel(
        input.path,
        "override",
        input.encodingSelection?.override,
    );
    const fallbackEncoding = resolveEncodingLabel(
        input.path,
        "fallback",
        input.encodingSelection?.fallback,
    );

    if (
        fallbackEncoding !== undefined &&
        fallbackEncoding !== ENCODING.WINDOWS_1251
    ) {
        throw new ClassificationError(
            "unsupported-encoding",
            `Encoding fallback ${fallbackEncoding} is not supported for ${input.path}`,
            { path: input.path },
        );
    }

    const binarySignature = findBinarySignature(input.sample);

    if (binarySignature !== undefined) {
        return contentResult(
            CONTENT_KIND.BINARY,
            1,
            undefined,
            undefined,
            [
                evidence(
                    "byte-sample",
                    { kind: "content-kind", value: CONTENT_KIND.BINARY },
                    1,
                    `recognized ${binarySignature} signature`,
                ),
            ],
        );
    }

    if (input.sample.includes(0)) {
        return contentResult(
            CONTENT_KIND.BINARY,
            0.99,
            undefined,
            undefined,
            [
                evidence(
                    "byte-sample",
                    { kind: "content-kind", value: CONTENT_KIND.BINARY },
                    0.99,
                    "sample contains a NUL byte",
                ),
            ],
        );
    }

    if (input.byteLength === 0) {
        const encoding = encodingOverride ?? ENCODING.UTF_8;
        const source = encodingOverride === undefined ? "byte-sample" : "configuration";
        const sourceDetail =
            encodingOverride === undefined ? "empty input is valid UTF-8" : "explicit override";

        return contentResult(CONTENT_KIND.TEXT, 1, encoding, "", [
            evidence(
                source,
                { kind: "encoding", value: encoding },
                1,
                sourceDetail,
            ),
            evidence(
                "byte-sample",
                { kind: "content-kind", value: CONTENT_KIND.TEXT },
                1,
                "file is empty",
            ),
        ]);
    }

    if (input.sample.byteLength === 0) {
        const evidenceItems: ClassificationEvidence[] = [];

        if (encodingOverride !== undefined) {
            evidenceItems.push(
                encodingEvidence(encodingOverride, "override", 1),
            );
        }

        evidenceItems.push(
            evidence(
                "byte-sample",
                { kind: "content-kind", value: CONTENT_KIND.UNKNOWN },
                0.2,
                "no sample bytes are available",
            ),
        );

        return contentResult(
            CONTENT_KIND.UNKNOWN,
            0.2,
            encodingOverride,
            undefined,
            evidenceItems,
        );
    }

    if (encodingOverride !== undefined) {
        return classifyWithEncoding(input, encodingOverride, "override", 0.99);
    }

    if (hasUtf8ByteOrderMark(input.sample)) {
        return classifyWithEncoding(
            input,
            ENCODING.UTF_8,
            "byte-order-mark",
            1,
        );
    }

    try {
        return classifyWithEncoding(
            input,
            ENCODING.UTF_8,
            "utf-8-validation",
            0.98,
        );
    } catch (error: unknown) {
        if (!(error instanceof TypeError)) {
            throw error;
        }

        if (fallbackEncoding === ENCODING.WINDOWS_1251) {
            return classifyWithEncoding(
                input,
                ENCODING.WINDOWS_1251,
                "fallback",
                0.85,
            );
        }

        const rawControlRatio = calculateRawControlRatio(input.sample);
        const contentKind =
            rawControlRatio >= 0.3 ? CONTENT_KIND.BINARY : CONTENT_KIND.UNKNOWN;
        const confidence = contentKind === CONTENT_KIND.BINARY ? 0.9 : 0.5;

        return contentResult(contentKind, confidence, undefined, undefined, [
            evidence(
                "byte-sample",
                { kind: "content-kind", value: contentKind },
                confidence,
                `sample is invalid UTF-8; control-byte ratio ${formatRatio(rawControlRatio)}`,
            ),
        ]);
    }
}

function classifyWithEncoding(
    input: ClassificationInput,
    encoding: SupportedEncoding,
    source: EncodingSelectionSource,
    encodingConfidence: number,
): ContentSignalResult {
    let decodedSample: string;

    try {
        decodedSample = decodeSample(input, encoding);
    } catch (error: unknown) {
        if (source === "utf-8-validation") {
            throw error;
        }

        return contentResult(
            CONTENT_KIND.UNKNOWN,
            0.9,
            encoding,
            undefined,
            [
                encodingEvidence(encoding, source, encodingConfidence),
                evidence(
                    "byte-sample",
                    { kind: "content-kind", value: CONTENT_KIND.UNKNOWN },
                    0.9,
                    `sample is malformed ${encoding}`,
                ),
            ],
        );
    }

    const decodedClassification = classifyDecodedSample(decodedSample);

    return contentResult(
        decodedClassification.contentKind,
        Math.min(decodedClassification.confidence, encodingConfidence),
        encoding,
        decodedSample,
        [
            encodingEvidence(encoding, source, encodingConfidence),
            evidence(
                "byte-sample",
                {
                    kind: "content-kind",
                    value: decodedClassification.contentKind,
                },
                decodedClassification.confidence,
                `decoded control-character ratio ${formatRatio(
                    calculateDecodedControlRatio(decodedSample),
                )}`,
            ),
        ],
    );
}

function decodeSample(
    input: ClassificationInput,
    encoding: SupportedEncoding,
): string {
    const isCompleteSample = input.sample.byteLength === input.byteLength;
    const bytes =
        encoding === ENCODING.UTF_8 && hasUtf8ByteOrderMark(input.sample)
            ? input.sample.subarray(UTF_8_BYTE_ORDER_MARK.byteLength)
            : input.sample;
    const decoder = new TextDecoder(encoding, { fatal: true });

    return decoder.decode(bytes, { stream: !isCompleteSample });
}

function classifyDecodedSample(content: string): DecodedSampleClassification {
    if (content.length === 0) {
        return { contentKind: CONTENT_KIND.UNKNOWN, confidence: 0.5 };
    }

    const controlRatio = calculateDecodedControlRatio(content);

    if (controlRatio <= 0.02) {
        return { contentKind: CONTENT_KIND.TEXT, confidence: 0.98 };
    }

    if (controlRatio >= 0.3) {
        return { contentKind: CONTENT_KIND.BINARY, confidence: 0.9 };
    }

    return { contentKind: CONTENT_KIND.UNKNOWN, confidence: 0.55 };
}

function calculateDecodedControlRatio(content: string): number {
    let characterCount = 0;
    let controlCount = 0;

    for (const character of content) {
        characterCount += 1;
        const codePoint = character.codePointAt(0) ?? 0;

        if (isDisallowedControl(codePoint)) {
            controlCount += 1;
        }
    }

    return characterCount === 0 ? 0 : controlCount / characterCount;
}

function calculateRawControlRatio(bytes: Uint8Array): number {
    let controlCount = 0;

    for (const byte of bytes) {
        if (isDisallowedControl(byte)) {
            controlCount += 1;
        }
    }

    return bytes.byteLength === 0 ? 0 : controlCount / bytes.byteLength;
}

function isDisallowedControl(value: number): boolean {
    const isAllowedWhitespace =
        value === 0x09 || value === 0x0a || value === 0x0c || value === 0x0d;

    return (
        !isAllowedWhitespace &&
        (value < 0x20 || (value >= 0x7f && value <= 0x9f))
    );
}

function findBinarySignature(sample: Uint8Array): string | undefined {
    for (const signature of BINARY_FILE_SIGNATURES) {
        if (
            sample.byteLength >= signature.bytes.length &&
            signature.bytes.every((byte, index) => sample[index] === byte)
        ) {
            return signature.name;
        }
    }

    return undefined;
}

function hasUtf8ByteOrderMark(bytes: Uint8Array): boolean {
    return (
        bytes.byteLength >= UTF_8_BYTE_ORDER_MARK.byteLength &&
        bytes[0] === UTF_8_BYTE_ORDER_MARK[0] &&
        bytes[1] === UTF_8_BYTE_ORDER_MARK[1] &&
        bytes[2] === UTF_8_BYTE_ORDER_MARK[2]
    );
}

function resolveEncodingLabel(
    path: string,
    role: "override" | "fallback",
    label: string | undefined,
): SupportedEncoding | undefined {
    if (label === undefined) {
        return undefined;
    }

    const encoding = normalizeEncodingLabel(label);

    if (encoding === undefined) {
        throw new ClassificationError(
            "unsupported-encoding",
            `Unsupported encoding ${role} ${JSON.stringify(label)} for ${path}`,
            { path },
        );
    }

    return encoding;
}

function encodingEvidence(
    encoding: SupportedEncoding,
    source: EncodingSelectionSource,
    confidence: number,
): ClassificationEvidence {
    const signal =
        source === "override"
            ? "configuration"
            : source === "byte-order-mark"
              ? "byte-order-mark"
              : "byte-sample";

    return evidence(
        signal,
        { kind: "encoding", value: encoding },
        confidence,
        source,
    );
}

function contentResult(
    contentKind: ContentKind,
    confidence: number,
    encoding: SupportedEncoding | undefined,
    decodedSample: string | undefined,
    evidenceItems: ClassificationEvidence[],
): ContentSignalResult {
    return {
        contentKind,
        confidence,
        evidence: evidenceItems,
        ...(encoding === undefined ? {} : { encoding }),
        ...(decodedSample === undefined ? {} : { decodedSample }),
    };
}

function evidence(
    signal: ClassificationEvidence["signal"],
    conclusion: ClassificationEvidence["conclusion"],
    confidence: number,
    detail: string,
): ClassificationEvidence {
    return { signal, conclusion, confidence, detail };
}

function formatRatio(value: number): string {
    return value.toFixed(3);
}
