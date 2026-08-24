import { DEFAULT_MAX_BYTE_LENGTH } from "./constants/limits.js";
import type {
    DecodedDocument,
    DecodingDiagnostic,
    DecodingInput,
    DecodingOptions,
    DocumentDecoder,
} from "./contracts/decoder.js";
import type {
    EncodingSelectionSource,
    SupportedEncoding,
} from "../shared/contracts/encoding.js";
import { ENCODING } from "../shared/constants/encoding.js";
import { normalizeEncodingLabel } from "../shared/utils/normalize-encoding-label.js";
import { decodeUtf8, hasUtf8ByteOrderMark } from "./decoders/utf-8.js";
import { decodeWindows1251 } from "./decoders/windows-1251.js";
import { DecodingError } from "./errors/decoding-error.js";
import { collectBytes } from "./utils/collect-bytes.js";
import { throwIfAborted } from "./utils/throw-if-aborted.js";

interface DecodedContent {
    content: string;
    encoding: SupportedEncoding;
    source: EncodingSelectionSource;
}

export class DefaultDocumentDecoder implements DocumentDecoder {
    async decode(
        input: DecodingInput,
        options: DecodingOptions = {},
    ): Promise<DecodedDocument> {
        const maxByteLength = options.maxByteLength ?? DEFAULT_MAX_BYTE_LENGTH;
        validateMaxByteLength(input.path, maxByteLength);
        throwIfAborted(input.path, options.signal);

        const encodingOverride = resolveEncodingLabel(
            input.path,
            "override",
            input.encodingSelection.override,
        );
        const fallbackEncoding = resolveEncodingLabel(
            input.path,
            "fallback",
            input.encodingSelection.fallback,
        );

        if (
            fallbackEncoding !== undefined &&
            fallbackEncoding !== ENCODING.WINDOWS_1251
        ) {
            throw new DecodingError(
                "unsupported-encoding",
                `Encoding fallback ${fallbackEncoding} is not supported for ${input.path}`,
                { path: input.path, encoding: fallbackEncoding },
            );
        }

        const bytes = await collectBytes(
            input.path,
            input.bytes,
            maxByteLength,
            options.signal,
        );
        const decoded = decodeSelectedContent(
            input.path,
            bytes,
            encodingOverride,
            fallbackEncoding,
        );

        throwIfAborted(input.path, options.signal);

        const diagnostic: DecodingDiagnostic = {
            code: "encoding-selected",
            encoding: decoded.encoding,
            source: decoded.source,
        };

        return {
            content: decoded.content,
            encoding: decoded.encoding,
            byteLength: bytes.byteLength,
            diagnostics: [diagnostic],
        };
    }
}

function validateMaxByteLength(path: string, maxByteLength: number): void {
    if (!Number.isSafeInteger(maxByteLength) || maxByteLength < 0) {
        throw new DecodingError(
            "invalid-options",
            `The maximum byte length for ${path} must be a non-negative safe integer`,
            { path: path },
        );
    }
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
        throw new DecodingError(
            "unsupported-encoding",
            `Unsupported encoding ${role} ${JSON.stringify(label)} for ${path}`,
            { path },
        );
    }

    return encoding;
}

function decodeSelectedContent(
    path: string,
    bytes: Uint8Array,
    encodingOverride: SupportedEncoding | undefined,
    fallbackEncoding: SupportedEncoding | undefined,
): DecodedContent {
    if (encodingOverride !== undefined) {
        return decodeWithEncoding(path, bytes, encodingOverride, "override");
    }

    if (hasUtf8ByteOrderMark(bytes)) {
        return decodeWithEncoding(
            path,
            bytes,
            ENCODING.UTF_8,
            "byte-order-mark",
        );
    }

    try {
        return {
            content: decodeUtf8(bytes),
            encoding: ENCODING.UTF_8,
            source: "utf-8-validation",
        };
    } catch (error: unknown) {
        if (fallbackEncoding === ENCODING.WINDOWS_1251) {
            return decodeWithEncoding(
                path,
                bytes,
                ENCODING.WINDOWS_1251,
                "fallback",
            );
        }

        throw new DecodingError(
            "unsupported-encoding",
            `Unable to select a supported encoding for ${path}`,
            { path, byteLength: bytes.byteLength, cause: error },
        );
    }
}

function decodeWithEncoding(
    path: string,
    bytes: Uint8Array,
    encoding: SupportedEncoding,
    source: EncodingSelectionSource,
): DecodedContent {
    try {
        const content =
            encoding === ENCODING.UTF_8
                ? decodeUtf8(bytes)
                : decodeWindows1251(bytes);

        return { content, encoding, source };
    } catch (error: unknown) {
        throw new DecodingError(
            "malformed-input",
            `Malformed ${encoding} input in ${path}`,
            { path, encoding, byteLength: bytes.byteLength, cause: error },
        );
    }
}
