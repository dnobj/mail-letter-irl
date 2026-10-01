/*
 * The arrival date on the letter and postcard cards (#535).
 *
 * While arrival dates are on, every preview names the dates on offer
 * (arrivalWindow). The card offers them in an Arrives row: as soon as
 * possible, or a date to arrive by, which the card sets on the draft through
 * set_arrival_date without previewing again. Sent with a date, the mail waits
 * in Letter IRL's outbox until its mail date, and the card offers Cancel
 * (cancel_scheduled_mail), free until then.
 *
 * The server inlines this file into each card that asks for it, in place of
 * the card's letter-irl:arrives marker comment (src/mcp/widgetHost.ts). It
 * defines window.letterIrlArrives: describeDate, mailsLine,
 * boundsFromRefusal, closingMessage, scheduleOf, createPicker and
 * createScheduled.
 */
(function () {
  "use strict";

  var CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function isCalendarDate(value) {
    return typeof value === "string" && CALENDAR_DATE.test(value);
  }

  function newYorkYear(now) {
    try {
      return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(now));
    } catch (error) {
      return now.getUTCFullYear();
    }
  }

  // "Tue, Oct 6", with the year when it is not this year in New York: as the
  // server writes a date (describeDate, src/tools/arriveByInput.ts).
  function describeDate(date, now) {
    var match = CALENDAR_DATE.exec(date || "");
    if (!match) return "";
    var day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
    var text = WEEKDAYS[day.getUTCDay()] + ", " + MONTHS[day.getUTCMonth()] + " " + day.getUTCDate();
    return day.getUTCFullYear() === newYorkYear(now || new Date()) ? text : text + ", " + day.getUTCFullYear();
  }

  // The two dates of held mail, or null for anything else.
  function scheduleOf(value) {
    return value && isCalendarDate(value.arriveBy) && isCalendarDate(value.mailOn)
      ? { arriveBy: value.arriveBy, mailOn: value.mailOn }
      : null;
  }

  // The line under a chosen date, and on mail that is waiting for it.
  function mailsLine(schedule, now) {
    return "Mails " + describeDate(schedule.mailOn, now) + " · cancel free until then";
  }

  // The dates a refusal names, such as "The earliest this can arrive is Wed,
  // Oct 14 (2026-10-14).": what is on offer moves on at noon New York time on
  // a business day, and at midnight, so a card held open can go out of date.
  function boundsFromRefusal(text) {
    var bounds = {};
    var earliest = /earliest this can arrive is [^(]*\((\d{4}-\d{2}-\d{2})\)/.exec(text || "");
    var latest = /latest arrival date on offer is [^(]*\((\d{4}-\d{2}-\d{2})\)/.exec(text || "");
    if (earliest) bounds.earliest = earliest[1];
    if (latest) bounds.latest = latest[1];
    return bounds;
  }

  function toolData(result) {
    return (result && result.structuredContent) || result || {};
  }

  /*
   * The Arrives row. The card gives it its elements and helpers, and draws it
   * from each render through show(). It sets the date itself, and tells the
   * card when the draft's dates change (onChange) and when it starts or
   * stops waiting on the server (onBusy), so the card can hold its Send
   * buttons meanwhile.
   *
   * options: host, row, input, asap, note, readableError(error),
   *   resultText(result), onSet() (a date is being set on the draft),
   *   onChange({ draftId, schedule, deliveryEstimate }), onBusy()
   */
  function createPicker(options) {
    var host = options.host;
    // pending: the date being set while the server answers ("" for as soon
    // as possible), so the field keeps what the person chose meanwhile.
    var state = { draftId: null, schedule: null, min: "", max: "", busy: false, pending: null, message: "", error: false };

    function draw() {
      options.input.min = state.min;
      options.input.max = state.max;
      options.input.value =
        state.busy && state.pending !== null ? state.pending : state.schedule ? state.schedule.arriveBy : "";
      options.input.disabled = state.busy;
      options.asap.disabled = state.busy || !state.schedule;
      options.asap.setAttribute("aria-pressed", state.schedule ? "false" : "true");
      var text = state.message || (state.schedule ? mailsLine(state.schedule) : "");
      options.note.textContent = text;
      options.note.style.display = text ? "block" : "none";
      options.note.classList.toggle("alert", state.error);
    }

    function set(arriveBy) {
      if (state.busy || !state.draftId || typeof host.callTool !== "function") return;
      var draftId = state.draftId;
      state.busy = true;
      state.pending = arriveBy || "";
      state.message = "";
      state.error = false;
      draw();
      // Setting a date is acting on the draft (the card keeps it).
      if (typeof options.onSet === "function") options.onSet();
      options.onBusy();
      // Left out, the date is cleared: as soon as possible.
      var args = arriveBy ? { draftId: draftId, arriveBy: arriveBy } : { draftId: draftId };
      Promise.resolve()
        .then(function () {
          return host.callTool("set_arrival_date", args);
        })
        .then(function (result) {
          // A refusal comes back as an error result, not a rejection.
          if (result && result.isError) {
            throw new Error(options.resultText(result) || "The date was not changed.");
          }
          if (state.draftId !== draftId) return;
          var data = toolData(result);
          var schedule = data.schedule || null;
          state.schedule = scheduleOf(schedule);
          // A successful set names the dates on offer now.
          if (schedule && isCalendarDate(schedule.earliestArrival) && isCalendarDate(schedule.latestArrival)) {
            state.min = schedule.earliestArrival;
            state.max = schedule.latestArrival;
          }
          options.onChange({
            draftId: draftId,
            schedule: state.schedule,
            deliveryEstimate: typeof data.deliveryEstimate === "string" ? data.deliveryEstimate : null
          });
        })
        .catch(function (error) {
          if (state.draftId !== draftId) return;
          var text = options.readableError(error);
          var bounds = boundsFromRefusal(text);
          if (bounds.earliest) state.min = bounds.earliest;
          if (bounds.latest) state.max = bounds.latest;
          state.error = true;
          state.message = bounds.earliest
            ? "That date can't be met any more. The earliest on offer is now " + describeDate(bounds.earliest) + "."
            : bounds.latest
              ? "That date is too far ahead. The latest on offer is " + describeDate(bounds.latest) + "."
              : text;
        })
        .then(function () {
          if (state.draftId !== draftId) return;
          state.busy = false;
          state.pending = null;
          draw();
          options.onBusy();
        });
    }

    options.input.addEventListener("change", function () {
      var value = options.input.value;
      // Cleared by hand, or not a date: the dates stay as they are.
      if (!isCalendarDate(value)) {
        draw();
        return;
      }
      if (state.schedule && state.schedule.arriveBy === value) return;
      set(value);
    });
    options.asap.addEventListener("click", function () {
      if (state.schedule) set(null);
    });

    function hide() {
      options.row.style.display = "none";
      options.note.style.display = "none";
    }

    return {
      // Drawn for the card's draft while its preview offers dates and the card
      // can set one (enabled); hidden otherwise. A new draft starts from its
      // own preview's dates and window.
      show: function (draftId, output, enabled) {
        var offered = output && output.arrivalWindow;
        if (
          !enabled ||
          typeof draftId !== "string" ||
          !draftId ||
          typeof host.callTool !== "function" ||
          !offered ||
          !isCalendarDate(offered.earliestArrival) ||
          !isCalendarDate(offered.latestArrival)
        ) {
          hide();
          return;
        }
        if (state.draftId !== draftId) {
          state.draftId = draftId;
          state.schedule = scheduleOf(output.schedule);
          state.min = offered.earliestArrival;
          state.max = offered.latestArrival;
          state.busy = false;
          state.pending = null;
          state.message = "";
          state.error = false;
        }
        options.row.style.display = "";
        draw();
      },
      // The dates the server says this draft has now (get_draft_status), for a
      // card shown again with its preview's first answer.
      adopt: function (draftId, schedule) {
        if (state.draftId !== draftId || state.busy) return;
        state.schedule = scheduleOf(schedule);
        draw();
      },
      hide: hide,
      // The draft's dates as this card last set or saw them, or null.
      schedule: function () {
        return state.schedule;
      },
      busy: function () {
        return state.busy;
      }
    };
  }

  // What a refused cancel means on the card: the refusals that leave nothing
  // to cancel, by the words cancel_scheduled_mail uses
  // (SCHEDULED_MAIL_REFUSALS, src/tools/cancelScheduledMail.ts). null for any
  // other, whose own text is shown and which may be tried again.
  function closingMessage(text) {
    if (/has gone to the printer/i.test(text)) return "It has gone to the printer, so it can no longer be cancelled.";
    if (/going to the printer right now/i.test(text)) return "It is going to the printer right now, so it can no longer be cancelled.";
    if (/Only mail scheduled to arrive by a date/i.test(text)) return "It goes to the printer as soon as it can, so it can't be cancelled here.";
    if (/Pay & Send/i.test(text)) return text;
    return null;
  }

  /*
   * Mail sent with a date: it waits for its mail date, and may be cancelled
   * free until then. A first press asks; the second cancels.
   *
   * options: host, block, note, button, buttonText, noun ("letter" or
   *   "postcard"), readableError(error), resultText(result),
   *   onCancelled(message)
   */
  function createScheduled(options) {
    var host = options.host;
    var state = { orderId: null, schedule: null, confirming: false, busy: false, done: false, closed: false, message: "", error: false };

    function draw() {
      options.block.style.display = state.orderId ? "block" : "none";
      var text = state.message || (state.schedule ? mailsLine(state.schedule) : "");
      options.note.textContent = text;
      options.note.classList.toggle("alert", state.error);
      var offer = Boolean(state.orderId) && !state.done && !state.closed && typeof host.callTool === "function";
      options.button.style.display = offer ? "flex" : "none";
      options.button.disabled = state.busy;
      options.buttonText.textContent = state.busy
        ? "Cancelling..."
        : state.confirming
          ? "Yes, cancel this " + options.noun
          : "Cancel this " + options.noun;
    }

    options.button.addEventListener("click", function () {
      if (state.busy || state.done || state.closed || !state.orderId) return;
      if (!state.confirming) {
        state.confirming = true;
        state.error = false;
        state.message = "Cancel it? Nothing is mailed, and what paid for it comes back.";
        draw();
        return;
      }
      var orderId = state.orderId;
      state.busy = true;
      draw();
      Promise.resolve()
        .then(function () {
          return host.callTool("cancel_scheduled_mail", { orderId: orderId, confirm: true });
        })
        .then(function (result) {
          if (result && result.isError) {
            throw new Error(options.resultText(result) || "It was not cancelled.");
          }
          if (state.orderId !== orderId) return;
          var data = toolData(result);
          state.done = true;
          state.error = false;
          state.message = typeof data.message === "string" && data.message ? data.message : "Cancelled. Nothing will be mailed.";
          options.onCancelled(state.message);
        })
        .catch(function (error) {
          if (state.orderId !== orderId) return;
          var text = options.readableError(error);
          state.confirming = false;
          state.error = true;
          var closing = closingMessage(text);
          state.closed = closing !== null;
          state.message = closing || text;
        })
        .then(function () {
          if (state.orderId !== orderId) return;
          state.busy = false;
          draw();
        });
    });

    return {
      // The order and its dates; cancelled for one this card cancelled before.
      show: function (orderId, schedule, cancelled) {
        var shown = typeof orderId === "string" && orderId ? orderId : null;
        // Another order starts afresh; the same one keeps where it got to.
        if (shown !== state.orderId) {
          state.confirming = false;
          state.busy = false;
          state.done = false;
          state.closed = false;
          state.message = "";
          state.error = false;
        }
        state.orderId = shown;
        state.schedule = scheduleOf(schedule);
        if (cancelled) {
          state.done = true;
          state.message = "Cancelled. Nothing will be mailed.";
        }
        draw();
      },
      hide: function () {
        if (state.orderId === null) return;
        state.orderId = null;
        options.block.style.display = "none";
      },
      cancelled: function () {
        return state.done;
      }
    };
  }

  window.letterIrlArrives = {
    describeDate: describeDate,
    mailsLine: mailsLine,
    boundsFromRefusal: boundsFromRefusal,
    closingMessage: closingMessage,
    scheduleOf: scheduleOf,
    createPicker: createPicker,
    createScheduled: createScheduled
  };
})();
