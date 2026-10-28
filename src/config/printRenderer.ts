/**
 * Which renderer new letter previews are drawn with (#534).
 *
 * - `pdf`: our own renderer (src/render). The preview is the page as it
 *   prints, the draft records RENDERER_VERSION, and the letter prints from
 *   our own PDF.
 * - `html`, and anything else or unset: the legacy HTML, printed in PostGrid's
 *   Open Sans (#526).
 *
 * It is read when a letter is previewed, never when it is sent: a letter
 * prints with the version its draft recorded, so changing this never changes
 * a letter already previewed or queued. Either way a gift send prints its
 * card as a second page.
 */
export function printRenderer(env: NodeJS.ProcessEnv = process.env): 'html' | 'pdf' {
  return (env.LETTER_IRL_PRINT_RENDERER ?? '').trim().toLowerCase() === 'pdf' ? 'pdf' : 'html';
}
