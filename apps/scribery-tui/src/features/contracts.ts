import type { SelectItem } from "@earendil-works/pi-tui";
import type { IndexedProjectSummary } from "scribery";

import type { ProjectPreference } from "../domain/project-preferences.js";

export type TranscriptTone = "normal" | "muted" | "success" | "warning";

export interface FeatureUi {
    append(message: string, tone?: TranscriptTone): void;
    pick(title: string, items: readonly SelectItem[]): Promise<SelectItem | undefined>;
    input(title: string, label: string, initialValue?: string): Promise<string | undefined>;
    secretInput(title: string, label: string): Promise<string | undefined>;
    confirm(title: string, defaultYes?: boolean): Promise<boolean>;
    editJson(value: unknown, label: string): Promise<unknown | undefined>;
}

export interface ProjectPreferenceContext {
    activeProject(): IndexedProjectSummary | undefined;
    activePreference(): ProjectPreference | undefined;
    setActivePreference(preference: ProjectPreference | undefined): void;
    reloadActivePreference(): Promise<void>;
}
