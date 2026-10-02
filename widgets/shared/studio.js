/*
 * The studio card (#580).
 *
 * While a preview's _meta carries letterirl/studioCard, a card lays itself
 * out as a studio: a header naming the mail, the page beside a strip of tabs,
 * and a footer with the cost and the send. The studio adds no control of its
 * own that changes the mail: its tabs hold the rows, notes and buttons the
 * card already had, moved, so each still calls the tool a model would
 * (Principle 2). With the switch off the card is laid out as it always was.
 *
 * The server inlines this file into a card, in place of its letter-irl:studio
 * marker comment (src/mcp/widgetHost.ts). It defines window.letterIrlStudio:
 * STUDIO_META and createStudio.
 */
(function () {
  "use strict";

  var STUDIO_META = "letterirl/studioCard";

  /*
   * The studio for one card. options: card (the card's root element),
   * template (a <template> holding the studio's skeleton) and enabled()
   * (whether the preview's _meta turns the studio on).
   *
   * In the skeleton, an element with data-slot="<id>" stands for the card's
   * element with that id, which takes its place; a slot whose element the
   * card lacks is dropped. Tabs are the skeleton's role="tab" buttons, each
   * with data-tab naming its panel's data-tab.
   *
   * update() lays the card out the first time enabled() says so, and says
   * whether the card is a studio. Once laid out it stays one: the switch
   * comes with the preview, and a card is not laid out twice.
   * select(name) shows a tab; suggest(name) shows one only until the person
   * picks a tab themselves.
   */
  function createStudio(options) {
    var card = options.card;
    var doc = card.ownerDocument;
    var laidOut = false;
    var tabs = [];
    var panels = [];
    var picked = false;

    function tabNamed(name) {
      for (var i = 0; i < tabs.length; i++) if (tabs[i].getAttribute("data-tab") === name) return tabs[i];
      return null;
    }

    function select(name, focus) {
      var chosen = tabNamed(name);
      if (!chosen) return;
      tabs.forEach(function (tab) {
        var on = tab === chosen;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        // One stop in the tab order, the selected tab; arrows move between them.
        tab.tabIndex = on ? 0 : -1;
      });
      panels.forEach(function (panel) {
        panel.hidden = panel.getAttribute("data-tab") !== name;
      });
      if (focus) chosen.focus();
    }

    function selected() {
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].getAttribute("aria-selected") === "true") return tabs[i].getAttribute("data-tab");
      }
      return null;
    }

    function onKey(event) {
      var index = tabs.indexOf(event.currentTarget);
      var next = null;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      if (next === null) return;
      event.preventDefault();
      picked = true;
      select(tabs[next].getAttribute("data-tab"), true);
    }

    function layOut() {
      var skeleton = options.template.content.cloneNode(true);
      Array.prototype.slice.call(skeleton.querySelectorAll("[data-slot]")).forEach(function (slot) {
        var moved = doc.getElementById(slot.getAttribute("data-slot"));
        if (moved) slot.parentNode.replaceChild(moved, slot);
        else slot.parentNode.removeChild(slot);
      });
      card.insertBefore(skeleton, card.firstChild);
      card.classList.add("studio");
      tabs = Array.prototype.slice.call(card.querySelectorAll('.studio-tabs [role="tab"]'));
      panels = Array.prototype.slice.call(card.querySelectorAll('[role="tabpanel"]'));
      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
          picked = true;
          select(tab.getAttribute("data-tab"), false);
        });
        tab.addEventListener("keydown", onKey);
      });
      if (tabs.length) select(tabs[0].getAttribute("data-tab"), false);
    }

    return {
      update: function () {
        if (!laidOut && options.enabled()) {
          layOut();
          laidOut = true;
        }
        return laidOut;
      },
      on: function () {
        return laidOut;
      },
      select: function (name) {
        select(name, false);
      },
      selected: selected,
      suggest: function (name) {
        if (!picked && selected() !== name) select(name, false);
      }
    };
  }

  window.letterIrlStudio = { STUDIO_META: STUDIO_META, createStudio: createStudio };
})();
