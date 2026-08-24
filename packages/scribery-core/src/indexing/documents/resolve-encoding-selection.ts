import picomatch from "picomatch";

import type { EncodingSelection } from "../../shared/index.js";
import type {
    PreparedSourceDocument,
} from "../../sources/contracts/source.js";
import type { IndexBuildPlan } from "../contracts/build-engine.js";
import type { EncodingPathRule } from "../contracts/coordinator.js";

export function resolveDocumentEncodingSelection(
    document: PreparedSourceDocument,
    path: string,
    rules: readonly EncodingPathRule[],
    fallback: IndexBuildPlan["encodingFallback"],
): EncodingSelection {
    if (document.encoding !== undefined) {
        return { override: document.encoding };
    }
    const rule = rules.find(({ pattern }) => picomatch.isMatch(path, pattern));
    if (rule !== undefined) return { override: rule.encoding };
    return fallback === undefined ? {} : { fallback };
}

