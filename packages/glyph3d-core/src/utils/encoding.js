/**
 * UTF-8-safe base64 encoding/decoding.
 *
 * JavaScript's atob/btoa operate on Latin-1 (one byte per char),
 * corrupting any multi-byte UTF-8 sequences. These wrappers use
 * TextEncoder/TextDecoder for correct UTF-8 handling.
 *
 * Single shared module — import { decodeBase64 } from './encoding.js'
 * instead of calling atob() directly.
 */

/**
 * Decode a base64 string to UTF-8 text.
 * @param {string} b64 - base64-encoded string
 * @returns {string} decoded UTF-8 text
 * @throws {Error} if input is not valid base64
 */
export function decodeBase64(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

/**
 * Encode a UTF-8 string to base64.
 * (Browser-side equivalent of Node's Buffer.from(str).toString('base64'))
 * @param {string} str - UTF-8 text
 * @returns {string} base64-encoded string
 */
export function encodeBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
