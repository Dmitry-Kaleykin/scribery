import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { colors } from "../theme.js";

const KEYBOARD_HINTS = "/ commands · plain text searches · ↑↓ history · Ctrl+C twice exits";

export class FooterComponent implements Component {
    #cwd = process.cwd();
    #projectRoot: string | undefined;
    #notice: string | undefined;

    setLocation(cwd: string, projectRoot?: string): void {
        this.#cwd = cwd;
        this.#projectRoot = projectRoot;
    }

    setNotice(notice?: string): void {
        this.#notice = notice;
    }

    render(width: number): string[] {
        const location = formatLocation(this.#cwd, this.#projectRoot);
        const text = this.#notice
            ? `${colors.muted(location)} · ${colors.warning(this.#notice)}`
            : colors.muted(`${location} · ${KEYBOARD_HINTS}`);
        return [truncateToWidth(text, width)];
    }

    invalidate(): void {}
}

export function formatLocation(cwd: string, projectRoot?: string, home = homedir()): string {
    if (projectRoot) {
        const projectPath = relative(projectRoot, cwd);
        if (isInside(projectPath)) {
            return `${abbreviateHome(projectRoot, home)} · cwd: ${projectPath || "."}`;
        }
    }
    return `cwd: ${abbreviateHome(cwd, home)}`;
}

function isInside(relativePath: string): boolean {
    return relativePath === "" || (
        relativePath !== ".." &&
        !relativePath.startsWith(`..${sep}`) &&
        !isAbsolute(relativePath)
    );
}

function abbreviateHome(path: string, home: string): string {
    const homePath = relative(home, path);
    if (!isInside(homePath)) return path;
    return homePath ? `~${sep}${homePath}` : "~";
}
