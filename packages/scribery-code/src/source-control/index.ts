export type {
    ResolvedRef,
    SourceControlContext,
    SourceControlOptions,
    SourceControlProvider,
    SourceState,
    WorkingTreeChange,
    WorkingTreeChangeKind,
    WorkingTreeState,
} from "./contracts/source-control.js";
export {
    SourceControlError,
    type SourceControlErrorCode,
} from "./errors/source-control-error.js";
export { inspectSourceState } from "./inspect-source-state.js";
export { GitSourceControlProvider } from "./providers/git/git-provider.js";
