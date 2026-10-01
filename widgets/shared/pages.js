/*
 * Letter IRL card pages (#534).
 *
 * A preview our renderer drew is the pages themselves: an HTML document whose
 * body carries data-renderer and whose pages are its <svg> children. The
 * letter card shows a letter's page, and a gift send's card after it; the
 * postcard card shows a postcard's front and back. Both take the pages from
 * here and clean them the same way, so the rules that keep a card safe from a
 * page live in one place: window.letterIrlPages.
 *
 * The server inlines this file into each card that asks for it, in place of
 * the card's letter-irl:pages marker comment (src/mcp/widgetHost.ts).
 */
(function () {
  "use strict";

  /** The document's pages, or null for a preview our renderer did not draw. */
  function renderedPages(previewHtml) {
    if (typeof previewHtml !== "string" || previewHtml.indexOf("data-renderer") === -1) return null;
    var doc = new DOMParser().parseFromString(previewHtml, "text/html");
    if (!doc.body || !doc.body.getAttribute("data-renderer")) return null;
    var pages = Array.prototype.filter.call(doc.body.children, function (node) {
      return node.localName === "svg";
    });
    return pages.length > 0 ? pages : null;
  }

  // Only what the renderer draws reaches a card (src/render/preview.ts): these
  // elements, these attributes, and the values a renderer page carries.
  // Nothing else survives: no handler, no style, no paint server, filter or
  // link that could reach the network. Every id is prefixed, so a page cannot
  // stand in for one of the card's own controls. The server escapes the text;
  // this keeps the card safe even from a page that was not.
  var PAGE_ELEMENTS = new Set(["svg", "title", "defs", "g", "path", "use", "rect", "image", "text"]);
  var PAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  var NUMBER = /^-?\d+(\.\d+)?$/;
  function isNumber(value) {
    return NUMBER.test(value);
  }
  // A Map, not an object: an attribute named __proto__ or constructor must
  // find nothing, not Object.prototype (#542 review round 2).
  var PAGE_ATTRIBUTES = new Map([
    ["xmlns", function (value) { return value === "http://www.w3.org/2000/svg"; }],
    ["viewbox", function (value) { return /^[\d.\s-]+$/.test(value); }],
    ["role", function (value) { return value === "img"; }],
    ["id", function (value) { return PAGE_ID.test(value); }],
    ["d", function (value) { return /^[MLCZ\d.\s-]*$/.test(value); }],
    ["x", isNumber],
    ["y", isNumber],
    ["width", isNumber],
    ["height", isNumber],
    ["preserveaspectratio", function (value) { return value === "none"; }],
    ["fill", function (value) { return /^(#[0-9a-fA-F]{3,8}|none)$/.test(value); }],
    // A gift card's border (#534): a rounded, stroked rectangle.
    ["rx", isNumber],
    ["stroke", function (value) { return /^#[0-9a-fA-F]{3,8}$/.test(value); }],
    ["stroke-width", isNumber],
    ["font-family", function (value) { return /^[A-Za-z0-9 ',-]+$/.test(value); }],
    ["font-size", isNumber],
    ["href", function (value) {
      return /^#[A-Za-z0-9_-]{1,64}$/.test(value) || /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value);
    }]
  ]);
  var PAGE_ID_PREFIX = "lirl-page-";

  /** The page with everything the renderer does not draw removed, in place. */
  function cleanPage(node) {
    Array.prototype.slice.call(node.children).forEach(function (child) {
      if (PAGE_ELEMENTS.has(child.localName)) cleanPage(child);
      else child.remove();
    });
    Array.prototype.slice.call(node.attributes).forEach(function (attribute) {
      var allowed = PAGE_ATTRIBUTES.get(attribute.name.toLowerCase());
      if (!allowed || !allowed(attribute.value)) {
        node.removeAttribute(attribute.name);
      } else if (attribute.name === "id") {
        node.setAttribute("id", PAGE_ID_PREFIX + attribute.value);
      } else if (attribute.name === "href" && attribute.value.charAt(0) === "#") {
        node.setAttribute("href", "#" + PAGE_ID_PREFIX + attribute.value.slice(1));
      }
    });
    return node;
  }

  window.letterIrlPages = { renderedPages: renderedPages, cleanPage: cleanPage };
})();
