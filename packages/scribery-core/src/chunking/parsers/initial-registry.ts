import { HtmlParser } from "./html/html-parser.js";
import { JsonParser } from "./json/json-parser.js";
import { MarkdownParser } from "./markdown/markdown-parser.js";
import { ParserRegistry } from "./registry.js";
import { PhpParser } from "./php/php-parser.js";
import { PythonParser } from "./python/python-parser.js";
import { StylesheetParser } from "./stylesheet/stylesheet-parser.js";
import { TwigParser } from "./twig/twig-parser.js";
import { TypeScriptParser } from "./typescript/typescript-parser.js";
import { VueParser } from "./vue/vue-parser.js";

export function createInitialParserRegistry(): ParserRegistry {
    return new ParserRegistry([
        new TypeScriptParser(),
        new PythonParser(),
        new PhpParser(),
        new StylesheetParser(),
        new HtmlParser(),
        new JsonParser(),
        new MarkdownParser(),
        new VueParser(),
        new TwigParser(),
    ]);
}
