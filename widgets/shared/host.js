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

  // ChatGPT: window.openai is there before the page runs.
  if (window.openai) {
    var openai = window.openai;
    window.letterIrlHost = {
      kind: "chatgpt",
      theme: function () { return openai.theme || "light"; },
      toolInput: function () { return openai.toolInput || {}; },
      toolOutput: function () { return openai.toolOutput || {}; },
      toolMeta: function () { return openai.toolResponseMetadata || {}; },
      widgetState: function () { return openai.widgetState || null; },
      setWidgetState: function (state) {
        return openai.setWidgetState ? openai.setWidgetState(state) : Promise.resolve();
      },
      callTool: function (name, args) { return openai.callTool(name, args || {}); },
      openLink: function (url) { return openai.openExternal({ href: url }); },
      sendMessage: function (text) {
        return openai.sendFollowUpMessage
          ? openai.sendFollowUpMessage({ prompt: text })
          : Promise.reject(new Error("sendFollowUpMessage is not available"));
      },
      onChange: onChange
    };
    window.addEventListener("openai:set_globals", changed);
    return;
  }

  // MCP Apps: the host is the frame's parent. A page that is not framed has no
  // host to talk to, and must not answer its own messages.
  var parent = window.parent;
  var framed = Boolean(parent) && parent !== window;
  var state = { theme: "light", toolInput: {}, toolOutput: {}, toolMeta: {} };
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
        state.toolInput = params.arguments || {};
        changed();
        break;
      case "ui/notifications/tool-result":
        state.toolOutput = params.structuredContent || {};
        state.toolMeta = params._meta || {};
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

  window.letterIrlHost = {
    kind: "mcp-apps",
    theme: function () { return state.theme; },
    toolInput: function () { return state.toolInput; },
    toolOutput: function () { return state.toolOutput; },
    toolMeta: function () { return state.toolMeta; },
    widgetState: function () { return null; },
    setWidgetState: function () { return Promise.resolve(); },
    callTool: function (name, args) {
      return request("tools/call", { name: name, arguments: args || {} });
    },
    openLink: function (url) { return request("ui/open-link", { url: url }); },
    sendMessage: function (text) {
      return request("ui/message", { role: "user", content: [{ type: "text", text: text }] });
    },
    onChange: onChange
  };

  if (!framed) return;

  request("ui/initialize", {
    appInfo: { name: "letter-irl-card", version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26"
  }).then(
    function (result) {
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
