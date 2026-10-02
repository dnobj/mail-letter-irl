/*
 * The envelope reveal on the letter card (#576).
 *
 * While a letter preview's _meta carries letter-irl/envelopeReveal, the card
 * opens the page from a window envelope the first time it shows a draft, and
 * folds the page back into it once the letter is sent: the sealed envelope
 * stays, its windows showing the addresses. A press on it shows the letter
 * again. Nothing prints differently.
 *
 * The envelope is drawn over the page's top third, where a letter folded in
 * three shows through a #10 window envelope's windows, which sit where
 * PostGrid stamps the addresses (ADDRESS_STAMP, src/render/geometry.ts).
 * Every motion happens inside the page's box, so the card never grows; a
 * sealed letter makes it shorter. With reduced motion nothing moves: the page
 * shows at once, and a sent letter is sealed at once.
 *
 * The server inlines this file into the letter card, in place of its
 * letter-irl:envelope marker comment (src/mcp/widgetHost.ts). It defines
 * window.letterIrlEnvelope: ENVELOPE_META and createEnvelope.
 */
(function () {
  "use strict";

  var ENVELOPE_META = "letter-irl/envelopeReveal";
  var NS = "http://www.w3.org/2000/svg";

  // The page's width and its top third, in points (8.5 in by 11/3 in).
  var WIDTH = 612;
  var THIRD = 264;
  // The two windows, just inside the boxes PostGrid stamps the addresses in:
  // the return address at 0.5-3.75 in across and 0.2-1.5 in down, the
  // recipient at 1.5-2.8 in down.
  var WINDOWS = [
    { x: 43, y: 22, width: 223, height: 79 },
    { x: 43, y: 115, width: 223, height: 83 }
  ];

  // Longer than the slowest animation: the card moves on even when a host
  // never fires animationend.
  var SETTLE_MS = 1600;

  function rect(box) {
    var right = box.x + box.width;
    var bottom = box.y + box.height;
    return "M" + box.x + " " + box.y + "H" + right + "V" + bottom + "H" + box.x + "Z";
  }

  /* The envelope: a sheet with its windows cut out, a hairline edge, and a stamp's outline. */
  function drawEnvelope(doc) {
    var svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("class", "envelope");
    svg.setAttribute("viewBox", "0 0 " + WIDTH + " " + THIRD);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var sheet = doc.createElementNS(NS, "path");
    sheet.setAttribute("d", rect({ x: 0.5, y: 0.5, width: WIDTH - 1, height: THIRD - 1 }) + WINDOWS.map(rect).join(""));
    sheet.setAttribute("fill-rule", "evenodd");
    sheet.setAttribute("fill", "#fbf8f1");
    sheet.setAttribute("stroke", "#cfc6b4");
    sheet.setAttribute("stroke-width", "1");
    svg.appendChild(sheet);
    var stamp = doc.createElementNS(NS, "path");
    stamp.setAttribute("d", rect({ x: 528, y: 22, width: 54, height: 62 }));
    stamp.setAttribute("fill", "none");
    stamp.setAttribute("stroke", "#cfc6b4");
    stamp.setAttribute("stroke-width", "1.5");
    stamp.setAttribute("stroke-dasharray", "4 3");
    svg.appendChild(stamp);
    return svg;
  }

  /*
   * The reveal for one card. options: win (the card's window), enabled()
   * (whether the preview's _meta says the reveal is on).
   *
   * dress(view, page, draftId) is called with each page view the card draws.
   * It plays the opening the first time a draft shows, keeps a sealed
   * draft sealed, and does nothing otherwise. seal(draftId) folds the page
   * the card shows into the envelope once its letter is sent. sealed(draftId)
   * says whether a press on the page should show the letter rather than
   * enlarge it, and unseal() shows it.
   */
  function createEnvelope(options) {
    var win = options.win;
    var revealed = {};
    var sealedDraft = null;
    var current = null;

    function still() {
      return !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }

    function envelopeOf(page) {
      var found = page.querySelector(":scope > svg.envelope");
      if (found) return found;
      var drawn = drawEnvelope(page.ownerDocument);
      page.appendChild(drawn);
      return drawn;
    }

    function settle(view, done) {
      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        done();
      }
      view.addEventListener("animationend", function (event) {
        if (event.target === view.querySelector(".letter-page")) finish();
      });
      win.setTimeout(finish, SETTLE_MS);
    }

    function clear(view, page) {
      view.classList.remove("envelope-opening", "envelope-sealing", "envelope-sealed");
      var envelope = page.querySelector(":scope > svg.envelope");
      if (envelope) envelope.remove();
    }

    return {
      dress: function (view, page, draftId) {
        current = { view: view, page: page };
        if (!draftId || !options.enabled()) return;
        if (sealedDraft === draftId) {
          envelopeOf(page);
          view.classList.add("envelope-sealed");
          return;
        }
        if (revealed[draftId]) return;
        revealed[draftId] = true;
        if (still()) return;
        envelopeOf(page);
        view.classList.add("envelope-opening");
        settle(view, function () {
          if (view.classList.contains("envelope-opening")) clear(view, page);
        });
      },
      seal: function (draftId) {
        if (!draftId || !current || !options.enabled()) return;
        var view = current.view;
        var page = current.page;
        sealedDraft = draftId;
        revealed[draftId] = true;
        view.classList.remove("envelope-opening");
        envelopeOf(page);
        if (still()) {
          view.classList.add("envelope-sealed");
          return;
        }
        view.classList.add("envelope-sealing");
        settle(view, function () {
          if (!view.classList.contains("envelope-sealing")) return;
          view.classList.remove("envelope-sealing");
          view.classList.add("envelope-sealed");
        });
      },
      sealed: function (draftId) {
        return !!draftId && sealedDraft === draftId;
      },
      unseal: function () {
        sealedDraft = null;
        if (current) clear(current.view, current.page);
      }
    };
  }

  window.letterIrlEnvelope = { ENVELOPE_META: ENVELOPE_META, createEnvelope: createEnvelope };
})();
