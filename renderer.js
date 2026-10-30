// CssOverride - TwinCAT UI Client extension (renderer script)
//
// The UI Client wraps this file in a block in which the constant
// __extensionName holds the external name of the extension, and executes it in
// the page itself after the DOM has loaded and the tcuiclient namespace is
// available. Everything here therefore runs with the privileges of the
// displayed page: no Node.js, but full access to the DOM.
//
// The CSS itself comes from the extension process (main.js), which reads it
// from disk and notifies us when it changes.

(() => {
    "use strict";

    const extensionName = typeof __extensionName === "string"
        ? __extensionName
        : "CssOverride";

    const STYLE_ELEMENT_ID = `tc-${extensionName}-style`;

    // The extension host rejects messages while the extension is still
    // starting up, so the first request is retried a few times.
    const RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];

    // Only used when per-URL rules are configured, to notice the in-page
    // navigation of a single page application such as the TwinCAT HMI.
    const URL_POLL_INTERVAL_MS = 1000;

    const api = window.tcuiclient;

    if (!api) {
        console.error(`[${extensionName}] the tcuiclient API is not available`);
        return;
    }

    // Guard against the script being executed twice for the same document.
    if (window[`__${extensionName}`]) {
        window[`__${extensionName}`].refresh();
        return;
    }

    let sheet = null;
    let styleElement = null;
    let observer = null;
    let urlPollTimer = null;
    let lastUrl = location.href;
    let method = "none";

    // Preferred way to inject: a constructed stylesheet is applied after all
    // stylesheets of the document, so its rules win over the page's own rules
    // of equal specificity, and it is not affected by a Content-Security-Policy
    // that forbids inline style elements.
    function applyViaAdoptedStyleSheet(css) {
        if (!sheet) {
            sheet = new CSSStyleSheet();
        }

        sheet.replaceSync(css);

        if (!document.adoptedStyleSheets.includes(sheet)) {
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        }

        return "adoptedStyleSheets";
    }

    // Fallback for documents where constructed stylesheets are unavailable.
    // The element is kept as the last child of <head> so that stylesheets the
    // page adds later do not take precedence over it.
    function applyViaStyleElement(css) {
        if (!styleElement || !styleElement.isConnected) {
            styleElement = document.getElementById(STYLE_ELEMENT_ID);
        }

        if (!styleElement) {
            styleElement = document.createElement("style");
            styleElement.id = STYLE_ELEMENT_ID;
            styleElement.setAttribute("type", "text/css");
        }

        styleElement.textContent = css;

        const parent = document.head || document.documentElement;

        if (styleElement.parentNode !== parent || parent.lastElementChild !== styleElement) {
            parent.appendChild(styleElement);
        }

        if (!observer) {
            observer = new MutationObserver(() => {
                const head = document.head || document.documentElement;

                if (styleElement && head.lastElementChild !== styleElement) {
                    head.appendChild(styleElement);
                }
            });

            observer.observe(document.head || document.documentElement, { childList: true });
        }

        return "styleElement";
    }

    // Number of rules of the injected stylesheet as the browser parsed them.
    function ruleCount() {
        try {
            if (sheet) {
                return sheet.cssRules.length;
            }

            return styleElement && styleElement.sheet ? styleElement.sheet.cssRules.length : 0;
        } catch {
            return -1;
        }
    }

    function apply(css) {
        try {
            return applyViaAdoptedStyleSheet(css);
        } catch (error) {
            console.warn(`[${extensionName}] falling back to a style element: ${error.message}`);
            return applyViaStyleElement(css);
        }
    }

    // Starts or stops watching for in-page navigation, depending on whether
    // the applied CSS depends on the URL at all.
    function setUrlWatching(enabled) {
        if (enabled && !urlPollTimer) {
            urlPollTimer = setInterval(() => {
                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    refresh();
                }
            }, URL_POLL_INTERVAL_MS);
        } else if (!enabled && urlPollTimer) {
            clearInterval(urlPollTimer);
            urlPollTimer = null;
        }
    }

    // Asks the extension process for the CSS of the current URL and applies
    // it. An empty result clears the override again.
    async function refresh({ retry = false } = {}) {
        const delays = retry ? RETRY_DELAYS_MS : [];
        let lastError = null;

        for (let attempt = 0; attempt <= delays.length; attempt += 1) {
            try {
                lastUrl = location.href;

                /* eslint-disable-next-line no-await-in-loop */
                const payload = await api.postMessage(`${extensionName}.getCss`, { url: lastUrl });
                const css = payload && payload.enabled ? payload.css || "" : "";

                method = apply(css);
                setUrlWatching(Boolean(payload && payload.urlDependent));

                // Report back so that the result is visible in the log file of
                // the extension.
                api.postMessage(`${extensionName}.report`, {
                    url: lastUrl,
                    bytes: css.length,

                    // Number of rules the browser actually parsed, which is 0
                    // if the CSS is invalid or the injection was blocked.
                    rules: ruleCount(),
                    method,
                    sources: (payload && payload.sources) || []
                }).catch(() => {
                    // A failed report must not affect the override
                });

                return payload;
            } catch (error) {
                lastError = error;

                if (attempt < delays.length) {
                    /* eslint-disable-next-line no-await-in-loop */
                    await new Promise(resolve => setTimeout(resolve, delays[attempt]));
                }
            }
        }

        console.error(`[${extensionName}] could not load the CSS: ${lastError && lastError.message}`);
        return null;
    }

    // Fired by the extension process when a CSS file changed on disk or the
    // override was switched on or off.
    api.on(`${extensionName}.cssChanged`, () => refresh());

    // Fired when the extension process has (re)started.
    api.on(`${extensionName}.ready`, () => refresh({ retry: true }));

    // Small handle for experimenting in the developer tools.
    window[`__${extensionName}`] = {
        refresh,
        apply,
        clear: () => apply(""),
        toggle: enabled => api.postMessage(`${extensionName}.toggle`,
            typeof enabled === "boolean" ? { enabled } : {}),
        reload: () => api.postMessage(`${extensionName}.reload`, { url: location.href }),
        get method() {
            return method;
        },
        get css() {
            if (sheet) {
                return [...sheet.cssRules].map(rule => rule.cssText).join("\n");
            }

            return styleElement ? styleElement.textContent : "";
        }
    };

    refresh({ retry: true });
})();
