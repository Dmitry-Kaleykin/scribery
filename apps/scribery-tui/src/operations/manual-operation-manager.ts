import type { IndexingProgress } from "scribery";

import type { ProgressPresenter } from "../ui/progress-presenter.js";

export interface ActiveManualOperation {
    root: string;
    controller: AbortController;
    startedAt: number;
    progress?: IndexingProgress;
}

export class ManualOperationManager {
    readonly #progress: ProgressPresenter;
    readonly #onStateChange: () => void;
    #active: ActiveManualOperation | undefined;

    constructor(progress: ProgressPresenter, onStateChange: () => void) {
        this.#progress = progress;
        this.#onStateChange = onStateChange;
    }

    get active(): ActiveManualOperation | undefined {
        return this.#active;
    }

    get running(): boolean {
        return this.#active !== undefined;
    }

    begin(root: string, message: string): ActiveManualOperation {
        if (this.#active) {
            throw new Error(`An index is already running for ${this.#active.root}`);
        }
        const operation: ActiveManualOperation = {
            root,
            controller: new AbortController(),
            startedAt: Date.now(),
        };
        this.#active = operation;
        this.#progress.start({ stage: "provider", message });
        this.#onStateChange();
        return operation;
    }

    update(progress: IndexingProgress, immediate = false): void {
        if (!this.#active) return;
        this.#active.progress = progress;
        this.#progress.setIndexing(progress);
        this.#progress.requestRender(immediate);
    }

    setMessage(message: string): void {
        this.#progress.set({ stage: "provider", message });
        this.#progress.requestRender();
    }

    finish(): void {
        this.#progress.stop();
        this.#active = undefined;
        this.#onStateChange();
    }

    abort(reason: Error): void {
        this.#active?.controller.abort(reason);
    }
}
