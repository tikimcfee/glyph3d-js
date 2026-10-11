/**
 * The file:// URI codec — the one place paths become URIs and back.
 *
 * Providers, the registry's sourcePath meta, and LSP locations all speak
 * `file:///<path>`; leading slashes fold into the scheme, so `/a/b` and `a/b`
 * share one URI. A POSIX path round-trips with its leading `/`; a Windows drive
 * path (`file:///C:/x`) decodes to `C:/x`.
 */

/** path → file:/// URI — the ONE strip point (leading slashes fold into the scheme). */
export function toFileUri(path) {
    return `file:///${String(path).replace(/^\/+/, '')}`;
}

/** file:// URI → path — toFileUri's inverse. Percent-escapes decode (LSP servers send them). */
export function fromFileUri(uri) {
    const rest = decodeURIComponent(String(uri).replace(/^file:\/\/\/?/, ''));
    return /^[A-Za-z]:\//.test(rest) ? rest : `/${rest}`;
}
