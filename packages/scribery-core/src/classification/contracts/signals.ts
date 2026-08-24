import type {
    ClassificationEvidence,
    ContentKind,
    FileTrait,
} from "./classification.js";
import type { SupportedEncoding } from "../../shared/contracts/encoding.js";

export interface ContentSignalResult {
    contentKind: ContentKind;
    encoding?: SupportedEncoding;
    confidence: number;
    decodedSample?: string;
    evidence: ClassificationEvidence[];
}

export interface LanguageSignalResult {
    format?: string;
    language?: string;
    evidence: ClassificationEvidence[];
}

export interface TraitSignalResult {
    traits: FileTrait[];
    evidence: ClassificationEvidence[];
}
