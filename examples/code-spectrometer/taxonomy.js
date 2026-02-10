/**
 * Code Concept Taxonomy
 *
 * A periodic-table-style vocabulary of software engineering concepts.
 * Each "element" is a word that represents a recognizable pattern in code.
 *
 * Organization:
 *   Groups (columns)  = semantic behavior (what it does)
 *   Periods (rows)    = abstraction level (how concrete/abstract)
 *   Blocks (color)    = fundamental category
 *
 * The periodic table analogy:
 *   - Proton count → character/token patterns that identify the concept
 *   - Electron shells → abstraction level
 *   - Chemical behavior → what the concept DOES in a system
 *   - Grouping → concepts that behave similarly live in the same column
 */

// ─── BLOCK DEFINITIONS ──────────────────────────────────────────────
// Each block is a fundamental category, like s/p/d/f blocks in chemistry

export const BLOCKS = {
    substance: {
        name: 'Substance',
        description: 'What things ARE — types, structures, containers',
        color: { r: 0.4, g: 0.7, b: 1.0 },     // Blue family
        hue: 210,
    },
    action: {
        name: 'Action',
        description: 'What things DO — operations, transforms, movement',
        color: { r: 1.0, g: 0.5, b: 0.3 },     // Orange family
        hue: 25,
    },
    pattern: {
        name: 'Pattern',
        description: 'How things are ORGANIZED — architecture, design',
        color: { r: 0.6, g: 1.0, b: 0.4 },     // Green family
        hue: 100,
    },
    quality: {
        name: 'Quality',
        description: 'How things are VERIFIED — testing, observability',
        color: { r: 1.0, g: 0.7, b: 1.0 },     // Pink/purple family
        hue: 300,
    },
    domain: {
        name: 'Domain',
        description: 'What things are FOR — application concerns',
        color: { r: 1.0, g: 1.0, b: 0.4 },     // Yellow family
        hue: 55,
    },
};

// ─── ELEMENT DEFINITIONS ────────────────────────────────────────────
// Each element: { symbol, name, block, period, group, triggers }
//   symbol:   1-3 letter abbreviation (displayed prominently)
//   name:     full concept name
//   block:    which block it belongs to
//   period:   row (1=primitive, 2=basic, 3=composed, 4=abstract, 5=system, 6=meta)
//   group:    column position (1-18, like periodic table)
//   triggers: token patterns that indicate this concept in code

export const ELEMENTS = [
    // ═══════════════════════════════════════════════════════════════
    // PERIOD 1 — Primitives (raw building blocks)
    // ═══════════════════════════════════════════════════════════════

    // Substance: atomic types
    { symbol: 'Ty', name: 'type',      block: 'substance', period: 1, group: 1,  triggers: ['type', 'typedef', 'typealias', 'typing'] },
    { symbol: 'Vl', name: 'value',     block: 'substance', period: 1, group: 2,  triggers: ['value', 'val', 'literal', 'datum'] },

    // Action: atomic operations
    { symbol: 'Rd', name: 'read',      block: 'action', period: 1, group: 7,  triggers: ['read', 'get', 'fetch', 'load', 'access', 'lookup'] },
    { symbol: 'Wr', name: 'write',     block: 'action', period: 1, group: 8,  triggers: ['write', 'set', 'put', 'store', 'save', 'assign'] },
    { symbol: 'Cr', name: 'create',    block: 'action', period: 1, group: 9,  triggers: ['create', 'new', 'make', 'init', 'construct', 'alloc', 'instantiate'] },
    { symbol: 'Dl', name: 'delete',    block: 'action', period: 1, group: 10, triggers: ['delete', 'remove', 'destroy', 'dispose', 'free', 'dealloc', 'drop'] },
    { symbol: 'Cl', name: 'call',      block: 'action', period: 1, group: 11, triggers: ['call', 'invoke', 'apply', 'execute', 'run'] },
    { symbol: 'Rt', name: 'return',    block: 'action', period: 1, group: 12, triggers: ['return', 'yield', 'result', 'output', 'emit'] },

    // ═══════════════════════════════════════════════════════════════
    // PERIOD 2 — Basic types and operations
    // ═══════════════════════════════════════════════════════════════

    // Substance: concrete types
    { symbol: 'Nm', name: 'number',    block: 'substance', period: 2, group: 1,  triggers: ['number', 'int', 'integer', 'float', 'double', 'decimal', 'numeric', 'count', 'amount'] },
    { symbol: 'St', name: 'string',    block: 'substance', period: 2, group: 2,  triggers: ['string', 'str', 'text', 'char', 'character', 'varchar', 'utf'] },
    { symbol: 'Bo', name: 'boolean',   block: 'substance', period: 2, group: 3,  triggers: ['boolean', 'bool', 'flag', 'toggle', 'true', 'false'] },
    { symbol: 'By', name: 'byte',      block: 'substance', period: 2, group: 4,  triggers: ['byte', 'bit', 'binary', 'octet', 'word', 'uint8'] },
    { symbol: 'Nl', name: 'null',      block: 'substance', period: 2, group: 5,  triggers: ['null', 'nil', 'none', 'undefined', 'void', 'empty', 'nothing'] },
    { symbol: 'Rf', name: 'reference', block: 'substance', period: 2, group: 6,  triggers: ['reference', 'ref', 'pointer', 'ptr', 'handle', 'weak', 'strong'] },

    // Action: basic operations
    { symbol: 'Gt', name: 'get',       block: 'action', period: 2, group: 7,  triggers: ['get', 'getter', 'accessor', 'retrieve', 'obtain', 'acquire'] },
    { symbol: 'Se', name: 'assign',     block: 'action', period: 2, group: 8,  triggers: ['set', 'setter', 'mutator', 'assign', 'update'] },
    { symbol: 'Ps', name: 'push',      block: 'action', period: 2, group: 9,  triggers: ['push', 'append', 'add', 'insert', 'enqueue', 'prepend'] },
    { symbol: 'Po', name: 'pop',       block: 'action', period: 2, group: 10, triggers: ['pop', 'shift', 'dequeue', 'remove', 'extract', 'take'] },
    { symbol: 'Sn', name: 'send',      block: 'action', period: 2, group: 11, triggers: ['send', 'post', 'dispatch', 'broadcast', 'publish', 'transmit'] },
    { symbol: 'Rc', name: 'receive',   block: 'action', period: 2, group: 12, triggers: ['receive', 'listen', 'subscribe', 'consume', 'accept', 'handle'] },

    // Pattern: basic structures
    { symbol: 'Vr', name: 'variable',  block: 'pattern', period: 2, group: 13, triggers: ['var', 'let', 'variable', 'mutable', 'mut'] },
    { symbol: 'Cn', name: 'constant',  block: 'pattern', period: 2, group: 14, triggers: ['const', 'constant', 'final', 'readonly', 'immutable', 'frozen'] },
    { symbol: 'Sc', name: 'scope',     block: 'pattern', period: 2, group: 15, triggers: ['scope', 'context', 'closure', 'binding', 'environment', 'namespace'] },

    // ═══════════════════════════════════════════════════════════════
    // PERIOD 3 — Composed structures and operations
    // ═══════════════════════════════════════════════════════════════

    // Substance: container types
    { symbol: 'Ar', name: 'array',     block: 'substance', period: 3, group: 1,  triggers: ['array', 'list', 'vector', 'slice', 'sequence', 'collection'] },
    { symbol: 'Mp', name: 'map',       block: 'substance', period: 3, group: 2,  triggers: ['map', 'dict', 'dictionary', 'hash', 'hashtable', 'hashmap', 'object', 'record'] },
    { symbol: 'Ss', name: 'set',       block: 'substance', period: 3, group: 3,  triggers: ['set', 'hashset', 'unique', 'distinct', 'bitset'] },
    { symbol: 'Bf', name: 'buffer',    block: 'substance', period: 3, group: 4,  triggers: ['buffer', 'arraybuffer', 'float32array', 'uint8array', 'typedarray', 'blob'] },
    { symbol: 'Sm', name: 'stream',    block: 'substance', period: 3, group: 5,  triggers: ['stream', 'pipe', 'channel', 'readable', 'writable', 'duplex', 'flow'] },
    { symbol: 'Tb', name: 'table',     block: 'substance', period: 3, group: 6,  triggers: ['table', 'matrix', 'grid', 'dataframe', 'spreadsheet', 'row', 'column', 'cell'] },

    // Action: composed operations
    { symbol: 'Sr', name: 'search',    block: 'action', period: 3, group: 7,  triggers: ['search', 'find', 'query', 'lookup', 'locate', 'match', 'grep', 'index'] },
    { symbol: 'So', name: 'sort',      block: 'action', period: 3, group: 8,  triggers: ['sort', 'order', 'rank', 'arrange', 'compare', 'collate'] },
    { symbol: 'Fl', name: 'filter',    block: 'action', period: 3, group: 9,  triggers: ['filter', 'where', 'select', 'predicate', 'exclude', 'include', 'criteria'] },
    { symbol: 'Ma', name: 'transform',  block: 'action', period: 3, group: 10, triggers: ['map', 'transform', 'convert', 'project', 'apply', 'foreach'] },
    { symbol: 'Re', name: 'reduce',    block: 'action', period: 3, group: 11, triggers: ['reduce', 'fold', 'aggregate', 'accumulate', 'collect', 'summarize'] },
    { symbol: 'Mg', name: 'merge',     block: 'action', period: 3, group: 12, triggers: ['merge', 'join', 'concat', 'combine', 'union', 'zip', 'flatten'] },

    // Pattern: code structures
    { symbol: 'Fn', name: 'function',  block: 'pattern', period: 3, group: 13, triggers: ['function', 'func', 'fn', 'method', 'procedure', 'subroutine', 'lambda', 'arrow'] },
    { symbol: 'Cs', name: 'class',     block: 'pattern', period: 3, group: 14, triggers: ['class', 'struct', 'object', 'prototype', 'constructor', 'this', 'self'] },
    { symbol: 'Md', name: 'module',    block: 'pattern', period: 3, group: 15, triggers: ['module', 'import', 'export', 'require', 'package', 'library', 'crate', 'bundle'] },

    // Quality: basic checks
    { symbol: 'Lg', name: 'log',       block: 'quality', period: 3, group: 16, triggers: ['log', 'print', 'console', 'debug', 'trace', 'warn', 'info', 'output'] },
    { symbol: 'Er', name: 'error',     block: 'quality', period: 3, group: 17, triggers: ['error', 'err', 'exception', 'throw', 'catch', 'try', 'finally', 'panic', 'fault'] },
    { symbol: 'As', name: 'assert',    block: 'quality', period: 3, group: 18, triggers: ['assert', 'expect', 'should', 'must', 'verify', 'check', 'ensure'] },

    // ═══════════════════════════════════════════════════════════════
    // PERIOD 4 — Abstract structures and higher-order operations
    // ═══════════════════════════════════════════════════════════════

    // Substance: abstract containers
    { symbol: 'Sk', name: 'stack',     block: 'substance', period: 4, group: 1,  triggers: ['stack', 'lifo', 'callstack', 'push', 'pop'] },
    { symbol: 'Qu', name: 'queue',     block: 'substance', period: 4, group: 2,  triggers: ['queue', 'fifo', 'deque', 'priority', 'enqueue', 'dequeue', 'job'] },
    { symbol: 'Tr', name: 'tree',      block: 'substance', period: 4, group: 3,  triggers: ['tree', 'node', 'branch', 'leaf', 'root', 'child', 'parent', 'subtree', 'bst', 'trie'] },
    { symbol: 'Gr', name: 'graph',     block: 'substance', period: 4, group: 4,  triggers: ['graph', 'edge', 'vertex', 'node', 'neighbor', 'adjacency', 'dag', 'cycle', 'path'] },
    { symbol: 'Hp', name: 'heap',      block: 'substance', period: 4, group: 5,  triggers: ['heap', 'priority', 'arena', 'pool', 'slab', 'allocator'] },
    { symbol: 'Ix', name: 'index',     block: 'substance', period: 4, group: 6,  triggers: ['index', 'cursor', 'offset', 'position', 'iterator', 'pointer', 'address'] },

    // Action: higher-order operations
    { symbol: 'Pa', name: 'parse',     block: 'action', period: 4, group: 7,  triggers: ['parse', 'tokenize', 'lex', 'syntax', 'ast', 'grammar', 'regex', 'pattern'] },
    { symbol: 'Fm', name: 'format',    block: 'action', period: 4, group: 8,  triggers: ['format', 'serialize', 'stringify', 'template', 'render', 'interpolate', 'printf'] },
    { symbol: 'En', name: 'encode',    block: 'action', period: 4, group: 9,  triggers: ['encode', 'decode', 'base64', 'utf8', 'ascii', 'unicode', 'escape', 'unescape'] },
    { symbol: 'Cm', name: 'compress',  block: 'action', period: 4, group: 10, triggers: ['compress', 'decompress', 'gzip', 'zip', 'deflate', 'inflate', 'pack', 'unpack'] },
    { symbol: 'Ec', name: 'encrypt',   block: 'action', period: 4, group: 11, triggers: ['encrypt', 'decrypt', 'hash', 'hmac', 'sign', 'cipher', 'aes', 'rsa', 'sha', 'crypto'] },
    { symbol: 'Vd', name: 'validate',  block: 'action', period: 4, group: 12, triggers: ['validate', 'sanitize', 'clean', 'normalize', 'conform', 'schema', 'constraint'] },

    // Pattern: design patterns
    { symbol: 'If', name: 'interface', block: 'pattern', period: 4, group: 13, triggers: ['interface', 'protocol', 'trait', 'abstract', 'contract', 'api', 'spec'] },
    { symbol: 'Gn', name: 'generic',   block: 'pattern', period: 4, group: 14, triggers: ['generic', 'template', 'parameterized', 'polymorphic', 'typevar', 'any'] },
    { symbol: 'In', name: 'inherit',   block: 'pattern', period: 4, group: 15, triggers: ['extends', 'inherit', 'super', 'override', 'virtual', 'base', 'derived', 'mixin'] },

    // Quality: testing
    { symbol: 'Ts', name: 'test',      block: 'quality', period: 4, group: 16, triggers: ['test', 'spec', 'suite', 'describe', 'it', 'beforeeach', 'aftereach', 'fixture'] },
    { symbol: 'Mk', name: 'mock',      block: 'quality', period: 4, group: 17, triggers: ['mock', 'stub', 'spy', 'fake', 'double', 'fixture', 'sandbox'] },
    { symbol: 'Cv', name: 'coverage',  block: 'quality', period: 4, group: 18, triggers: ['coverage', 'instrument', 'profile', 'benchmark', 'perf', 'metric', 'measure'] },

    // ═══════════════════════════════════════════════════════════════
    // PERIOD 5 — System-level concepts
    // ═══════════════════════════════════════════════════════════════

    // Substance: system resources
    { symbol: 'Fi', name: 'file',      block: 'substance', period: 5, group: 1,  triggers: ['file', 'path', 'directory', 'folder', 'filesystem', 'fs', 'stat', 'inode'] },
    { symbol: 'Db', name: 'database',  block: 'substance', period: 5, group: 2,  triggers: ['database', 'db', 'sql', 'nosql', 'mongo', 'postgres', 'sqlite', 'redis', 'table'] },
    { symbol: 'Nw', name: 'network',   block: 'substance', period: 5, group: 3,  triggers: ['network', 'socket', 'tcp', 'udp', 'http', 'https', 'websocket', 'dns', 'ip'] },
    { symbol: 'Pr', name: 'process',   block: 'substance', period: 5, group: 4,  triggers: ['process', 'thread', 'worker', 'fork', 'spawn', 'exec', 'pid', 'signal'] },
    { symbol: 'Mm', name: 'memory',    block: 'substance', period: 5, group: 5,  triggers: ['memory', 'heap', 'stack', 'gc', 'garbage', 'malloc', 'free', 'leak', 'arena'] },
    { symbol: 'Tm', name: 'time',      block: 'substance', period: 5, group: 6,  triggers: ['time', 'date', 'timestamp', 'duration', 'interval', 'timeout', 'timer', 'clock', 'epoch'] },

    // Action: system operations
    { symbol: 'Rq', name: 'request',   block: 'action', period: 5, group: 7,  triggers: ['request', 'req', 'http', 'fetch', 'ajax', 'xhr', 'curl', 'api'] },
    { symbol: 'Rs', name: 'response',  block: 'action', period: 5, group: 8,  triggers: ['response', 'res', 'reply', 'status', 'header', 'body', 'payload'] },
    { symbol: 'Aw', name: 'async',     block: 'action', period: 5, group: 9,  triggers: ['async', 'await', 'promise', 'future', 'deferred', 'concurrent', 'parallel'] },
    { symbol: 'Sy', name: 'sync',      block: 'action', period: 5, group: 10, triggers: ['sync', 'synchronous', 'blocking', 'sequential', 'serial', 'lock', 'mutex', 'semaphore'] },
    { symbol: 'Ev', name: 'event',     block: 'action', period: 5, group: 11, triggers: ['event', 'emit', 'on', 'off', 'listener', 'handler', 'callback', 'hook', 'trigger'] },
    { symbol: 'Sc', name: 'schedule',  block: 'action', period: 5, group: 12, triggers: ['schedule', 'cron', 'interval', 'timeout', 'delay', 'throttle', 'debounce', 'batch'] },

    // Pattern: architecture
    { symbol: 'Sv', name: 'service',   block: 'pattern', period: 5, group: 13, triggers: ['service', 'microservice', 'server', 'daemon', 'agent', 'worker'] },
    { symbol: 'Ct', name: 'controller',block: 'pattern', period: 5, group: 14, triggers: ['controller', 'handler', 'endpoint', 'route', 'router', 'dispatch'] },
    { symbol: 'Mw', name: 'middleware',block: 'pattern', period: 5, group: 15, triggers: ['middleware', 'interceptor', 'filter', 'hook', 'plugin', 'extension', 'pipe'] },

    // Quality: observability
    { symbol: 'Mt', name: 'monitor',   block: 'quality', period: 5, group: 16, triggers: ['monitor', 'watch', 'observe', 'track', 'alert', 'notify', 'health'] },
    { symbol: 'Tc', name: 'trace',     block: 'quality', period: 5, group: 17, triggers: ['trace', 'span', 'telemetry', 'opentelemetry', 'jaeger', 'zipkin', 'correlate'] },
    { symbol: 'Au', name: 'audit',     block: 'quality', period: 5, group: 18, triggers: ['audit', 'compliance', 'policy', 'rule', 'governance', 'regulation'] },

    // ═══════════════════════════════════════════════════════════════
    // PERIOD 6 — Meta / application-level
    // ═══════════════════════════════════════════════════════════════

    // Substance: configuration / state
    { symbol: 'Cf', name: 'config',    block: 'substance', period: 6, group: 1,  triggers: ['config', 'configuration', 'settings', 'options', 'preferences', 'env', 'dotenv'] },
    { symbol: 'Sa', name: 'state',     block: 'substance', period: 6, group: 2,  triggers: ['state', 'store', 'redux', 'context', 'atom', 'signal', 'reactive', 'observable'] },
    { symbol: 'Ch', name: 'cache',     block: 'substance', period: 6, group: 3,  triggers: ['cache', 'memoize', 'memo', 'lru', 'ttl', 'invalidate', 'stale', 'fresh'] },
    { symbol: 'Ss', name: 'session',   block: 'substance', period: 6, group: 4,  triggers: ['session', 'cookie', 'token', 'jwt', 'oauth', 'credential', 'identity'] },
    { symbol: 'Mg', name: 'message',   block: 'substance', period: 6, group: 5,  triggers: ['message', 'payload', 'packet', 'frame', 'envelope', 'body', 'header'] },
    { symbol: 'Sh', name: 'schema',    block: 'substance', period: 6, group: 6,  triggers: ['schema', 'model', 'entity', 'dto', 'migration', 'seed', 'fixture'] },

    // Action: application operations
    { symbol: 'Au', name: 'auth',      block: 'action', period: 6, group: 7,  triggers: ['auth', 'login', 'logout', 'signup', 'register', 'password', 'permission', 'role', 'acl'] },
    { symbol: 'Rn', name: 'render',    block: 'action', period: 6, group: 8,  triggers: ['render', 'draw', 'paint', 'display', 'show', 'dom', 'html', 'css', 'canvas', 'webgl'] },
    { symbol: 'Nt', name: 'navigate',  block: 'action', period: 6, group: 9,  triggers: ['navigate', 'route', 'redirect', 'link', 'href', 'url', 'path', 'history'] },
    { symbol: 'Up', name: 'upload',    block: 'action', period: 6, group: 10, triggers: ['upload', 'download', 'transfer', 'sync', 'backup', 'restore', 'migrate'] },
    { symbol: 'Ny', name: 'notify',    block: 'action', period: 6, group: 11, triggers: ['notify', 'alert', 'toast', 'modal', 'dialog', 'prompt', 'confirm', 'message'] },
    { symbol: 'Dy', name: 'deploy',    block: 'action', period: 6, group: 12, triggers: ['deploy', 'build', 'compile', 'bundle', 'package', 'release', 'publish', 'ship'] },

    // Pattern: architectural patterns
    { symbol: 'Ob', name: 'observer',  block: 'pattern', period: 6, group: 13, triggers: ['observer', 'observable', 'subscribe', 'unsubscribe', 'subject', 'pubsub'] },
    { symbol: 'Fc', name: 'factory',   block: 'pattern', period: 6, group: 14, triggers: ['factory', 'builder', 'creator', 'provider', 'injector', 'container', 'di'] },
    { symbol: 'Px', name: 'proxy',     block: 'pattern', period: 6, group: 15, triggers: ['proxy', 'adapter', 'wrapper', 'decorator', 'facade', 'bridge', 'gateway'] },

    // Quality: delivery
    { symbol: 'Ci', name: 'ci',        block: 'quality', period: 6, group: 16, triggers: ['ci', 'cd', 'pipeline', 'workflow', 'action', 'jenkins', 'github', 'gitlab'] },
    { symbol: 'Dc', name: 'docs',      block: 'quality', period: 6, group: 17, triggers: ['doc', 'docs', 'readme', 'comment', 'jsdoc', 'javadoc', 'docstring', 'annotation'] },
    { symbol: 'Vn', name: 'version',   block: 'quality', period: 6, group: 18, triggers: ['version', 'semver', 'changelog', 'release', 'tag', 'branch', 'git', 'commit', 'diff'] },

    // ═══════════════════════════════════════════════════════════════
    // PERIOD 7 — Control flow (separate block, like lanthanides)
    // ═══════════════════════════════════════════════════════════════

    { symbol: 'Lp', name: 'loop',      block: 'action', period: 7, group: 1,  triggers: ['for', 'while', 'loop', 'foreach', 'iterate', 'repeat', 'do', 'until'] },
    { symbol: 'Br', name: 'branch',    block: 'action', period: 7, group: 2,  triggers: ['if', 'else', 'switch', 'case', 'branch', 'condition', 'ternary', 'when'] },
    { symbol: 'Rc', name: 'recurse',   block: 'action', period: 7, group: 3,  triggers: ['recurse', 'recursive', 'recursion', 'self', 'tail', 'trampoline'] },
    { symbol: 'It', name: 'iterate',   block: 'action', period: 7, group: 4,  triggers: ['iterate', 'iterator', 'generator', 'yield', 'next', 'done', 'iterable'] },
    { symbol: 'Tv', name: 'traverse',  block: 'action', period: 7, group: 5,  triggers: ['traverse', 'walk', 'visit', 'dfs', 'bfs', 'crawl', 'scan'] },
    { symbol: 'Pp', name: 'pipe',      block: 'action', period: 7, group: 6,  triggers: ['pipe', 'compose', 'chain', 'then', 'pipeline', 'sequence', 'flow'] },
    { symbol: 'Th', name: 'throw',     block: 'action', period: 7, group: 7,  triggers: ['throw', 'raise', 'panic', 'abort', 'bail', 'crash', 'fatal'] },
    { symbol: 'Ca', name: 'catch',     block: 'action', period: 7, group: 8,  triggers: ['catch', 'rescue', 'recover', 'handle', 'fallback', 'retry', 'resilient'] },
    { symbol: 'Wt', name: 'wait',      block: 'action', period: 7, group: 9,  triggers: ['wait', 'sleep', 'pause', 'block', 'suspend', 'idle', 'pending'] },
    { symbol: 'Sp', name: 'spawn',     block: 'action', period: 7, group: 10, triggers: ['spawn', 'fork', 'clone', 'thread', 'goroutine', 'coroutine', 'fiber'] },
    { symbol: 'Lk', name: 'lock',      block: 'action', period: 7, group: 11, triggers: ['lock', 'unlock', 'mutex', 'semaphore', 'atomic', 'cas', 'barrier', 'fence'] },
    { symbol: 'Sg', name: 'signal',    block: 'action', period: 7, group: 12, triggers: ['signal', 'interrupt', 'notify', 'wake', 'condition', 'channel', 'select'] },

    // ═══════════════════════════════════════════════════════════════
    // PERIOD 8 — Domain concerns (separate block, like actinides)
    // ═══════════════════════════════════════════════════════════════

    { symbol: 'Ui', name: 'ui',        block: 'domain', period: 8, group: 1,  triggers: ['ui', 'ux', 'component', 'widget', 'button', 'input', 'form', 'layout', 'view'] },
    { symbol: 'Ap', name: 'api',       block: 'domain', period: 8, group: 2,  triggers: ['api', 'rest', 'graphql', 'grpc', 'rpc', 'endpoint', 'swagger', 'openapi'] },
    { symbol: 'Dt', name: 'data',      block: 'domain', period: 8, group: 3,  triggers: ['data', 'dataset', 'record', 'entity', 'model', 'orm', 'dao', 'repository'] },
    { symbol: 'Sc', name: 'security',  block: 'domain', period: 8, group: 4,  triggers: ['security', 'xss', 'csrf', 'cors', 'sanitize', 'escape', 'firewall', 'tls', 'ssl'] },
    { symbol: 'Pf', name: 'perf',      block: 'domain', period: 8, group: 5,  triggers: ['perf', 'performance', 'optimize', 'cache', 'lazy', 'eager', 'batch', 'bulk', 'fast'] },
    { symbol: 'Ac', name: 'access',    block: 'domain', period: 8, group: 6,  triggers: ['accessibility', 'a11y', 'aria', 'screen', 'reader', 'keyboard', 'focus', 'tab'] },
    { symbol: 'I8', name: 'i18n',      block: 'domain', period: 8, group: 7,  triggers: ['i18n', 'l10n', 'locale', 'translate', 'language', 'rtl', 'ltr', 'intl'] },
    { symbol: 'Tl', name: 'tooling',   block: 'domain', period: 8, group: 8,  triggers: ['webpack', 'vite', 'esbuild', 'rollup', 'babel', 'typescript', 'eslint', 'prettier'] },
    { symbol: 'Cl', name: 'cloud',     block: 'domain', period: 8, group: 9,  triggers: ['cloud', 'aws', 'gcp', 'azure', 'lambda', 'serverless', 'container', 'docker', 'k8s'] },
    { symbol: 'Ml', name: 'ml',        block: 'domain', period: 8, group: 10, triggers: ['ml', 'ai', 'model', 'train', 'predict', 'neural', 'tensor', 'embedding', 'inference'] },
    { symbol: 'Gx', name: 'graphics',  block: 'domain', period: 8, group: 11, triggers: ['graphics', 'webgl', 'canvas', 'shader', 'texture', 'mesh', 'render', 'gpu', 'pixel'] },
    { symbol: 'An', name: 'animation', block: 'domain', period: 8, group: 12, triggers: ['animation', 'animate', 'tween', 'ease', 'keyframe', 'transition', 'motion', 'frame'] },
];

// ─── HELPERS ────────────────────────────────────────────────────────
// All helpers accept a word set (elements array) so they work on
// the full table, a subset, or a completely custom vocabulary.

/**
 * Build a fast lookup: trigger_token → [element, ...]
 * @param {Array} words - array of elements (defaults to full table)
 */
export function buildTriggerIndex(words = ELEMENTS) {
    const index = new Map();
    for (const element of words) {
        for (const trigger of element.triggers) {
            const lower = trigger.toLowerCase();
            if (!index.has(lower)) {
                index.set(lower, []);
            }
            index.get(lower).push(element);
        }
    }
    return index;
}

/**
 * Get the max period and group numbers for layout calculations
 * @param {Array} words - array of elements (defaults to full table)
 */
export function getTableDimensions(words = ELEMENTS) {
    let maxPeriod = 0;
    let maxGroup = 0;
    for (const el of words) {
        maxPeriod = Math.max(maxPeriod, el.period);
        maxGroup = Math.max(maxGroup, el.group);
    }
    return { periods: maxPeriod, groups: maxGroup };
}

/**
 * Get color for an element based on its block and an optional intensity
 */
export function getElementColor(element, intensity = 0) {
    const block = BLOCKS[element.block];
    if (!block) return { r: 0.3, g: 0.3, b: 0.3 };

    // Base: dim version of block color
    const dim = 0.15;
    const base = {
        r: block.color.r * dim,
        g: block.color.g * dim,
        b: block.color.b * dim,
    };

    if (intensity <= 0) return base;

    // Interpolate toward full color based on intensity (0-1)
    const t = Math.min(intensity, 1.0);
    return {
        r: base.r + (block.color.r - base.r) * t,
        g: base.g + (block.color.g - base.g) * t,
        b: base.b + (block.color.b - base.b) * t,
    };
}

/**
 * Filter a word set by block(s)
 * @param {Array} words - source elements
 * @param {string|string[]} blocks - block name(s) to keep
 */
export function filterByBlock(words, blocks) {
    const set = Array.isArray(blocks) ? new Set(blocks) : new Set([blocks]);
    return words.filter(w => set.has(w.block));
}

/**
 * Get just the word names from a set — useful for LLM prompts
 * @param {Array} words - array of elements
 */
export function wordNames(words = ELEMENTS) {
    return words.map(w => w.name);
}

export default { ELEMENTS, BLOCKS, buildTriggerIndex, getTableDimensions, getElementColor, filterByBlock, wordNames };
