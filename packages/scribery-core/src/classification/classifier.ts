import type {
    ClassificationInput,
    FileClassification,
} from "./contracts/classification.js";
import type { FileClassifier } from "./contracts/classifier.js";
import { ClassificationError } from "./errors/classification-error.js";
import { classifyContent } from "./signals/content.js";
import { classifyLanguage } from "./signals/language.js";
import { classifyTraits } from "./signals/traits.js";

export class DefaultFileClassifier implements FileClassifier {
    classify(input: ClassificationInput): FileClassification {
        validateInput(input);

        const content = classifyContent(input);
        const language = classifyLanguage(input.path, input.sample);
        const traits = classifyTraits(
            input.path,
            input.byteLength,
            content.decodedSample,
        );
        const mayDescribeTextFormat = content.contentKind !== "binary";

        return {
            contentKind: content.contentKind,
            confidence: content.confidence,
            evidence: [
                ...content.evidence,
                ...language.evidence,
                ...traits.evidence,
            ],
            traits: traits.traits,
            ...(content.encoding === undefined
                ? {}
                : { encoding: content.encoding }),
            ...(!mayDescribeTextFormat || language.format === undefined
                ? {}
                : { format: language.format }),
            ...(!mayDescribeTextFormat || language.language === undefined
                ? {}
                : { language: language.language }),
        };
    }
}

function validateInput(input: ClassificationInput): void {
    if (input.path.trim().length === 0) {
        throw new ClassificationError(
            "invalid-input",
            "Classification path must not be empty",
            { path: input.path },
        );
    }

    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
        throw new ClassificationError(
            "invalid-input",
            `Byte length for ${input.path} must be a non-negative safe integer`,
            { path: input.path },
        );
    }

    if (!(input.sample instanceof Uint8Array)) {
        throw new ClassificationError(
            "invalid-input",
            `Classification sample for ${input.path} must be a Uint8Array`,
            { path: input.path },
        );
    }

    if (input.sample.byteLength > input.byteLength) {
        throw new ClassificationError(
            "invalid-input",
            `Classification sample for ${input.path} exceeds the file byte length`,
            { path: input.path },
        );
    }
}
