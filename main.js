"use strict";

// CssOverride - TwinCAT UI Client extension (extension process)
//
// This file is the 'entryPoint' of the extension. It is loaded by
// extension-template.js and runs as a Node.js child process of the extension
// host, so it has full Node.js access but no access to the DOM.
//
// It owns the CSS on disk: it reads the configured files, decides which of
// them apply to the URL currently shown in the renderer, watches them for
// changes and tells the renderer script to re-apply them without a reload.
// The renderer script (renderer.js) does the actual injection.

const fs = require("fs");
const path = require("path");

// Options are taken from the "options" object of this extension in the
// config.json of the UI Client and merged over these defaults.
const DEFAULT_OPTIONS = {
    // CSS files applied to every page, relative to the extension directory
    cssFiles: ["css/default.css"],

    // Per-URL rules: { match: "<pattern with * and ?>", files: [...], css: "..." }
    rules: [],

    // Re-apply automatically when a CSS file changes on disk
    watch: true,

    // Start with the override active
    enabled: true,

    // Diagnostic log inside the extension directory (null disables it)
    logFile: "cssoverride.log"
};

const MAX_LOG_SIZE = 256 * 1024;
const WATCH_DEBOUNCE_MS = 150;

// Translates a URL pattern with * and ? wildcards into a regular expression
// anchored at both ends.
function patternToRegExp(pattern) {
    const escaped = String(pattern).
        replace(/[.+^${}()|[\]\\]/gu, "\\$&").
        replace(/\*/gu, ".*").
        replace(/\?/gu, ".");

    return new RegExp(`^${escaped}$`, "iu");
}

function toArray(value) {
    if (typeof value === "undefined" || value === null) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
}

class CssOverride {
    #options = { ...DEFAULT_OPTIONS };

    #enabled = true;

    #watchers = [];

    #debounceTimer = null;

    // Called by extension-template.js with the "options" object from the
    // config.json of the UI Client.
    async onStartup(options) {
        this.#options = { ...DEFAULT_OPTIONS, ...(options || {}) };
        this.#enabled = this.#options.enabled !== false;

        this.#log(`started in ${process.cwd()}`);
        this.#log(`cssFiles=${JSON.stringify(toArray(this.#options.cssFiles))} `
            + `rules=${toArray(this.#options.rules).length} `
            + `watch=${Boolean(this.#options.watch)} enabled=${this.#enabled}`);

        if (this.#options.watch) {
            this.#startWatching();
        }

        this.#updateMenu();
    }

    // Called by extension-template.js when the process exits. Must be
    // synchronous.
    onShutdown() {
        this.#stopWatching();
        this.#log("stopped");
    }

    // Called for messages sent by the renderer script via
    // tcuiclient.postMessage("<extension>.<command>", args) and for clicks on
    // the menu items declared in CssOverride.Config.json.
    async onMessage(command, args) {
        const params = args || {};

        switch (command) {
            case "getCss":
                return this.#buildPayload(params.url);

            case "reload":
                this.#log("reload requested");
                this.#emitChanged("reloaded");
                return this.#buildPayload(params.url);

            case "toggle":
                this.#enabled = typeof params.enabled === "boolean"
                    ? params.enabled
                    : !this.#enabled;
                this.#log(`override ${this.#enabled ? "enabled" : "disabled"}`);
                this.#updateMenu();
                this.#emitChanged("toggled");
                return { enabled: this.#enabled };

            // Diagnostic hook: the renderer reports back what it applied so
            // that the result is visible in the log file.
            case "report":
                this.#log(`renderer applied ${params.bytes || 0} bytes / `
                    + `${typeof params.rules === "number" ? params.rules : "?"} rules via `
                    + `${params.method || "?"} for ${params.url || "?"}`
                    + `${params.sources ? ` (${params.sources.join(", ")})` : ""}`);
                return { ok: true };

            // An unhandled exception here would take the extension process
            // down, so an unknown command is only reported back.
            default:
                this.#log(`unknown command "${command}"`);
                return { error: `Unknown command "${command}"` };
        }
    }

    // Collects the CSS that applies to the given URL.
    #buildPayload(url) {
        const sources = [];
        const parts = [];

        if (this.#enabled) {
            for (const file of toArray(this.#options.cssFiles)) {
                this.#appendFile(file, sources, parts);
            }

            for (const rule of toArray(this.#options.rules)) {
                if (!this.#ruleMatches(rule, url)) {
                    continue;
                }

                for (const file of toArray(rule.files)) {
                    this.#appendFile(file, sources, parts);
                }

                if (typeof rule.css === "string" && rule.css.length > 0) {
                    sources.push(`inline:${rule.match}`);
                    parts.push(`/* CssOverride: inline css of rule "${rule.match}" */\n${rule.css}`);
                }
            }
        }

        return {
            enabled: this.#enabled,
            css: parts.join("\n\n"),
            sources,

            // Tells the renderer whether the result depends on the URL, so it
            // only has to watch for URL changes when rules are configured.
            urlDependent: toArray(this.#options.rules).length > 0
        };
    }

    #ruleMatches(rule, url) {
        if (!rule || typeof rule.match !== "string" || typeof url !== "string") {
            return false;
        }

        try {
            return patternToRegExp(rule.match).test(url);
        } catch (error) {
            this.#log(`invalid rule pattern "${rule.match}": ${error.message}`);
            return false;
        }
    }

    #appendFile(file, sources, parts) {
        const filePath = this.#resolve(file);

        try {
            const css = fs.readFileSync(filePath, "utf8");
            sources.push(file);
            parts.push(`/* CssOverride: ${file} */\n${css}`);
        } catch (error) {
            this.#log(`could not read ${filePath}: ${error.message}`);
            parts.push(`/* CssOverride: ${file} could not be read: ${error.message} */`);
        }
    }

    // Paths in the options are relative to the extension directory, which is
    // the working directory of this process.
    #resolve(file) {
        return path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    }

    // Collects every file the extension may have to read, so their
    // directories can be watched.
    #watchedFiles() {
        // A copy: toArray passes an existing array through unchanged, so
        // appending here would modify the configured cssFiles.
        const files = [...toArray(this.#options.cssFiles)];

        for (const rule of toArray(this.#options.rules)) {
            files.push(...toArray(rule.files));
        }

        return files.map(file => this.#resolve(file));
    }

    // Watches the containing directories instead of the files themselves:
    // editors that replace a file on save would break a watcher on the file.
    #startWatching() {
        const directories = new Map();

        for (const filePath of this.#watchedFiles()) {
            const directory = path.dirname(filePath);

            if (!directories.has(directory)) {
                directories.set(directory, new Set());
            }

            directories.get(directory).add(path.basename(filePath).toLowerCase());
        }

        for (const [directory, basenames] of directories) {
            try {
                const watcher = fs.watch(directory, (eventType, filename) => {
                    if (filename && !basenames.has(path.basename(filename).toLowerCase())) {
                        return;
                    }

                    this.#scheduleChange(filename || directory);
                });

                watcher.on("error", error => this.#log(`watcher for ${directory} failed: ${error.message}`));
                this.#watchers.push(watcher);
                this.#log(`watching ${directory} for ${[...basenames].join(", ")}`);
            } catch (error) {
                this.#log(`could not watch ${directory}: ${error.message}`);
            }
        }
    }

    #stopWatching() {
        if (this.#debounceTimer) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
        }

        for (const watcher of this.#watchers) {
            try {
                watcher.close();
            } catch {
                // Nothing can be done if closing the watcher fails
            }
        }

        this.#watchers = [];
    }

    // A single save often triggers several watch events, so they are
    // collapsed into one notification.
    #scheduleChange(filename) {
        if (this.#debounceTimer) {
            clearTimeout(this.#debounceTimer);
        }

        this.#debounceTimer = setTimeout(() => {
            this.#debounceTimer = null;
            this.#log(`${filename} changed`);
            this.#emitChanged("file-changed");
        }, WATCH_DEBOUNCE_MS);
    }

    // Fires the "<extension>.cssChanged" event in the renderer process. The
    // renderer then asks for the CSS of its own URL again.
    #emitChanged(reason) {
        process.send({
            cmd: "event",
            content: {
                command: "cssChanged",
                result: { reason, enabled: this.#enabled }
            }
        });
    }

    // Keeps the checkbox of the menu item in sync with the current state. The
    // menu only exists if "enableMenuBar" is true and kiosk mode is off.
    #updateMenu() {
        process.send({
            cmd: "change-menu-item-properties",
            content: {
                id: "enabled",
                properties: { checked: this.#enabled }
            }
        });
    }

    // stdout of an extension is discarded and stderr is logged as an error by
    // the UI Client, so normal diagnostics go into a file of our own.
    #log(message) {
        if (!this.#options.logFile) {
            return;
        }

        const logPath = this.#resolve(this.#options.logFile);

        try {
            if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_SIZE) {
                fs.truncateSync(logPath, 0);
            }

            fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
        } catch {
            // Logging must never take the extension down
        }
    }
}

module.exports = CssOverride;
