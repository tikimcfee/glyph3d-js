/**
 * ViewerAPI - public facade for programmatic control of the 3D viewer.
 *
 * Exposed as `window.viewer` for devtools, agent, and script access.
 * Wraps the CommandRouter for both string and structured API usage.
 *
 * Usage from devtools:
 *   await viewer.exec('camera.info')          // string command
 *   await viewer.select('src/index.js')       // typed method
 *   viewer.status()                           // convenience
 *   viewer.commands()                         // list all commands
 */

export default class ViewerAPI {
    /**
     * @param {import('./CommandRouter.js').default} router
     * @param {Object} [context] - optional direct context reference
     */
    constructor(router, context) {
        this._router = router;
        this._context = context;
    }

    // ============ Raw Command Access ============

    /**
     * Execute a command string and return the full result.
     * @param {string} input - e.g. "camera.move 0 50 100"
     * @returns {Promise<{text: string, data: any}>}
     */
    async exec(input) {
        return this._router.execute(input);
    }

    /**
     * Execute a command and return just the text response.
     * Useful for console testing.
     * @param {string} input
     * @returns {Promise<string>}
     */
    async run(input) {
        const result = await this._router.execute(input);
        return result.text;
    }

    /**
     * Execute a batch of commands sequentially.
     * @param {string[]} commands
     * @returns {Promise<Array<{text: string, data: any}>>}
     */
    async batch(commands) {
        return this._router.executeBatch(commands);
    }

    // ============ Discovery ============

    /**
     * List all available commands.
     * @returns {Array<{name: string, description: string, usage: string}>}
     */
    commands() {
        return this._router.listCommands();
    }

    /**
     * List commands in a namespace.
     * @param {string} ns - e.g. "camera"
     */
    namespace(ns) {
        return this._router.listNamespace(ns);
    }

    /**
     * Print help to console (convenience).
     */
    help() {
        const cmds = this._router.listCommands();
        console.group('Viewer Commands');
        for (const c of cmds) {
            const usage = c.usage ? ` ${c.usage}` : '';
            console.log(`  ${c.name}${usage}  --  ${c.description}`);
        }
        console.groupEnd();
        return `${cmds.length} commands available. Use viewer.exec('command') or viewer.run('command')`;
    }

    // ============ Typed Convenience Methods ============

    /**
     * Get scene/viewer status.
     * @returns {Promise<Object>}
     */
    async status() {
        return (await this._router.execute('status')).data;
    }

    // -- Camera --

    /**
     * Move camera to position.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    async cameraMove(x, y, z) {
        return (await this._router.execute(`camera.move ${x} ${y} ${z}`)).data;
    }

    /**
     * Focus camera on a grid by index or filename.
     * @param {string|number} target
     */
    async cameraFocus(target) {
        return (await this._router.execute(`camera.focus ${target}`)).data;
    }

    /**
     * Get camera info.
     */
    async cameraInfo() {
        return (await this._router.execute('camera.info')).data;
    }

    /**
     * Reset camera to default.
     */
    async cameraReset() {
        return (await this._router.execute('camera.reset')).data;
    }

    /**
     * Fit all grids in view.
     */
    async cameraFitAll() {
        return (await this._router.execute('camera.fitall')).data;
    }

    // -- Selection --

    /**
     * Select a file by path.
     * @param {string} path
     */
    async select(path) {
        return (await this._router.execute(`select ${path}`)).data;
    }

    /**
     * Add a file to the selection.
     * @param {string} path
     */
    async selectAdd(path) {
        return (await this._router.execute(`select.add ${path}`)).data;
    }

    /**
     * Clear selection.
     */
    async selectClear() {
        return (await this._router.execute('select.clear')).data;
    }

    /**
     * Get selected files.
     */
    async selectList() {
        return (await this._router.execute('select.list')).data;
    }

    // -- Grids --

    /**
     * List all grids.
     */
    async gridList() {
        return (await this._router.execute('grid.list')).data;
    }

    /**
     * Get grid details by index.
     * @param {number} index
     */
    async gridInfo(index) {
        return (await this._router.execute(`grid.info ${index}`)).data;
    }

    // -- Search --

    /**
     * Search files by name.
     * @param {string} query
     */
    async search(query) {
        return (await this._router.execute(`search ${query}`)).data;
    }

    // -- Scene --

    /**
     * Get scene info.
     */
    async sceneInfo() {
        return (await this._router.execute('scene.info')).data;
    }

    // -- Layout --

    /**
     * Get layout info.
     */
    async layoutInfo() {
        return (await this._router.execute('layout.info')).data;
    }

    // ============ WebSocket Info ============

    /**
     * Get WebSocket connection info (if bridge is available).
     * @returns {Object|null}
     */
    connectionInfo() {
        if (this._context && this._context.wsbridge) {
            return this._context.wsbridge.getConnectionInfo();
        }
        return null;
    }
}
