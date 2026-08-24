import type {
    ClassificationInput,
    FileClassification,
} from "./classification.js";

export interface FileClassifier {
    classify(input: ClassificationInput): FileClassification;
}
