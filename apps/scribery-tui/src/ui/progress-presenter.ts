import { Container, TuiMainScreen } from "@earendil-works/pi-tui";
import type { IndexingProgress } from "scribery";

import {
    IndexingProgressComponent,
    type IndexingLiveState,
} from "../components/indexing-progress.js";

export class ProgressPresenter {
    readonly #ui: TuiMainScreen;
    readonly #area: Container;
    readonly #suspended: () => boolean;
    #component: IndexingProgressComponent | undefined;
    #timer: NodeJS.Timeout | undefined;

    constructor(
        ui: TuiMainScreen,
        area: Container,
        suspended: () => boolean,
    ) {
        this.#ui = ui;
        this.#area = area;
        this.#suspended = suspended;
    }

    get active(): boolean {
        return this.#component !== undefined;
    }

    start(state: IndexingLiveState): void {
        if (!this.#component) {
            this.#component = new IndexingProgressComponent();
            this.#area.addChild(this.#component);
            this.#timer = setInterval(() => {
                this.#component?.tick();
                if (!this.#suspended()) this.#ui.requestRender();
            }, 90);
        }
        this.#component.setState(state);
        if (!this.#suspended()) {
            this.#ui.terminal.setProgress(true);
            this.#ui.requestRender();
        }
    }

    set(state: IndexingLiveState): void {
        this.#component?.setState(state);
    }

    setIndexing(progress: IndexingProgress): void {
        this.set({ stage: "indexing", progress });
    }

    requestRender(immediate = false): void {
        if (this.#suspended()) return;
        if (immediate) this.#ui.renderNow();
        else this.#ui.requestRender();
    }

    stop(): void {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = undefined;
        this.#area.clear();
        this.#component = undefined;
        if (!this.#suspended()) this.#ui.terminal.setProgress(false);
    }
}
