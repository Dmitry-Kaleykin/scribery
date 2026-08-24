import type {
    EncodingSelection,
    SupportedEncoding,
} from "../../shared/contracts/encoding.js";

export type ContentKind = "text" | "binary" | "unknown";

export type FileTrait =
    | "generated"
    | "minified"
    | "lockfile"
    | "configuration"
    | "documentation"
    | "test"
    | "declaration"
    | "empty";

export type ClassificationEvidenceSignal =
    | "path"
    | "filename"
    | "extension"
    | "byte-order-mark"
    | "byte-sample"
    | "shebang"
    | "configuration";

export type ClassificationConclusion =
    | { kind: "content-kind"; value: ContentKind }
    | { kind: "encoding"; value: SupportedEncoding }
    | { kind: "format"; value: string }
    | { kind: "language"; value: string }
    | { kind: "trait"; value: FileTrait };

export interface ClassificationEvidence {
    signal: ClassificationEvidenceSignal;
    conclusion: ClassificationConclusion;
    confidence: number;
    detail?: string;
}

export interface ClassificationInput {
    path: string;
    byteLength: number;
    sample: Uint8Array;
    encodingSelection?: EncodingSelection;
}

export interface FileClassification {
    contentKind: ContentKind;
    format?: string;
    language?: string;
    encoding?: SupportedEncoding;
    confidence: number;
    evidence: ClassificationEvidence[];
    traits: FileTrait[];
}
