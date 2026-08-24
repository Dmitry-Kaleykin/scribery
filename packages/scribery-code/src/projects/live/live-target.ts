import { hashText } from "scribery-core";
import type { WorkingTreeState } from "../../source-control/index.js";
import { normalizeRetrievalTargetName } from "../retrieval/target-catalog.js";

export interface LiveBranchTarget {
    branch: string;
    target: string;
}

export function liveBranchTarget(state: WorkingTreeState): LiveBranchTarget {
    if (state.refName !== undefined) {
        return {
            branch: state.refName,
            target: liveTargetName(state.refName),
        };
    }
    if (state.detached && state.headCommit !== undefined) {
        const abbreviated = state.headCommit.slice(0, 12);
        return {
            branch: `detached@${abbreviated}`,
            target: `live/detached/${abbreviated}`,
        };
    }
    return { branch: "unborn", target: "live/unborn" };
}

export function liveTargetName(branch: string): string {
    const direct = `live/${branch}`;
    try {
        return normalizeRetrievalTargetName(direct);
    } catch {
        const slug = branch
            .normalize("NFKD")
            .replace(/[^A-Za-z0-9._/-]+/gu, "-")
            .replace(/\.{2,}/gu, ".")
            .replace(/\/{2,}/gu, "/")
            .replace(/^[/.-]+|[/.-]+$/gu, "")
            .slice(0, 96) || "branch";
        return normalizeRetrievalTargetName(
            `live/${slug}-${hashText(branch).replace(/^sha256:/u, "").slice(0, 10)}`,
        );
    }
}
