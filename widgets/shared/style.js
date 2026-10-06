/*
 * The Style row on the letter card (#563).
 *
 * While stationery is offered, a letter preview names the stationery its page
 * was drawn in (stationery). The card offers the six in a Style row and
 * changes the draft's through set_stationery, without previewing again. The
 * tool answers with the page drawn again, in its _meta as a preview's page
 * is, and the card shows it in place of the preview's. A theme chosen here is
 * remembered for the account's next preview, as one the model chose is.
 *
 * While room to write is offered (#586), the studio's Words tab can change
 * the letter's words the same way, through set_letter_words. The two share
 * one draft, one wait and one page: a single change to the draft at a time,
 * none while the card sends or pays, and the page and price the last change
 * gave are the card's.
 *
 * While signatures are offered (#608), a letter preview also says whether it
 * prints the person's saved signature (signature). With one saved, the row
 * has a Signature switch, which signs or unsigns the draft through
 * set_letter_signature in the same way: one draft, one wait, one page.
 *
 * The server inlines this file into the letter card, in place of its
 * letter-irl:style marker comment (src/mcp/widgetHost.ts). It defines
 * window.letterIrlStyle: THEMES and createStyle.
 */
(function () {
  "use strict";

  var THEMES = ["classic", "monogram", "botanical", "celebration", "typewriter", "handwritten"];

  function isTheme(value) {
    return THEMES.indexOf(value) !== -1;
  }

  /** The theme a saved design (#649) is drawn as: a page the card can show and change, though no theme button names it. */
  var CUSTOM = "custom";

  /** Whether the card can show a page drawn in this: a theme, or a saved design. */
  function isDrawn(value) {
    return isTheme(value) || value === CUSTOM;
  }

  /** A saved design as the preview's _meta offers it (#649): an id and a name, each text; anything else is none. */
  function designOf(value) {
    return value && typeof value === "object" && typeof value.designId === "string" && value.designId && typeof value.name === "string" && value.name
      ? value
      : null;
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
   *   onBusy(), and wordsElement(id), which finds the Words tab's editor
   *   (#586) once the studio has drawn it; and signatureRow and
   *   signatureSwitch, the Signature switch (#608), which may be absent
   */
  // What a restyle or a status answer says the letter costs now (#586): a
  // restyle can run it on to another page, or back on to one, and with that
  // who pays. Null when it says nothing of it, as an older server would not.
  function termsOf(data, fit) {
    if (!data || typeof data.canSendNow !== "boolean" || !data.sendEligibility || typeof data.sendEligibility !== "object") {
      return null;
    }
    return {
      canSendNow: data.canSendNow,
      sendEligibility: data.sendEligibility,
      reasonCannotSend: typeof data.reasonCannotSend === "string" ? data.reasonCannotSend : null,
      pages: data.pages === 2 || data.pages === 3 ? data.pages : 1,
      pageFit: fit && typeof fit === "object" ? fit : null,
      // How the letter travels, when the answer speaks of it (#625): the certified service ("" for ordinary mail) and the
      // words that say how it is delivered, taken with the terms so that the summary, the note, the Delivery line, the price
      // and the buttons all come from one answer. An answer that carries a delivery class speaks of it; one without (an
      // older server, or an ordinary letter while certified mail is off) says nothing, and the preview's words stand.
      travel:
        typeof data.deliveryClass === "string" && data.deliveryClass
          ? {
              mailService: typeof data.mailService === "string" ? data.mailService : "",
              deliveryClass: data.deliveryClass,
              deliveryDisclaimer: typeof data.deliveryDisclaimer === "string" ? data.deliveryDisclaimer : ""
            }
          : null
    };
  }

  function createStyle(options) {
    var host = options.host;
    // pending: the theme being set while the server answers. slots: the
    // initials and headline this card last saw with each theme on this
    // draft, which come back with the theme when the person returns to it.
    // held: the card is sending the letter or starting a payment, so the
    // row waits too. restyled: the card changed this draft itself, its style
    // or its words, so the server's earlier word on it (adopt) is out of
    // date. terms: what the
    // letter costs now and how full its pages are, as the last restyle or
    // status answer said (#586), or null for the preview's own.
    var state = {
      draftId: null,
      stationery: null,
      previewHtml: null,
      terms: null,
      pending: null,
      busy: false,
      held: false,
      restyled: false,
      message: "",
      error: false,
      slots: {}
    };

    // The Words tab's editor (#586). editing: it is open. updating: its words
    // are being set. set: the words this card last set on the draft, or the
    // server last gave it, or null for the preview's; each { bodyText,
    // signOff, version }, the version a change of them names (#593 review
    // round 1). current: the words shown now. fit: how full the page
    // is for them. editable: the card may change them now. gift: a gift
    // letter, which stays on one page.
    var words = {
      editing: false,
      updating: false,
      set: null,
      current: null,
      fit: null,
      editable: false,
      gift: false,
      message: "",
      error: false
    };
    var element = typeof options.wordsElement === "function" ? options.wordsElement : function () { return null; };
    var wordsBound = false;

    // The Signature switch (#608). offered: the preview says a signature is
    // saved, so the switch can turn it on. on: the draft prints it. pending:
    // the choice being set while the server answers.
    var signature = { offered: false, on: false, pending: null };
    var signatureSwitch = options.signatureSwitch || null;
    var signatureRow = options.signatureRow || null;

    // The Mail choice (#648): offered, the services the preview offers; current, the one the draft travels by; pending,
    // the one being set while the server answers.
    var SERVICES = ["standard", "certified", "certified_return_receipt"];
    // message and error: what the last change of service said, in the Mail row's own note on the Delivery tab, since the
    // Style note sits on another tab.
    var service = { offered: [], current: "standard", pending: null, message: "", error: false };
    var serviceRow = options.serviceRow || null;
    var serviceButtons = options.serviceButtons || [];
    var serviceNote = options.serviceNote || null;
    function isService(value) {
      return SERVICES.indexOf(value) !== -1;
    }
    // Terms taken from any answer: when they say how the letter travels, the Mail choice follows them.
    function adoptTerms(said) {
      state.terms = said;
      if (said && said.travel) service.current = isService(said.travel.mailService) ? said.travel.mailService : "standard";
    }

    // What a preview or a status answer says of the signature: whether a
    // saved one can be switched, and whether it prints. None saved, or
    // signatures not offered: no switch.
    function signatureOffered(said) {
      return Boolean(said) && typeof said.printed === "boolean" && said.source !== "none_saved";
    }

    // The account's saved designs (#649), as this draft's preview offered them, and their buttons in the Style row.
    var designs = { list: [], buttons: [] };
    var designsElement = options.designsElement || null;

    /**
     * What the row presses for a stationery: its theme, or "design:" and the
     * design's id (#649). A status names a design without its id: it is
     * pressed by its name, when the preview offered one of that name.
     */
    function keyOf(stationery) {
      if (!stationery) return null;
      if (stationery.theme !== CUSTOM) return stationery.theme;
      var id = typeof stationery.designId === "string" ? stationery.designId : null;
      if (!id) {
        // By its name, and only while the design of that name still has the draft's choices: one replaced
        // since under the same name is another design, which the person may press to redraw the letter in.
        for (var i = 0; i < designs.list.length; i++) {
          if (designs.list[i].name === stationery.name && sameChoices(designs.list[i].design, stationery.design)) id = designs.list[i].designId;
        }
      }
      return id ? "design:" + id : "design:";
    }

    function sameChoices(a, b) {
      return Boolean(a && b) && a.face === b.face && a.ornament === b.ornament && a.ruled === b.ruled && a.tone === b.tone;
    }

    function shownTheme() {
      if (state.busy && state.pending) return state.pending;
      return keyOf(state.stationery);
    }

    /** The design buttons for this draft's designs, drawn afresh: each named as the person saved it. */
    function drawDesigns(list) {
      designs.list = list;
      designs.buttons = [];
      if (!designsElement) return;
      while (designsElement.firstChild) designsElement.removeChild(designsElement.firstChild);
      for (var i = 0; i < list.length; i++) {
        var button = designsElement.ownerDocument.createElement("button");
        button.type = "button";
        button.className = "link-button";
        button.setAttribute("data-design-id", list[i].designId);
        button.setAttribute("aria-pressed", "false");
        button.textContent = list[i].name;
        // Told apart from a theme of the same name by a screen reader.
        button.setAttribute("aria-label", list[i].name + ", your design");
        (function (id) {
          button.addEventListener("click", function () {
            set("design:" + id);
          });
        })(list[i].designId);
        designsElement.appendChild(button);
        designs.buttons.push(button);
      }
      designsElement.hidden = list.length === 0;
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
      for (var d = 0; d < designs.buttons.length; d++) {
        var mine = designs.buttons[d];
        mine.setAttribute("aria-pressed", "design:" + mine.getAttribute("data-design-id") === shown ? "true" : "false");
        mine.setAttribute("aria-disabled", waiting);
      }
      options.note.textContent = state.message;
      options.note.style.display = state.message ? "block" : "none";
      options.note.classList.toggle("alert", state.error);
      if (signatureSwitch) {
        var on = state.busy && signature.pending !== null ? signature.pending : signature.on;
        signatureSwitch.setAttribute("aria-checked", on ? "true" : "false");
        signatureSwitch.setAttribute("aria-disabled", waiting);
        signatureSwitch.textContent = on ? "On" : "Off";
      }
      var shownService = state.busy && service.pending !== null ? service.pending : service.current;
      for (var j = 0; j < serviceButtons.length; j++) {
        var choice = serviceButtons[j];
        var value = choice.getAttribute("data-service");
        choice.hidden = service.offered.indexOf(value) === -1;
        choice.setAttribute("aria-pressed", value === shownService ? "true" : "false");
        choice.setAttribute("aria-disabled", waiting);
      }
      if (serviceNote) {
        // Hidden with the row by hide(), which the card calls whenever the row goes.
        serviceNote.textContent = service.message;
        serviceNote.style.display = service.message ? "block" : "none";
        serviceNote.classList.toggle("alert", service.error);
      }
    }

    function keepSlots(stationery) {
      var slots = {};
      if (typeof stationery.monogram === "string") slots.monogram = stationery.monogram;
      if (typeof stationery.headline === "string") slots.headline = stationery.headline;
      state.slots[keyOf(stationery)] = slots;
    }

    /** Focus on the button of the style the letter has, a theme's or a design's, or the first theme's. */
    function focusShown() {
      var key = keyOf(state.stationery);
      var target = null;
      for (var i = 0; i < options.buttons.length; i++) {
        if (options.buttons[i].getAttribute("data-theme") === key) target = options.buttons[i];
      }
      for (var j = 0; j < designs.buttons.length; j++) {
        if ("design:" + designs.buttons[j].getAttribute("data-design-id") === key) target = designs.buttons[j];
      }
      target = target || options.buttons[0];
      if (target && typeof target.focus === "function") target.focus();
    }

    /** The design a key names, among this draft's (#649), or null. */
    function designFor(key) {
      if (typeof key !== "string" || key.indexOf("design:") !== 0) return null;
      var id = key.slice("design:".length);
      for (var i = 0; i < designs.list.length; i++) {
        if (designs.list[i].designId === id) return designs.list[i];
      }
      return null;
    }

    // theme: a theme's name, or "design:" and one of this draft's designs' ids (#649).
    function set(theme) {
      var design = designFor(theme);
      if (state.busy || state.held || !state.draftId || typeof host.callTool !== "function" || !(isTheme(theme) || design)) return;
      if (state.stationery && keyOf(state.stationery) === theme) return;
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
      // ones this card last saw with the theme come back with it. A design
      // (#649) takes back what it printed when this card last saw it.
      var args = design ? { draftId: draftId, stationeryDesignId: design.designId } : { draftId: draftId, stationery: theme };
      var slots = state.slots[theme] || {};
      var monogrammed = design && design.design && design.design.ornament === "monogram";
      if ((theme === "monogram" || monogrammed) && slots.monogram) args.monogram = slots.monogram;
      if ((theme === "celebration" || design) && slots.headline) args.headline = slots.headline;
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
          // A theme asked is answered with a theme; a design (#649) with that design.
          var answered = stationery && (design ? stationery.theme === CUSTOM && stationery.designId === design.designId : isTheme(stationery.theme));
          if (!answered) {
            throw new Error("The style may have changed. Make the preview again to see it.");
          }
          state.stationery = stationery;
          state.restyled = true;
          keepSlots(stationery);
          // What it costs now, and how full its pages are (#586). An answer
          // that says nothing of it, as an older server's would not, keeps
          // the last word on it (#592 review round 1).
          var said = termsOf(data, result && result._meta && result._meta.pageFit);
          if (said) adoptTerms(said);
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
          var said = options.readableError(error);
          // A design deleted since the preview (#649): the refusal is written for the model, so the card says it in
          // the person's words and puts the design's button away. Found anywhere in the text, as a host may wrap it.
          if (design && said.indexOf("That stationery design was not found") !== -1) {
            state.message = "That design was deleted. Make the preview again to see your designs.";
            var focused = typeof document !== "undefined" && designs.buttons.indexOf(document.activeElement) !== -1;
            drawDesigns(designs.list.filter(function (kept) {
              return kept.designId !== design.designId;
            }));
            // Focus leaves with the button: to the style the letter keeps, as the signature switch's does.
            if (focused) focusShown();
          } else if (design && said.indexOf("Name the stationery") !== -1) {
            // Designs turned off since the preview: the tool no longer takes one, and says so for the model.
            state.message = "Saved designs aren't available now. Make the preview again to see the styles.";
          } else {
            state.message = said;
          }
        })
        .then(function () {
          if (state.draftId !== draftId) return;
          state.busy = false;
          state.pending = null;
          draw();
          options.onBusy();
        });
    }

    // The Signature switch pressed (#608): the draft signed or unsigned, its
    // page drawn again, as a restyle is. The account remembers the choice.
    function setSignature() {
      if (state.busy || state.held || !state.draftId || typeof host.callTool !== "function" || !signature.offered) return;
      // A press a host still delivers to a hidden switch (after a send) does nothing.
      if (signatureRow && signatureRow.style.display === "none") return;
      if (typeof options.idle === "function" && !options.idle()) return;
      var draftId = state.draftId;
      var wanted = !signature.on;
      state.busy = true;
      signature.pending = wanted;
      state.message = "";
      state.error = false;
      draw();
      // Signing is acting on the draft (the card keeps it).
      if (typeof options.onSet === "function") options.onSet();
      options.onBusy();
      Promise.resolve()
        .then(function () {
          return host.callTool("set_letter_signature", { draftId: draftId, signature: wanted });
        })
        .then(function (result) {
          // A refusal comes back as an error result, not a rejection.
          if (result && result.isError) {
            throw new Error(options.resultText(result) || "The signature was not changed.");
          }
          if (state.draftId !== draftId) return;
          var data = toolData(result);
          // An answer about another draft is no answer to this one.
          if (typeof data.draftId === "string" && data.draftId !== draftId) {
            throw new Error("The signature may have changed. Make the preview again to see it.");
          }
          if (!data.signature || typeof data.signature.printed !== "boolean") {
            throw new Error("The signature may have changed. Make the preview again to see it.");
          }
          signature.on = data.signature.printed;
          state.restyled = true;
          // What it costs now: the band can run the letter on to a page.
          var said = termsOf(data, result && result._meta && result._meta.pageFit);
          if (said) adoptTerms(said);
          var page = result && result._meta && result._meta.previewHtml;
          if (typeof page === "string" && page) {
            state.previewHtml = page;
          } else {
            state.message = "The signature is changed, but its page did not come back here. Make the preview again to see it.";
          }
          options.onChange({ draftId: draftId, stationery: state.stationery });
        })
        .catch(function (error) {
          if (state.draftId !== draftId) return;
          state.error = true;
          var text = options.readableError(error);
          // The signature was removed since the preview (SIGNATURE_NOT_SAVED): the
          // refusal is written for the model, so the card says it in the
          // person's words, and puts the switch away (#615 review round 1).
          // Found anywhere in the text, as a host may wrap it (#434).
          if (text.indexOf("No signature is saved") !== -1) {
            state.message = "There's no saved signature to add now. Save one in the chat, or on your Letter IRL settings page.";
            signature.offered = false;
            signature.on = false;
            // Focus leaves with the switch: to the first style, as closeWords
            // returns it (#615 review round 2).
            var focused = typeof document !== "undefined" && document.activeElement === signatureSwitch;
            if (signatureRow) signatureRow.style.display = "none";
            if (focused && options.buttons[0] && typeof options.buttons[0].focus === "function") options.buttons[0].focus();
          } else {
            state.message = text;
          }
        })
        .then(function () {
          if (state.draftId !== draftId) return;
          state.busy = false;
          signature.pending = null;
          draw();
          options.onBusy();
        });
    }

    // A refusal of set_mail_service is written for the model (it names tools and arguments): the Mail note says it in the
    // person's words, found anywhere in the text, as a host may wrap it (#434). Anything else is said as it came.
    var SERVICE_REFUSALS = [
      ["This letter has already been sent", "This letter has already been sent, so how it travels can't change now."],
      ["This letter was sent just after", "This letter was sent just as it was changed. Its order says how it travels."],
      ["This preview has expired", "This preview has expired. Ask in the chat for a new one."],
      ["tied to a Pay & Send payment", "A Pay & Send payment is open for this letter, so how it travels can't change now."],
      ["gift letter does not pay for certified mail", "A gift letter can't go by certified mail. Ask in the chat for a new preview to send it certified."],
      ["postcard always goes as ordinary mail", "A postcard always goes as ordinary mail."],
      ["That preview wasn't found", "That preview wasn't found. Ask in the chat for a new one."]
    ];
    var NOT_OFFERED = "Certified mail is not available right now. The preview stays as it is.";
    function serviceRefusal(text) {
      for (var i = 0; i < SERVICE_REFUSALS.length; i++) {
        if (text.indexOf(SERVICE_REFUSALS[i][0]) !== -1) return SERVICE_REFUSALS[i][1];
      }
      // Certified mail turned off since the preview: the tool is no longer listed, and the connection says so in its own words.
      if (text.indexOf("set_mail_service") !== -1 && text.indexOf("not found") !== -1) return NOT_OFFERED;
      return text;
    }

    // The Mail choice on the Delivery tab (#648): the services the preview's _meta offers (certified mail, while it is
    // offered and the letter is not a gift letter), the one the draft travels by, and the one being set. A change of
    // service calls set_mail_service, whose answer carries the terms and how the letter travels (#638), so the price,
    // the buttons, the summary and the Delivery line follow it as they follow a restyle. The pressed service is asked
    // for again too: a card that did not hear the chat change it (ChatGPT's) hears the draft as it is from the answer.
    function setService(wanted) {
      if (state.busy || !state.draftId || typeof host.callTool !== "function") return;
      if (service.offered.indexOf(wanted) === -1) return;
      if (serviceRow && serviceRow.style.display === "none") return;
      // Not while the card sends the letter or starts paying for it.
      if (typeof options.idle === "function" && !options.idle()) return;
      var draftId = state.draftId;
      state.busy = true;
      service.pending = wanted;
      service.message = "";
      service.error = false;
      draw();
      if (typeof options.onSet === "function") options.onSet();
      options.onBusy();
      Promise.resolve()
        .then(function () {
          return host.callTool("set_mail_service", { draftId: draftId, mailService: wanted });
        })
        .then(function (result) {
          if (result && result.isError) {
            throw new Error(options.resultText(result) || "How the letter travels was not changed.");
          }
          if (state.draftId !== draftId) return;
          var data = toolData(result);
          if (typeof data.draftId === "string" && data.draftId !== draftId) {
            throw new Error("How the letter travels may have changed. Make the preview again to see it.");
          }
          // The answer gives the pages (above one) with the price; how full they are is card-only and a change of
          // service leaves the page as it is (#648 review round 1), so that stays the one the card knew, from the last
          // terms or the preview.
          var known = state.terms;
          var previewFit = typeof options.previewFit === "function" ? options.previewFit() : null;
          var said = termsOf(data, known ? known.pageFit : previewFit);
          if (!said) throw new Error("How the letter travels may have changed. Make the preview again to see it.");
          // A fit for another number of pages than the answer gives is for words the chat has changed since: say none.
          if (said.pageFit && said.pageFit.pages !== said.pages) said.pageFit = null;
          // The terms say how the letter travels now, and with them the service the draft holds, whichever was pressed.
          adoptTerms(said);
          state.restyled = true;
        })
        .catch(function (error) {
          if (state.draftId !== draftId) return;
          service.error = true;
          service.message = serviceRefusal(options.readableError(error));
        })
        .then(function () {
          if (state.draftId !== draftId) return;
          state.busy = false;
          service.pending = null;
          draw();
          options.onBusy();
        });
    }

    // The page the room is counted on, by how many the letter takes.
    var ROOM_ON = ["", "this page", "the back of the page", "the third page"];

    // How much room the words being written leave (#586): the room the last
    // count gave, less what was typed since. "About": a line ends at a word,
    // and a new paragraph takes a line of its own.
    function roomText() {
      var fit = words.fit;
      var body = element("studio-words-body");
      var signOff = element("studio-words-signoff");
      if (!fit || typeof fit !== "object" || !words.current || !body || !signOff) return "";
      var room = Number(fit.roomCharacters);
      if (!isFinite(room)) return "";
      var pages = fit.pages === 2 || fit.pages === 3 ? fit.pages : 1;
      var typed = body.value.length + signOff.value.length;
      var before = words.current.bodyText.length + words.current.signOff.length;
      var left = Math.round(room - (typed - before));
      var count = Math.abs(left).toLocaleString("en-US");
      if (left >= 0) return "About " + count + " characters left on " + ROOM_ON[pages] + ".";
      if (words.gift) return "About " + count + " characters past this page, and a gift letter is one page.";
      // Without room to write the letter stays on one page (#647).
      if (fit.maxPages === 1) return "About " + count + " characters past this page, and this letter must fit on one page.";
      if (pages === 3) return "About " + count + " characters past the third page, more than we print.";
      return "About " + count + " characters past " + ROOM_ON[pages] + ": Update the page to see how it runs on.";
    }

    // The editor's elements live in the studio, which draws them after the
    // card starts: found, and listened to, once they are there.
    function bindWords() {
      if (wordsBound) return true;
      var open = element("studio-words-open");
      var update = element("studio-words-update");
      var cancel = element("studio-words-cancel");
      var body = element("studio-words-body");
      var signOff = element("studio-words-signoff");
      if (!open || !update || !cancel || !body || !signOff) return false;
      open.addEventListener("click", openWords);
      update.addEventListener("click", setWords);
      cancel.addEventListener("click", closeWords);
      body.addEventListener("input", drawWords);
      signOff.addEventListener("input", drawWords);
      wordsBound = true;
      return true;
    }

    function drawWords() {
      if (!bindWords()) return;
      var editing = words.editable && words.editing;
      var view = element("studio-words");
      var chat = element("studio-words-chat");
      var count = element("studio-words-count");
      var note = element("studio-words-note");
      var update = element("studio-words-update");
      element("studio-words-edit").hidden = !editing;
      if (view) view.hidden = editing;
      element("studio-words-open").hidden = !words.editable || editing;
      if (chat) chat.hidden = words.editable;
      // aria-disabled, as the Style row's: a press meanwhile is ignored.
      update.setAttribute("aria-disabled", state.busy || state.held ? "true" : "false");
      element("studio-words-cancel").setAttribute("aria-disabled", words.updating ? "true" : "false");
      update.textContent = words.updating ? "Updating the page\u2026" : "Update the page";
      var room = editing ? roomText() : "";
      if (count) {
        count.textContent = room;
        count.hidden = !room;
      }
      if (note) {
        note.textContent = words.message;
        note.hidden = !words.message;
        note.classList.toggle("alert", words.error);
      }
    }

    function openWords() {
      if (!words.editable || !words.current || state.busy || state.held) return;
      var body = element("studio-words-body");
      var signOff = element("studio-words-signoff");
      body.value = words.current.bodyText;
      signOff.value = words.current.signOff;
      words.editing = true;
      words.message = "";
      words.error = false;
      drawWords();
      // The card holds its Send buttons while words are being written.
      options.onBusy();
      if (typeof body.focus === "function") body.focus();
    }

    // Focus goes back to Change the words, the boxes having gone.
    function focusOpen() {
      var open = element("studio-words-open");
      if (open && !open.hidden && typeof open.focus === "function") open.focus();
    }

    function closeWords() {
      if (words.updating) return;
      words.editing = false;
      words.message = "";
      words.error = false;
      drawWords();
      options.onBusy();
      focusOpen();
    }

    // The words as written in the editor, set on the draft (#586). The page
    // comes back drawn again with them, and what the letter costs now.
    function setWords() {
      if (!words.editable || !words.editing || state.busy || state.held || !state.draftId || typeof host.callTool !== "function") return;
      if (typeof options.idle === "function" && !options.idle()) return;
      var draftId = state.draftId;
      var bodyText = element("studio-words-body").value;
      var signOff = element("studio-words-signoff").value;
      // The words it replaces: their version, so a change made elsewhere since
      // is not overwritten unseen (#593 review round 1).
      var startedFrom = words.current;
      var args = { draftId: draftId, bodyText: bodyText, signOff: signOff };
      if (startedFrom && typeof startedFrom.version === "string") args.wordsVersion = startedFrom.version;
      state.busy = true;
      words.updating = true;
      words.message = "";
      words.error = false;
      draw();
      drawWords();
      // Changing the words is acting on the draft (the card keeps it).
      if (typeof options.onSet === "function") options.onSet();
      options.onBusy();
      Promise.resolve()
        .then(function () {
          return host.callTool("set_letter_words", args);
        })
        .then(function (result) {
          // A refusal comes back as an error result, not a rejection.
          if (result && result.isError) {
            throw new Error(options.resultText(result) || "The words were not changed.");
          }
          if (state.draftId !== draftId) return;
          var data = toolData(result);
          // An answer about another draft is no answer to this one.
          if (typeof data.draftId === "string" && data.draftId !== draftId) {
            throw new Error("The words may have changed. Make the preview again to see them.");
          }
          state.restyled = true;
          words.set = {
            bodyText: bodyText,
            signOff: signOff,
            version: typeof data.wordsVersion === "string" ? data.wordsVersion : undefined
          };
          words.editing = false;
          // What it costs now, and how full its pages are.
          var said = termsOf(data, result && result._meta && result._meta.pageFit);
          if (said) adoptTerms(said);
          var page = result && result._meta && result._meta.previewHtml;
          // The draft has the words either way; without its page the card
          // keeps showing the last one and says so.
          if (typeof page === "string" && page) {
            state.previewHtml = page;
            words.message = typeof data.message === "string" && data.message ? data.message : "The words are changed. Nothing has been sent.";
          } else {
            words.message = "The words are changed, but the page did not come back here. Make the preview again to see it.";
          }
          options.onChange({ draftId: draftId, stationery: state.stationery });
        })
        .catch(function (error) {
          if (state.draftId !== draftId) return;
          words.error = true;
          var said = options.readableError(error);
          // A refusal of words this card had not seen (WORDS_CHANGED) is
          // written for the model, with the whole letter: the card says it in
          // its own words, and keeps what was typed (#593 review rounds 2 and
          // 3). Found anywhere in the text, as a host may wrap it (#434). The
          // server's version check is what keeps a change made elsewhere
          // from being overwritten; the card fetches nothing to catch up.
          words.message = said.indexOf("Nothing was changed:") !== -1 ? "The words were not changed: this card's copy of them is out of date. Ask in the chat to change them, or make the preview again." : said;
        })
        .then(function () {
          if (state.draftId !== draftId) return;
          state.busy = false;
          words.updating = false;
          draw();
          drawWords();
          options.onBusy();
          if (!words.editing) focusOpen();
        });
    }

    for (var i = 0; i < options.buttons.length; i++) {
      (function (button) {
        button.addEventListener("click", function () {
          set(button.getAttribute("data-theme"));
        });
      })(options.buttons[i]);
    }

    if (signatureSwitch) signatureSwitch.addEventListener("click", setSignature);
    for (var k = 0; k < serviceButtons.length; k++) {
      (function (choice) {
        choice.addEventListener("click", function () {
          setService(choice.getAttribute("data-service"));
        });
      })(serviceButtons[k]);
    }

    function hide() {
      options.row.style.display = "none";
      options.note.style.display = "none";
      if (signatureRow) signatureRow.style.display = "none";
      if (serviceRow) serviceRow.style.display = "none";
      if (serviceNote) serviceNote.style.display = "none";
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
          !isDrawn(offered.theme)
        ) {
          hide();
          return;
        }
        if (state.draftId !== draftId) {
          state.draftId = draftId;
          // The account's designs as this preview offered them (#649), before anything is keyed by them.
          var offeredDesigns = typeof options.designs === "function" ? options.designs() : null;
          drawDesigns(Array.isArray(offeredDesigns) ? offeredDesigns.map(designOf).filter(Boolean) : []);
          state.stationery = offered;
          state.previewHtml = null;
          state.terms = null;
          state.busy = false;
          state.pending = null;
          state.restyled = false;
          state.message = "";
          state.error = false;
          state.slots = {};
          words.editing = false;
          words.updating = false;
          words.set = null;
          words.message = "";
          words.error = false;
          keepSlots(offered);
          signature.offered = signatureOffered(output.signature);
          signature.on = signature.offered && output.signature.printed === true;
          signature.pending = null;
          var offer = typeof options.mailServices === "function" ? options.mailServices() : null;
          service.offered = Array.isArray(offer) ? offer.filter(isService) : [];
          service.current = isService(output.mailService) ? output.mailService : "standard";
          service.pending = null;
          service.message = "";
          service.error = false;
        }
        options.row.style.display = "";
        // The Mail choice, while the preview offers more than one service (#648).
        if (serviceRow) serviceRow.style.display = service.offered.length > 1 && serviceButtons.length ? "" : "none";
        // The switch beside the styles, while a signature is saved (#608).
        if (signatureRow) signatureRow.style.display = signature.offered && signatureSwitch ? "" : "none";
        draw();
      },
      hide: hide,
      // While the card sends the letter or starts a payment (true), and after
      // (false): the row waits, and says so.
      hold: function (held) {
        state.held = Boolean(held);
        // Drawn only while shown: a hidden row keeps its note hidden.
        if (state.draftId !== null && options.row.style.display !== "none") draw();
        drawWords();
      },
      // The Words tab's editor (#586): the words shown now, as the card set
      // them or the preview gave them ({ bodyText, signOff }); how full the
      // page is for them (fit, or null); whether the card may change them now
      // (editable: room to write is offered and the draft can still change);
      // and whether it is a gift letter. Only while the row is the draft's.
      showWords: function (draftId, current, fit, editable, gift) {
        // { bodyText, signOff, version }: the version is the preview's, or the last change's.
        words.current = current && typeof current.bodyText === "string" && typeof current.signOff === "string" ? current : null;
        words.fit = fit && typeof fit === "object" ? fit : null;
        words.gift = gift === true;
        words.editable =
          Boolean(editable) &&
          words.current !== null &&
          state.draftId === draftId &&
          options.row.style.display !== "none" &&
          typeof host.callTool === "function";
        if (!words.editable && !words.updating) words.editing = false;
        drawWords();
      },
      // The words this card set on the draft (#586), or null for the preview's.
      words: function (draftId) {
        return state.draftId === draftId ? words.set : null;
      },
      // The draft's style and page as the server says they are now
      // (get_draft_status), for a card shown its preview's first answer
      // again: the row presses it, and the page replaces the preview's. False
      // when the row is on another draft, setting a style, or has set one:
      // the card asks before anyone can press, so an answer that lands after
      // a restyle is older than it (#572 review round 2).
      // With it, what the letter costs now (#586), when the answer says, and
      // how full its pages are as the card knows it (fit, or null when it
      // does not: the status lays nothing out).
      adopt: function (draftId, stationery, previewHtml, answer, fit) {
        if (state.draftId !== draftId || state.busy || state.restyled || !stationery || !isDrawn(stationery.theme)) return false;
        state.stationery = stationery;
        keepSlots(stationery);
        if (typeof previewHtml === "string" && previewHtml) state.previewHtml = previewHtml;
        var terms = termsOf(answer, fit);
        if (terms) adoptTerms(terms);
        // And its words now (#593 review round 1): the chat may have changed
        // them since the preview, and the Words tab shows and edits these.
        if (answer && typeof answer.bodyText === "string" && typeof answer.signOff === "string" && typeof answer.wordsVersion === "string") {
          words.set = { bodyText: answer.bodyText, signOff: answer.signOff, version: answer.wordsVersion };
        }
        // And whether it is signed now (#608): the chat may have signed or
        // unsigned it since. Only where the switch is offered at all.
        if (answer && typeof answer.signature === "boolean" && signature.offered) signature.on = answer.signature;
        draw();
        return true;
      },
      // What this draft costs now and how full its pages are (#586), as the
      // last restyle or status answer said; null for the preview's own.
      terms: function (draftId) {
        return state.draftId === draftId ? state.terms : null;
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
      },
      // Words are being written in the editor (#586): until they are set or
      // put back, sending would mail the words the draft has, not these.
      editing: function () {
        return words.editable && words.editing;
      }
    };
  }

  window.letterIrlStyle = {
    THEMES: THEMES,
    CUSTOM: CUSTOM,
    createStyle: createStyle
  };
})();
