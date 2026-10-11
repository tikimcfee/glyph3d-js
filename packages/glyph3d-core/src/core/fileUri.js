/**
 * The file:// URI codec — the one place paths become URIs and back.
 *
 * Providers, the registry's sourcePath meta, and LSP locations all speak
 * `file:///<path>`; leading slashes fold into the scheme, so `/a/b` and `a/b`
 * share one URI. A POSIX path round-trips with its leading `/`; a Windows drive
 * path (`file:///C:/x`) comes back as `C:/x`.
 *
 * These URIs are RAW — the path is never percent-encoded (the relay's fs RPC takes
 * it verbatim), so a `%` in a filename is just a `%`. A percent-encoded URI from
 * outside (an LSP server, per RFC 8089) decodes at THAT seam before it gets here.
 */

/** path → file:/// URI — the ONE strip point (leading slashes fold into the scheme). */
export function toFileUri(path) {
    return `file:///${String(path).replace(/^\/+/, '')}`;
}

/** file:// URI → path — toFileUri's exact inverse (raw; nothing decodes). */
export function fromFileUri(uri) {
    const rest = String(uri).replace(/^file:\/\/\/?/, '');
    return /^[A-Za-z]:\//.test(rest) ? rest : `/${rest}`;
}
