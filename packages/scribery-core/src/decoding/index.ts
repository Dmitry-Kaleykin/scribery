export { ENCODING } from "../shared/constants/encoding.js";
export { DEFAULT_MAX_BYTE_LENGTH } from "./constants/limits.js";
export type {
    ByteSource,
    ByteSourceReadOptions,
} from "./contracts/byte-source.js";
export type {
    DecodedDocument,
    DecodingDiagnostic,
    DecodingInput,
    DecodingOptions,
    DocumentDecoder,
} from "./contracts/decoder.js";
export type {
    EncodingLabel,
    EncodingSelection,
    EncodingSelectionSource,
    SupportedEncoding,
    Utf8EncodingLabel,
    Windows1251EncodingLabel,
} from "../shared/contracts/encoding.js";
export { DefaultDocumentDecoder } from "./decode-document.js";
export {
    DecodingError,
    type DecodingErrorCode,
} from "./errors/decoding-error.js";
export { normalizeEncodingLabel } from "../shared/utils/normalize-encoding-label.js";
