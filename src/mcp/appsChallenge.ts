/**
 * The ChatGPT plugin portal's domain verification (#407).
 *
 * When an app with an MCP server is submitted, the portal issues a token and
 * fetches it from `https://<MCP host or a parent host>/.well-known/openai-apps-challenge`,
 * expecting that plugin's token and nothing else: no JSON, no list, no second
 * token (developers.openai.com/plugins/deploy/submission). The default
 * challenge host is the MCP server's own, so this server answers it.
 *
 * The token is set per environment in OPENAI_APPS_CHALLENGE_TOKEN once the
 * portal issues one. Until then the path answers 404, like any unknown path.
 * The body is the token exactly, with no trailing newline, and nothing caches
 * it: a stale token was a suspected cause of failed verifications reported to
 * OpenAI.
 */

export const APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

export interface AppsChallengeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function appsChallengeResponse(
  method: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AppsChallengeResponse {
  const token = (env.OPENAI_APPS_CHALLENGE_TOKEN ?? "").trim();
  if (!token || (method !== "GET" && method !== "HEAD")) {
    return { status: 404, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  return {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    body: method === "HEAD" ? "" : token,
  };
}
