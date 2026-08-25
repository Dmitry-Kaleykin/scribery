export interface LiveReadyIdentity {
    branch: string | undefined;
    target: string;
}

export function shouldAnnounceLiveReady(
    previous: LiveReadyIdentity | undefined,
    current: LiveReadyIdentity,
    recoveredFromFailure: boolean,
): boolean {
    return previous === undefined ||
        recoveredFromFailure ||
        previous.branch !== current.branch ||
        previous.target !== current.target;
}
