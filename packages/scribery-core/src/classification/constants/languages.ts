export interface LanguageDescriptor {
    language: string;
    format: string;
}

export interface ShebangLanguageRule extends LanguageDescriptor {
    pattern: RegExp;
}

export const LANGUAGE_BY_EXTENSION: Readonly<
    Record<string, LanguageDescriptor>
> = {
    ts: { language: "typescript", format: "typescript" },
    tsx: { language: "typescript", format: "typescript-jsx" },
    mts: { language: "typescript", format: "typescript" },
    cts: { language: "typescript", format: "typescript" },
    js: { language: "javascript", format: "javascript" },
    jsx: { language: "javascript", format: "javascript-jsx" },
    mjs: { language: "javascript", format: "javascript" },
    cjs: { language: "javascript", format: "javascript" },
    py: { language: "python", format: "python" },
    pyi: { language: "python", format: "python-stub" },
    php: { language: "php", format: "php" },
    inc: { language: "php", format: "php" },
    twig: { language: "twig", format: "twig" },
    vue: { language: "vue", format: "vue" },
    cs: { language: "c-sharp", format: "c-sharp" },
    java: { language: "java", format: "java" },
    c: { language: "c", format: "c" },
    h: { language: "c", format: "c-header" },
    cc: { language: "cpp", format: "cpp" },
    cpp: { language: "cpp", format: "cpp" },
    cxx: { language: "cpp", format: "cpp" },
    hpp: { language: "cpp", format: "cpp-header" },
    go: { language: "go", format: "go" },
    rs: { language: "rust", format: "rust" },
    sh: { language: "shell", format: "shell" },
    bash: { language: "shell", format: "bash" },
    zsh: { language: "shell", format: "zsh" },
    html: { language: "html", format: "html" },
    htm: { language: "html", format: "html" },
    css: { language: "css", format: "css" },
    scss: { language: "scss", format: "scss" },
    json: { language: "json", format: "json" },
    yaml: { language: "yaml", format: "yaml" },
    yml: { language: "yaml", format: "yaml" },
    toml: { language: "toml", format: "toml" },
    md: { language: "markdown", format: "markdown" },
    markdown: { language: "markdown", format: "markdown" },
    rst: { language: "restructuredtext", format: "restructuredtext" },
};

export const LANGUAGE_BY_FILENAME: Readonly<
    Record<string, LanguageDescriptor>
> = {
    dockerfile: { language: "dockerfile", format: "dockerfile" },
    makefile: { language: "make", format: "makefile" },
    gnumakefile: { language: "make", format: "makefile" },
    jenkinsfile: { language: "groovy", format: "jenkinsfile" },
};

export const SHEBANG_LANGUAGE_RULES: readonly ShebangLanguageRule[] = [
    { pattern: /\b(?:node|nodejs)\b/, language: "javascript", format: "javascript" },
    { pattern: /\bpython(?:2|3)?\b/, language: "python", format: "python" },
    { pattern: /\b(?:bash|sh|zsh|dash|ksh)\b/, language: "shell", format: "shell" },
    { pattern: /\bruby\b/, language: "ruby", format: "ruby" },
    { pattern: /\bperl\b/, language: "perl", format: "perl" },
];
