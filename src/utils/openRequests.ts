export async function consumeOpenRequests(
    restore: () => Promise<void>,
    take: () => Promise<string[]>,
    open: (path: string) => Promise<unknown>,
): Promise<string[]> {
    await restore();
    const errors: string[] = [];
    for (const path of await take()) {
        try {
            await open(path);
        } catch (error) {
            errors.push(`${path}: ${String(error)}`);
        }
    }
    return errors;
}
