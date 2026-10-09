/*
 * Letter IRL card host bridge (#474).
 *
 * One small object, window.letterIrlHost, that a card uses instead of talking
 * to its host directly, so the same card works wherever it is shown:
 *
 * - In ChatGPT it wraps window.openai exactly as the cards always used it, so
 *   ChatGPT's proven path does not change.
 * - Everywhere else (Claude, VS Code) it speaks MCP Apps (spec 2026-01-26):
 *   JSON-RPC 2.0 over postMessage with the frame's parent. It sends
 *   ui/initialize, then ui/notifications/initialized. It receives the tool's
 *   input and result and changes to the host's context. It calls tools
 *   (tools/call), opens links (ui/open-link) and sends a chat message
 *   (ui/message). It reports its height, and it answers ping and
 *   ui/resource-teardown.
 *
 * The server inlines this file into each card that asks for it, in place of
 * the card's letter-irl:host marker comment (src/mcp/widgetHost.ts), so a
 * card stays a single self-contained page.
 *
 * What MCP Apps has no equivalent for: widgetState (a card keeps its state on
 * the server instead), ChatGPT's file store, and openExternal's redirectUrl.
 *
 * Display modes (#662): a card that can be shown larger lists its modes on
 * its <html data-display-modes="inline fullscreen">. It then reads
 * displayMode() and, where the host offers one of those modes, asks for it
 * with requestDisplayMode(mode), which answers { mode } with the mode given.
 * A card without the attribute declares none and is offered none.
 *
 * Plugin Extensions in ChatGPT (#665): model context (ui/update-model-context)
 * and deep links (hostContext["openai/deepLink"]) are MCP Apps features that
 * window.openai does not carry. A card that needs them says so on its
 * <html data-plugin-extensions>, and in ChatGPT the bridge then also opens the
 * MCP Apps handshake with the host. Only those two come from it; everything
 * else stays on window.openai. A host that never answers changes nothing.
 */
(function () {
  "use strict";

  var listeners = [];
  function changed() {
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i]();
      } catch (error) {
        console.error("letterIrlHost listener failed", error);
      }
    }
  }
  function onChange(listener) {
    listeners.push(listener);
  }

  var DISPLAY_MODES = ["inline", "fullscreen", "pip"];
  var cardModes = (document.documentElement.getAttribute("data-display-modes") || "")
    .split(/\s+/)
    .filter(function (mode) { return DISPLAY_MODES.indexOf(mode) !== -1; });

  // ChatGPT: window.openai is there before the page runs.
  if (window.openai) {
    // Read at the moment of use, as the cards always read it: ChatGPT sets
    // globals, and can add a plan-gated call such as selectFiles, after the
    // page has loaded.
    var openai = function () { return window.openai || {}; };
    // Values come back exactly as ChatGPT gives them, null or undefined
    // included, so a card can still tell "no result yet" from an empty one.
    var chatgpt = {
      kind: "chatgpt",
      theme: function () { return openai().theme || "light"; },
      toolInput: function () { return openai().toolInput; },
      toolOutput: function () { return openai().toolOutput; },
      toolMeta: function () { return openai().toolResponseMetadata; },
      widgetState: function () { return openai().widgetState; },
      hostContext: function () { return openai().hostContext || {}; },
      displayMode: function () { return openai().displayMode; },
      onChange: onChange
    };
    // Each capability exists only while window.openai has it, so a card's
    // "can this host do X?" check keeps its meaning, asked afresh each time.
    var capability = function (name, method, call) {
      Object.defineProperty(chatgpt, name, {
        enumerable: true,
        get: function () {
          var api = openai();
          if (typeof api[method] !== "function") return undefined;
          return function (a, b) { return call(api, a, b); };
        }
      });
    };
    capability("callTool", "callTool", function (api, name, args) { return api.callTool(name, args || {}); });
    capability("openLink", "openExternal", function (api, url) { return api.openExternal({ href: url }); });
    capability("sendMessage", "sendFollowUpMessage", function (api, text) { return api.sendFollowUpMessage({ prompt: text }); });
    capability("setWidgetState", "setWidgetState", function (api, value) { return api.setWidgetState(value); });
    // ChatGPT's own call if it has one; else the MCP Apps request, once the handshake says the host takes it (#665).
    var extensions = null;
    Object.defineProperty(chatgpt, "updateModelContext", {
      enumerable: true,
      get: function () {
        var api = openai();
        if (typeof api.updateModelContext === "function") return function (value) { return api.updateModelContext(value); };
        var caps = extensions && extensions.capabilities;
        var offered = caps && ((caps.updateModelContext && caps.updateModelContext.text) || (caps.experimental && caps.experimental["openai/modelContext"]));
        if (!offered) return undefined;
        return function (value) { return extensions.request("ui/update-model-context", value); };
      }
    });
    // Only for a card that lists the mode it asks for (#662).
    Object.defineProperty(chatgpt, "requestDisplayMode", {
      enumerable: true,
      get: function () {
        var api = openai();
        if (typeof api.requestDisplayMode !== "function" || cardModes.length < 2) return undefined;
        return function (mode) {
          if (cardModes.indexOf(mode) === -1) return Promise.reject(new Error("This card does not offer " + mode));
          return api.requestDisplayMode({ mode: mode });
        };
      }
    });
    // ChatGPT's file store: no MCP Apps equivalent (#474).
    capability("uploadFile", "uploadFile", function (api, file) { return api.uploadFile(file); });
    capability("selectFiles", "selectFiles", function (api) { return api.selectFiles(); });
    capability("getFileDownloadUrl", "getFileDownloadUrl", function (api, request) { return api.getFileDownloadUrl(request); });
    window.letterIrlHost = chatgpt;
    window.addEventListener("openai:set_globals", changed);
    if (document.documentElement.hasAttribute("data-plugin-extensions") && window.parent && window.parent !== window) {
      extensions = openExtensions(window.parent);
      // The deep link (and anything else the handshake says) over window.openai's own host context.
      chatgpt.hostContext = function () { return Object.assign({}, openai().hostContext || {}, extensions.hostContext); };
    }
    return;
  }

  // The MCP Apps handshake beside window.openai, for model context and deep links only (#665).
  function openExtensions(host) {
    var pending = {};
    var nextId = 1;
    var link = { capabilities: null, hostContext: {} };
    function post(message) {
      message.jsonrpc = "2.0";
      host.postMessage(message, "*");
    }
    link.request = function (method, params) {
      var id = nextId;
      nextId += 1;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        post({ id: id, method: method, params: params });
      });
    };
    window.addEventListener("message", function (event) {
      if (event.source !== host) return;
      var message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method === undefined && message.id !== undefined) {
        var waiting = pending[message.id];
        if (!waiting) return;
        delete pending[message.id];
        if (message.error) waiting.reject(new Error((message.error && message.error.message) || "The host refused the request"));
        else waiting.resolve(message.result);
        return;
      }
      if (message.method === "ui/notifications/host-context-changed") {
        if (message.params && typeof message.params === "object") Object.assign(link.hostContext, message.params);
        changed();
      } else if ((message.method === "ping" || message.method === "ui/resource-teardown") && message.id !== undefined) {
        post({ id: message.id, result: {} });
      }
      // Tool input and results stay window.openai's: nothing else is taken from here.
    });
    link.request("ui/initialize", {
      appInfo: { name: "letter-irl-card", version: "1.0.0" },
      appCapabilities: cardModes.length > 0 ? { availableDisplayModes: cardModes } : {},
      protocolVersion: "2026-01-26"
    }).then(
      function (result) {
        link.capabilities = (result && result.hostCapabilities) || {};
        if (result && result.hostContext && typeof result.hostContext === "object") Object.assign(link.hostContext, result.hostContext);
        post({ method: "ui/notifications/initialized", params: {} });
        changed();
      },
      function () { /* Not answered as an MCP Apps host: window.openai alone, as before. */ }
    );
    return link;
  }

  // MCP Apps: the host is the frame's parent. A page that is not framed has no
  // host to talk to, and must not answer its own messages.
  var parent = window.parent;
  var framed = Boolean(parent) && parent !== window;
  // Null until the host sends them, as window.openai's are before a result.
  var state = { theme: "light", toolInput: null, toolOutput: null, toolMeta: null, hostContext: {}, capabilities: {} };
  var pending = {};
  var nextId = 1;
  var initialized = false;

  function post(message) {
    if (!framed) return;
    message.jsonrpc = "2.0";
    parent.postMessage(message, "*");
  }

  function request(method, params) {
    if (!framed) return Promise.reject(new Error("Letter IRL card has no host"));
    var id = nextId;
    nextId += 1;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      post({ id: id, method: method, params: params });
    });
  }

  function applyHostContext(context) {
    if (context && typeof context === "object") Object.assign(state.hostContext, context);
    if (context && (context.theme === "dark" || context.theme === "light")) {
      state.theme = context.theme;
    }
  }

  window.addEventListener("message", function (event) {
    if (!framed || event.source !== parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;

    // A reply to one of our requests.
    if (message.method === undefined && message.id !== undefined) {
      var waiting = pending[message.id];
      if (!waiting) return;
      delete pending[message.id];
      if (message.error) {
        waiting.reject(new Error((message.error && message.error.message) || "The host refused the request"));
      } else {
        waiting.resolve(message.result);
      }
      return;
    }

    var params = message.params || {};
    switch (message.method) {
      case "ui/notifications/tool-input":
        state.toolInput = params.arguments || null;
        changed();
        break;
      case "ui/notifications/tool-result":
        state.toolOutput = params.structuredContent || null;
        state.toolMeta = params._meta || null;
        changed();
        break;
      case "ui/notifications/host-context-changed":
        applyHostContext(params);
        changed();
        break;
      case "ping":
      case "ui/resource-teardown":
        post({ id: message.id, result: {} });
        break;
      default:
        // A request we do not serve gets an error, never silence; a
        // notification we do not use (tool-input-partial, tool-cancelled)
        // needs no answer.
        if (message.id !== undefined) {
          post({ id: message.id, error: { code: -32601, message: "Method not found" } });
        }
    }
  });

  var lastHeight = 0;
  function reportHeight() {
    if (!initialized) return;
    var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      post({ method: "ui/notifications/size-changed", params: { height: height } });
    }
  }

  // No setWidgetState and no file store here: MCP Apps has neither, and a card
  // checks for them before using them.
  window.letterIrlHost = {
    kind: "mcp-apps",
    theme: function () { return state.theme; },
    toolInput: function () { return state.toolInput; },
    toolOutput: function () { return state.toolOutput; },
    toolMeta: function () { return state.toolMeta; },
    widgetState: function () { return null; },
    hostContext: function () { return state.hostContext; },
    displayMode: function () { return state.hostContext.displayMode; },
    callTool: function (name, args) {
      return request("tools/call", { name: name, arguments: args || {} });
    },
    openLink: function (url) { return request("ui/open-link", { url: url }); },
    sendMessage: function (text) {
      return request("ui/message", { role: "user", content: [{ type: "text", text: text }] });
    },
    onChange: onChange
  };

  // A mode the card lists and the host offers, besides inline (#662).
  function offeredModes() {
    var host = state.hostContext.availableDisplayModes;
    if (!Array.isArray(host)) return [];
    return cardModes.filter(function (mode) { return mode !== "inline" && host.indexOf(mode) !== -1; });
  }
  Object.defineProperty(window.letterIrlHost, "requestDisplayMode", {
    get: function () {
      if (offeredModes().length === 0) return undefined;
      return function (mode) {
        if (mode !== "inline" && offeredModes().indexOf(mode) === -1) return Promise.reject(new Error("The host does not offer " + mode));
        return request("ui/request-display-mode", { mode: mode });
      };
    }
  });

  Object.defineProperty(window.letterIrlHost, "updateModelContext", {
    get: function () {
      if (!state.capabilities.updateModelContext || !state.capabilities.updateModelContext.text) return undefined;
      return function (value) { return request("ui/update-model-context", value); };
    }
  });

  if (!framed) return;

  request("ui/initialize", {
    appInfo: { name: "letter-irl-card", version: "1.0.0" },
    appCapabilities: cardModes.length > 0 ? { availableDisplayModes: cardModes } : {},
    protocolVersion: "2026-01-26"
  }).then(
    function (result) {
      state.capabilities = (result && result.hostCapabilities) || {};
      applyHostContext(result && result.hostContext);
      initialized = true;
      post({ method: "ui/notifications/initialized", params: {} });
      changed();
      reportHeight();
    },
    function (error) {
      console.error("letterIrlHost: the host refused ui/initialize", error);
    }
  );

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(reportHeight).observe(document.documentElement);
  }
})();
