/**
 * textFileFilter — shared whitelist of known source-code / text file extensions.
 *
 * Used by both the GitHub tree parser (client-side) and conceptually mirrored
 * in cli/fs.go for the local relay. Keep the two lists in sync.
 *
 * The filter is mutable at runtime — the UI can update the allowed set, and
 * changes are pushed to the Go relay via fs/setFilter RPC.
 */

// ---- Frozen defaults (never mutated) ----

const DEFAULT_TEXT_EXTS = Object.freeze([
    // Systems / native
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx',
    '.m', '.mm',
    '.swift', '.metal',
    '.cs', '.fs', '.fsx',
    '.rs', '.go', '.zig', '.nim',
    '.java', '.kt', '.kts', '.scala', '.groovy', '.gradle',
    '.d', '.v', '.vhdl', '.sv',

    // Scripting
    '.py', '.pyi', '.pyw',
    '.rb', '.erb', '.rake',
    '.pl', '.pm',
    '.lua',
    '.php', '.phtml',
    '.r',
    '.jl',
    '.tcl',

    // Shell
    '.sh', '.bash', '.zsh', '.fish',
    '.bat', '.cmd', '.ps1', '.psm1',

    // Web
    '.js', '.mjs', '.cjs',
    '.ts', '.tsx', '.jsx',
    '.html', '.htm', '.xhtml',
    '.css', '.scss', '.sass', '.less', '.styl',
    '.vue', '.svelte', '.astro',

    // Functional / ML
    '.hs', '.lhs',
    '.ml', '.mli', '.mll', '.mly',
    '.ex', '.exs', '.erl', '.hrl',
    '.clj', '.cljs', '.cljc', '.edn',
    '.lisp', '.cl', '.el', '.scm', '.rkt',

    // Data / config
    '.json', '.jsonc', '.json5',
    '.yaml', '.yml',
    '.toml', '.ini', '.cfg', '.conf',
    '.xml', '.xsl', '.xsd', '.dtd',
    '.plist', '.xcscheme', '.xcworkspacedata',
    '.pbxproj', '.storyboard', '.xib',
    '.properties', '.env', '.editorconfig',
    '.csv', '.tsv',

    // Markup / docs
    '.md', '.markdown', '.rst', '.adoc',
    '.txt', '.text', '.rtf',
    '.tex', '.bib',
    '.org',

    // Build / CI
    '.cmake', '.make', '.mk',
    '.dockerfile',
    '.tf', '.hcl',
    '.nix',
    '.bazel', '.bzl',

    // Package manifests / lock files
    '.lock', '.resolved',

    // Misc
    '.sql', '.graphql', '.gql', '.proto',
    '.glsl', '.vert', '.frag', '.wgsl', '.hlsl',
    '.diff', '.patch',
    '.gitignore', '.gitattributes', '.gitmodules',
    '.dockerignore', '.npmignore', '.eslintignore',
    '.cursorrules',
]);

const DEFAULT_TEXT_NAMES = Object.freeze([
    'Makefile', 'makefile', 'GNUmakefile',
    'Dockerfile', 'Containerfile',
    'Rakefile', 'Gemfile', 'Podfile',
    'Vagrantfile', 'Procfile', 'Justfile',
    'CMakeLists.txt',
    'LICENSE', 'COPYING', 'README', 'CHANGELOG',
    'AUTHORS', 'CONTRIBUTORS',
    '.gitignore', '.gitattributes', '.editorconfig',
    '.clang-format', '.clang-tidy',
    '.eslintrc', '.prettierrc', '.babelrc',
]);

const SKIP_DIRS = new Set([
    '.git', 'node_modules', '__pycache__', '.cache', '.tox',
    'vendor', 'dist', 'build', '.build', '.swiftpm',
    'Pods', 'DerivedData', 'target',
]);

// ---- Mutable runtime state ----

let _textExts = new Set(DEFAULT_TEXT_EXTS);
let _textNames = new Set(DEFAULT_TEXT_NAMES);

// ---- Getters / setters ----

/** @returns {string[]} sorted array of current extensions */
export function getTextExts() { return Array.from(_textExts).sort(); }

/** @returns {string[]} sorted array of current exact-name matches */
export function getTextNames() { return Array.from(_textNames).sort(); }

/** @param {string[]} exts */
export function setTextExts(exts) { _textExts = new Set(exts); }

/** @param {string[]} names */
export function setTextNames(names) { _textNames = new Set(names); }

/** @returns {{ exts: string[], names: string[] }} frozen defaults */
export function getDefaults() {
    return { exts: [...DEFAULT_TEXT_EXTS], names: [...DEFAULT_TEXT_NAMES] };
}

/** Reset runtime filter to built-in defaults. */
export function resetToDefaults() {
    _textExts = new Set(DEFAULT_TEXT_EXTS);
    _textNames = new Set(DEFAULT_TEXT_NAMES);
}

// ---- Filter functions (unchanged logic, read from mutable sets) ----

/**
 * Returns true if the filename matches the text-file whitelist.
 * @param {string} name — basename (e.g. "foo.js" or "Makefile")
 * @returns {boolean}
 */
export function isTextFile(name) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
        const ext = name.slice(dot).toLowerCase();
        return _textExts.has(ext);
    }
    return _textNames.has(name);
}

/**
 * Returns true if the directory name should be skipped during tree walks.
 * @param {string} name — directory basename
 * @returns {boolean}
 */
export function isSkippedDir(name) {
    return SKIP_DIRS.has(name);
}

/**
 * Filter a flat tree array (GitHub API format) to only text files and
 * non-skipped directories.
 * @param {Array<{path: string, type: string}>} tree
 * @returns {Array}
 */
export function filterTree(tree) {
    return tree.filter(item => {
        if (item.type === 'tree') {
            const parts = item.path.split('/');
            return !parts.some(p => isSkippedDir(p));
        }
        const basename = item.path.split('/').pop();
        const parts = item.path.split('/');
        if (parts.slice(0, -1).some(p => isSkippedDir(p))) return false;
        return isTextFile(basename);
    });
}
