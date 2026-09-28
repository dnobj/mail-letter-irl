# The official MCP Registry

**Last Updated:** September 28, 2026
**Purpose:** How Letter IRL is listed in the MCP Registry (#468), and how to publish an update

The [MCP Registry](https://registry.modelcontextprotocol.io) lists MCP servers for apps and other directories to discover. Letter IRL is listed as a remote server: there is no package to install, only the address, and each app signs in with its own client (see the Connect page, `https://letterirl.com/connect`).

The listing is `server.json` at the repository root:

- **Name:** `com.letterirl/letter-irl`. The `com.letterirl/` namespace belongs to whoever proves control of `letterirl.com` by DNS.
- **Remote:** Streamable HTTP at `https://api.letterirl.com/mcp`, production only. Development is never listed.
- **Icon:** `https://letterirl.com/icon-512.png`, the square logo.
- **Version:** the listing's own version, raised for every publish. It is not the API's version.

The schema limits the description to 100 characters. The registry is in preview, so its schema and rules may change; check [the registry's guide to remote servers](https://modelcontextprotocol.io/registry/remote-servers) before each publish.

## Publishing

Only after production serves the launch version, since the listing points people at production.

1. **Make a signing key, and keep it private.** It proves control of the domain and never goes in the repository.
   - Generate an Ed25519 key pair, for example `openssl genpkey -algorithm ed25519 -out mcp-registry-key.pem`.
   - Keep the private key with the other secrets outside the repository.
2. **Publish the public key in DNS.** A TXT record on the apex of `letterirl.com`: `v=MCPv1; k=ed25519; p=<base64 public key>`.
   - `mcp-publisher login dns` prints the exact record to add.
   - Alternatively, the registry accepts the same key served at `https://letterirl.com/.well-known/mcp-registry-auth`.
3. **Sign in to the registry:** `mcp-publisher login dns --domain letterirl.com --private-key <key>`.
4. **Publish from the repository root:** `mcp-publisher publish`. It reads `server.json`.
5. **Check the listing:** search the registry for `letter-irl`, and confirm the name, the address and the icon.

For an update, raise `version` in `server.json`, merge, then repeat steps 3 and 4 from the merged commit.
