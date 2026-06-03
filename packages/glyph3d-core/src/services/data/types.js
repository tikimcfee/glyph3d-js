/**
 * Shared type vocabulary for the FileSystem Provider Layer.
 *
 * JSDoc typedefs consumed by RemoteFileSystemProvider, WebSocketBridge,
 * and the Go relay (cli/fs.go). Defines the shapes that cross the
 * JSON-RPC boundary so all three agree from day one.
 */

/**
 * @typedef {Object} FileStat
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size      - bytes
 * @property {number} mtime     - ms since epoch
 * @property {boolean} [readonly]
 */

/**
 * @typedef {Object} FileContent
 * @property {string} uri       - canonical identifier (e.g. "file:///path/to/foo.js")
 * @property {string} content   - UTF-8 text
 * @property {FileStat} stat
 */

/**
 * @typedef {Object} DirEntry
 * @property {string} path      - full relative path from root (not basename)
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size
 */

/**
 * @typedef {Object} FileSystemProvider
 * @property {string} scheme                              - URI scheme handled (e.g. "file", "github")
 * @property {function(string): Promise<FileContent>} readFile
 * @property {function(string, Object=): Promise<DirEntry[]>} listTree
 * @property {function(string): Promise<FileStat>} stat
 * @property {function(): void} dispose
 */

// ---- JSON-RPC error codes (mirrored in cli/fs.go) ----
const FS_ERROR_CODES = {
    FileNotFound:     -32001,
    PermissionDenied: -32002,
    IsDirectory:      -32003,
    FileTooLarge:     -32004,
    NotText:          -32005,
};

/**
 * Custom error class for filesystem operations.
 * Maps to JSON-RPC error codes from the Go relay.
 */
export class FileSystemError extends Error {
    /**
     * @param {string} message
     * @param {number} code   - JSON-RPC error code
     * @param {string} [uri]  - the URI that caused the error
     */
    constructor(message, code, uri) {
        super(message);
        this.name = 'FileSystemError';
        this.code = code;
        this.uri = uri || null;
    }

    static FileNotFound(uri) {
        return new FileSystemError(`File not found: ${uri}`, FS_ERROR_CODES.FileNotFound, uri);
    }

    static PermissionDenied(uri) {
        return new FileSystemError(`Permission denied: ${uri}`, FS_ERROR_CODES.PermissionDenied, uri);
    }

    static IsDirectory(uri) {
        return new FileSystemError(`Is a directory: ${uri}`, FS_ERROR_CODES.IsDirectory, uri);
    }

    static FileTooLarge(uri) {
        return new FileSystemError(`File too large: ${uri}`, FS_ERROR_CODES.FileTooLarge, uri);
    }

    /**
     * Create a FileSystemError from a JSON-RPC error object.
     * @param {{ code: number, message: string, data?: any }} rpcError
     * @returns {FileSystemError}
     */
    static fromRpcError(rpcError) {
        const uri = rpcError.data?.uri || null;
        return new FileSystemError(rpcError.message, rpcError.code, uri);
    }
}
