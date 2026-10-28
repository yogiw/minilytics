-- Tokens for the MCP server (/api/mcp), so AI assistants can read stats and manage funnels.
-- A token acts as the account that created it: "admin" (self-hosted) or "u:<userId>" (hosted).
CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the token; the token itself is shown once and never stored
  prefix TEXT NOT NULL,            -- first characters, to tell tokens apart in the list
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX mcp_tokens_subject ON mcp_tokens (subject);
