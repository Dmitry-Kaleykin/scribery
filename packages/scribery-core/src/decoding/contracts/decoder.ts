import type { ByteSource } from "./byte-source.js";
import type {
    EncodingSelection,
    EncodingSelectionSource,
    SupportedEncoding,
} from "../../shared/contracts/encoding.js";

export interface DecodingInput {
    path: string;
    encodingSelection: EncodingSelection;
    bytes: ByteSource;
}

export interface DecodingOptions {
    maxByteLength?: number;
    signal?: AbortSignal;
}

export interface DecodingDiagnostic {
    code: "encoding-selected";
    encoding: SupportedEncoding;
    source: EncodingSelectionSource;
}

export interface DecodedDocument {
    content: string;
    encoding: SupportedEncoding;
    byteLength: number;
    diagnostics: DecodingDiagnostic[];
}

export interface DocumentDecoder {
    decode(
        input: DecodingInput,
        options?: DecodingOptions,
    ): Promise<DecodedDocument>;
}
