/**
 * The panel's only browser script, served under the response nonce. It never
 * fetches, never renders markup and never touches innerHTML: it manages
 * focus for dialogs, guards forms against double submission, gates submit
 * buttons behind the typed confirmation phrase, and copies ids to the
 * clipboard. The server re-validates everything it does.
 */
(() => {
  const documentRef = document;

  function guardDoubleSubmit(form: HTMLFormElement): void {
    form.addEventListener("submit", () => {
      for (const button of form.querySelectorAll<HTMLButtonElement>("button[type=submit]")) {
        window.setTimeout(() => {
          button.disabled = true;
        }, 0);
      }
    });
  }

  function gateOnPhrase(input: HTMLInputElement): void {
    const expected = (input.dataset.confirmPhrase ?? "").trim();
    const form = input.form;
    if (!form || !expected) return;
    const buttons = form.querySelectorAll<HTMLButtonElement>("button[data-needs-phrase]");
    const update = () => {
      const matches = input.value.trim() === expected;
      for (const button of buttons) button.disabled = !matches;
    };
    input.addEventListener("input", update);
    update();
  }

  function wireCopy(button: HTMLButtonElement): void {
    const value = button.dataset.copy ?? "";
    const original = button.textContent ?? "copy";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = "copied";
      } catch {
        button.textContent = "copy failed";
      }
      window.setTimeout(() => {
        button.textContent = original;
      }, 1500);
    });
  }

  function wireDialogs(): void {
    let opener: HTMLElement | null = null;
    for (const button of documentRef.querySelectorAll<HTMLElement>("[data-open-dialog]")) {
      button.addEventListener("click", () => {
        const dialog = documentRef.getElementById(button.dataset.openDialog ?? "");
        if (!(dialog instanceof HTMLDialogElement)) return;
        opener = button;
        dialog.showModal();
        const first = dialog.querySelector<HTMLElement>("input, select, textarea, button");
        first?.focus();
      });
    }
    for (const button of documentRef.querySelectorAll<HTMLElement>("[data-close-dialog]")) {
      button.addEventListener("click", () => {
        const dialog = button.closest("dialog");
        if (dialog instanceof HTMLDialogElement) dialog.close();
      });
    }
    for (const dialog of documentRef.querySelectorAll<HTMLDialogElement>("dialog")) {
      dialog.addEventListener("close", () => {
        opener?.focus();
        opener = null;
      });
    }
  }

  documentRef.addEventListener("DOMContentLoaded", () => {
    for (const form of documentRef.querySelectorAll<HTMLFormElement>("form[data-single-submit]")) {
      guardDoubleSubmit(form);
    }
    for (const input of documentRef.querySelectorAll<HTMLInputElement>("input[data-confirm-phrase]")) {
      gateOnPhrase(input);
    }
    for (const button of documentRef.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
      wireCopy(button);
    }
    wireDialogs();
  });
})();
