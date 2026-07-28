export function countNonWhitespaceCharacters(value: string) {
    let count = 0;

    for (const character of value) {
        if (!/\s/u.test(character)) count += 1;
    }

    return count;
}
