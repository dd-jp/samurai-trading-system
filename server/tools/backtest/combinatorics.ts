export function combinations(n: number, choose: number): number[][] {
  const result: number[][] = [];

  const walk = (start: number, picked: number[]): void => {
    if (picked.length === choose) {
      result.push([...picked]);
      return;
    }
    for (let index = start; index < n; index++) {
      walk(index + 1, [...picked, index]);
    }
  };

  walk(0, []);
  return result;
}
