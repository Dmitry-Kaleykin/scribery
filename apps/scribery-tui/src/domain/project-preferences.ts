export interface ProjectPreference {
    projectIdentifier: string;
    root: string;
    profile: string;
    preset: string;
    target: string;
    keepReplacedBuilds: number;
    allowDirty: boolean;
    updatedAt: string;
}

export interface ProjectPreferencesFile {
    schemaVersion: 1;
    projects: readonly ProjectPreference[];
}

export interface ProjectPreferenceInput {
    projectIdentifier: string;
    root: string;
    profile: string;
    preset: string;
    target?: string;
    keepReplacedBuilds?: number;
    allowDirty?: boolean;
}
