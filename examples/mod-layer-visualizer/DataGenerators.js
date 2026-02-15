/**
 * Data generators for the mod layer visualizer.
 * Pure functions that produce arrays of numbers from various sources.
 */

/**
 * Generate first N prime numbers via trial division.
 * @param {number} n - Count of primes to generate
 * @returns {number[]}
 */
export function generatePrimes(n) {
    const primes = [];
    let candidate = 2;
    while (primes.length < n) {
        let isPrime = true;
        for (let i = 0; i < primes.length && primes[i] * primes[i] <= candidate; i++) {
            if (candidate % primes[i] === 0) {
                isPrime = false;
                break;
            }
        }
        if (isPrime) primes.push(candidate);
        candidate++;
    }
    return primes;
}

/**
 * Generate first N Fibonacci numbers.
 * @param {number} n
 * @returns {number[]}
 */
export function generateFibonacci(n) {
    if (n <= 0) return [];
    if (n === 1) return [1];
    const seq = [1, 1];
    for (let i = 2; i < n; i++) {
        seq.push(seq[i - 1] + seq[i - 2]);
    }
    return seq;
}

/**
 * Generate integers 1 through N.
 * @param {number} n
 * @returns {number[]}
 */
export function generateIntegers(n) {
    return Array.from({ length: n }, (_, i) => i + 1);
}

/**
 * Generate N random integers in [0, max).
 * @param {number} n
 * @param {number} max
 * @returns {number[]}
 */
export function generateRandom(n, max = 10000) {
    return Array.from({ length: n }, () => Math.floor(Math.random() * max));
}

/**
 * Convert a string to its UTF-8 byte values.
 * @param {string} text
 * @returns {number[]}
 */
export function textToBytes(text) {
    return Array.from(new TextEncoder().encode(text));
}

/**
 * Generate the Collatz (3n+1) sequence starting from a given number.
 * Terminates when reaching 1 or after maxSteps iterations.
 * @param {number} start
 * @param {number} maxSteps
 * @returns {number[]}
 */
export function generateCollatz(start, maxSteps = 10000) {
    if (start < 1) start = 1;
    const seq = [start];
    let n = start;
    for (let i = 0; i < maxSteps && n !== 1; i++) {
        n = n % 2 === 0 ? n / 2 : 3 * n + 1;
        seq.push(n);
    }
    return seq;
}

/**
 * Generate first N triangular numbers: T(k) = k*(k+1)/2.
 * @param {number} n
 * @returns {number[]}
 */
export function generateTriangular(n) {
    return Array.from({ length: n }, (_, k) => (k + 1) * (k + 2) / 2);
}
