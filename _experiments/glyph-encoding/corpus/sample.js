// Small ASCII-dominant fixture: representative of real source code, where the
// fast lane (1 byte = 1 codepoint = 1 glyph = 1 cell) holds almost everywhere.

export function fib(n) {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}

const memo = new Map();
export function fibMemo(n) {
  if (n < 2) return n;
  if (memo.has(n)) return memo.get(n);
  const v = fibMemo(n - 1) + fibMemo(n - 2);
  memo.set(n, v);
  return v;
}
