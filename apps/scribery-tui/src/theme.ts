const ESC = "\u001b[";

function code(value: number, text: string): string {
    return `${ESC}${value}m${text}${ESC}0m`;
}

export const colors = {
    accent: (text: string): string => code(96, text),
    blue: (text: string): string => code(94, text),
    dim: (text: string): string => code(2, text),
    error: (text: string): string => code(91, text),
    muted: (text: string): string => code(90, text),
    selected: (text: string): string => `${ESC}48;5;24m${ESC}97m${text}${ESC}0m`,
    success: (text: string): string => code(92, text),
    warning: (text: string): string => code(93, text),
    bold: (text: string): string => code(1, text),
};

export const selectTheme = {
    selectedPrefix: colors.accent,
    selectedText: colors.selected,
    description: colors.muted,
    scrollInfo: colors.dim,
    noMatch: colors.warning,
};

export const editorTheme = {
    borderColor: colors.blue,
    selectList: selectTheme,
};
