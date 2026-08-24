import { realpath } from "node:fs/promises";

import { createRepositoryId } from "scribery-core";
import type {
    SourceControlOptions,
    SourceState,
} from "./contracts/source-control.js";
import { GitSourceControlProvider } from "./providers/git/git-provider.js";

export async function inspectSourceState(
    root: string,
    options: SourceControlOptions = {},
): Promise<SourceState> {
    const provider = new GitSourceControlProvider();
    const context = await provider.detect(root, options);

    if (context === null) {
        const indexingRoot = await realpath(root);
        return {
            kind: "plain-directory",
            repositoryId: createRepositoryId(
                options.repositoryIdentity ?? indexingRoot,
            ),
            indexingRoot,
        };
    }

    return {
        kind: "git",
        context,
        state: await provider.resolveCurrentState(context, options),
    };
}
