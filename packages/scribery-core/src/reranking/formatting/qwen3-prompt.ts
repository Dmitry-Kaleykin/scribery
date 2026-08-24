const QWEN3_RERANKING_SYSTEM_PROMPT =
    "Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be \"yes\" or \"no\".";

export function formatQwen3RerankingPrompt(
    instruction: string,
    query: string,
    document: string,
): string {
    return `<|im_start|>system\n${QWEN3_RERANKING_SYSTEM_PROMPT}<|im_end|>\n` +
        `<|im_start|>user\n<Instruct>: ${escapeSpecialTokens(instruction)}\n` +
        `<Query>: ${escapeSpecialTokens(query)}\n` +
        `<Document>: ${escapeSpecialTokens(document)}<|im_end|>\n` +
        "<|im_start|>assistant\n<think>\n\n</think>\n\n";
}

function escapeSpecialTokens(value: string): string {
    return value.replaceAll("<|", "<\u200b|");
}
