/*
 * The Style row on the letter card (#563).
 *
 * While stationery is offered, a letter preview names the stationery its page
 * was drawn in (stationery). The card offers the four in a Style row and
 * changes the draft's through set_stationery, without previewing again. The
 * tool answers with the page drawn again, in its _meta as a preview's page
 * is, and the card shows it in place of the preview's. A theme chosen here is
 * remembered for the account's next preview, as one the model chose is.
 *
 * The server inlines this file into the letter card, in place of its
 * letter-irl:style marker comment (src/mcp/widgetHost.ts). It defines
 * window.letterIrlStyle: THEMES and createStyle.
 */
(function () {
  "use strict";

  var THEMES = ["classic", "monogram", "botanical", "celebration"];

  function isTheme(value) {
    return THEMES.indexOf(value) !== -1;
  }

  function toolData(result) {
    return (result && result.structuredContent) || result || {};
  }

  /*
   * The Style row. The card gives it its elements and helpers, and draws it
   * from each render through show(). It sets the style itself, and tells the
   * card when the draft's page changes (onChange) and when it starts or stops
   * waiting on the server (onBusy), so the card can hold its Send buttons
   * meanwhile.
   *
   * options: host, row, buttons (one per theme, each with data-theme), note,
   *   readableError(error), resultText(result), idle() (whether the card may
   *   change the draft now: not while it sends or starts a payment, which it
   *   also says with hold()), onSet()
   *   (a style is being set on the draft), onChange({ draftId, stationery }),
   *   onBusy()
   */
  function createStyle(options) {
    var host = options.host;
    // pending: the theme being set while the server answers. slots: the
    // initials and headline this card last saw with each theme on this
    // draft, which come back with the theme when the person returns to it.
    // held: the card is sending the letter or starting a payment, so the
    // row waits too. restyled: the row set a style on this draft itself, so
    // the server's earlier word on it (adopt) is out of date.
    var state = {
      draftId: null,
      stationery: null,
      previewHtml: null,
      pending: null,
      busy: false,
      held: false,
      restyled: false,
      message: "",
      error: false,
      slots: {}
    };

    function shownTheme() {
      if (state.busy && state.pending) return state.pending;
      return state.stationery ? state.stationery.theme : null;
    }

    function draw() {
      var shown = shownTheme();
      // aria-disabled, not disabled: a pressed button keeps keyboard focus
      // while the server answers, and set() ignores a press meanwhile.
      var waiting = state.busy || state.held ? "true" : "false";
      for (var i = 0; i < options.buttons.length; i++) {
        var button = options.buttons[i];
        button.setAttribute("aria-pressed", button.getAttribute("data-theme") === shown ? "true" : "false");
        button.setAttribute("aria-disabled", waiting);
      }
      options.note.textContent = state.message;
      options.note.style.display = state.message ? "block" : "none";
      options.note.classList.toggle("alert", state.error);
    }

    function keepSlots(stationery) {
      var slots = {};
      if (typeof stationery.monogram === "string") slots.monogram = stationery.monogram;
      if (typeof stationery.headline === "string") slots.headline = stationery.headline;
      state.slots[stationery.theme] = slots;
    }

    function set(theme) {
      if (state.busy || state.held || !state.draftId || typeof host.callTool !== "function" || !isTheme(theme)) return;
      if (state.stationery && state.stationery.theme === theme) return;
      if (typeof options.idle === "function" && !options.idle()) return;
      var draftId = state.draftId;
      state.busy = true;
      state.pending = theme;
      state.message = "";
      state.error = false;
      draw();
      // Setting a style is acting on the draft (the card keeps it).
      if (typeof options.onSet === "function") options.onSet();
      options.onBusy();
      // Only Monogram prints initials and only Celebration a headline: the
      // ones this card last saw with the theme come back with it.
      var args = { draftId: draftId, stationery: theme };
      var slots = state.slots[theme] || {};
      if (theme === "monogram" && slots.monogram) args.monogram = slots.monogram;
      if (theme === "celebration" && slots.headline) args.headline = slots.headline;
      Promise.resolve()
        .then(function () {
          return host.callTool("set_stationery", args);
        })
        .then(function (result) {
          // A refusal comes back as an error result, not a rejection.
          if (result && result.isError) {
            throw new Error(options.resultText(result) || "The style was not changed.");
          }
          if (state.draftId !== draftId) return;
          var data = toolData(result);
          // An answer about another draft is no answer to this one.
          if (typeof data.draftId === "string" && data.draftId !== draftId) {
            throw new Error("The style may have changed. Make the preview again to see it.");
          }
          var stationery = data.stationery;
          if (!stationery || !isTheme(stationery.theme)) {
            throw new Error("The style may have changed. Make the preview again to see it.");
          }
          state.stationery = stationery;
          state.restyled = true;
          keepSlots(stationery);
          var page = result && result._meta && result._meta.previewHtml;
          // The draft has the new style either way; without its page the card
          // keeps showing the last one and says so.
          if (typeof page === "string" && page) {
            state.previewHtml = page;
          } else {
            state.message = "The style is changed, but its page did not come back here. Make the preview again to see it.";
          }
          options.onChange({ draftId: draftId, stationery: stationery });
        })
        .catch(function (error) {
          if (state.draftId !== draftId) return;
          state.error = true;
          state.message = options.readableError(error);
        })
        .then(function () {
          if (state.draftId !== draftId) return;
          state.busy = false;
          state.pending = null;
          draw();
          options.onBusy();
        });
    }

    for (var i = 0; i < options.buttons.length; i++) {
      (function (button) {
        button.addEventListener("click", function () {
          set(button.getAttribute("data-theme"));
        });
      })(options.buttons[i]);
    }

    function hide() {
      options.row.style.display = "none";
      options.note.style.display = "none";
    }

    return {
      // Drawn for the card's draft while its preview names its stationery and
      // the card can change it (enabled); hidden otherwise. A new draft starts
      // from its own preview's stationery and page.
      show: function (draftId, output, enabled) {
        var offered = output && output.stationery;
        if (
          !enabled ||
          typeof draftId !== "string" ||
          !draftId ||
          typeof host.callTool !== "function" ||
          !offered ||
          !isTheme(offered.theme)
        ) {
          hide();
          return;
        }
        if (state.draftId !== draftId) {
          state.draftId = draftId;
          state.stationery = offered;
          state.previewHtml = null;
          state.busy = false;
          state.pending = null;
          state.restyled = false;
          state.message = "";
          state.error = false;
          state.slots = {};
          keepSlots(offered);
        }
        options.row.style.display = "";
        draw();
      },
      hide: hide,
      // While the card sends the letter or starts a payment (true), and after
      // (false): the row waits, and says so.
      hold: function (held) {
        state.held = Boolean(held);
        // Drawn only while shown: a hidden row keeps its note hidden.
        if (state.draftId !== null && options.row.style.display !== "none") draw();
      },
      // The draft's style and page as the server says they are now
      // (get_draft_status), for a card shown its preview's first answer
      // again: the row presses it, and the page replaces the preview's. False
      // when the row is on another draft, setting a style, or has set one:
      // the card asks before anyone can press, so an answer that lands after
      // a restyle is older than it (#572 review round 2).
      adopt: function (draftId, stationery, previewHtml) {
        if (state.draftId !== draftId || state.busy || state.restyled || !stationery || !isTheme(stationery.theme)) return false;
        state.stationery = stationery;
        keepSlots(stationery);
        if (typeof previewHtml === "string" && previewHtml) state.previewHtml = previewHtml;
        draw();
        return true;
      },
      // The page the card set for this draft, or null for its preview's own.
      previewHtml: function (draftId) {
        return state.draftId === draftId ? state.previewHtml : null;
      },
      // The stationery as this card last set or saw it, or null.
      stationery: function () {
        return state.stationery;
      },
      busy: function () {
        return state.busy;
      }
    };
  }

  window.letterIrlStyle = {
    THEMES: THEMES,
    createStyle: createStyle
  };
})();
