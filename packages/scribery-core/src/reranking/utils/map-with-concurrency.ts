export async function mapWithConcurrency<Input, Output>(
    inputs: readonly Input[],
    maximumConcurrency: number,
    mapper: (input: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> {
    const results = new Array<Output | undefined>(inputs.length);
    let nextIndex = 0;

    await Promise.all(Array.from(
        { length: Math.min(maximumConcurrency, inputs.length) },
        async () => {
            while (nextIndex < inputs.length) {
                const index = nextIndex;
                nextIndex += 1;
                results[index] = await mapper(inputs[index]!, index);
            }
        },
    ));

    return results as Output[];
}
