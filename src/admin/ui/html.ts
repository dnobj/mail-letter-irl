/**
 * An auto-escaping HTML template. Every interpolated value is escaped unless
 * it is already `SafeHtml` (the output of another `html` call or of `raw`),
 * so the only way to put markup on a page is to have built it here. There is
 * no `innerHTML` anywhere in the panel; a static test enforces that.
 */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

type Interpolation =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | SafeHtml
  | Interpolation[];

function render(value: Interpolation): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value instanceof Date) return escapeHtml(value.toISOString());
  if (value === true) return "true";
  return escapeHtml(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: Interpolation[]
): SafeHtml {
  let output = "";
  for (let index = 0; index < strings.length; index += 1) {
    output += strings[index];
    if (index < values.length) output += render(values[index]);
  }
  return new SafeHtml(output);
}

/** Only for markup the server itself assembled; never for request data. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

export function join(parts: SafeHtml[], separator = ""): SafeHtml {
  return new SafeHtml(parts.map((part) => part.value).join(separator));
}
