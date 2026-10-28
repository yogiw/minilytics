# AGENTS.md

This repo is a **fork** of [surendrapandar/minilytics](https://github.com/surendrapandar/minilytics) that carries a few
features upstream doesn't have. This file tells AI agents what those features are and exactly where they touch upstream code,
so they survive when upstream changes are merged in and conflicts can be resolved without losing either side.

## Repo setup

| Remote | Repo | Use |
| --- | --- | --- |
| `fork` | `yogiw/minilytics` | Our repo. Push branches here and open PRs against its `main`. |
| `origin` | `surendrapandar/minilytics` | Upstream. **Pull only. Never push, never open PRs here.** |

- Work on a branch, push it to `fork`, and open a PR with `gh pr create --repo yogiw/minilytics --base main`. The owner reviews and merges.
- **Never deploy** (`npm run deploy`, `wrangler deploy`, `wrangler d1 migrations apply --remote`) unless the owner asks in that conversation.
- `wrangler.jsonc` has a local, uncommitted change: the real D1 `database_id`. Never commit it, and keep it when switching branches or merging.

## Syncing with upstream

```bash
git stash                      # keeps the local wrangler.jsonc change safe
git checkout main && git pull --ff-only fork main
git checkout -b sync/upstream-YYYY-MM-DD
git fetch origin && git merge origin/main   # resolve conflicts using the rules below
npm run typecheck && npm test && npm run build
git push -u fork HEAD          # then open a PR on yogiw/minilytics
git stash pop
```

Prefer `merge` over `rebase` so each sync is one reviewable PR.

## General rule for conflicts

**Keep both sides.** Take upstream's change, then re-apply the fork's change on top of it. Never drop an upstream change
to make ours fit, and never drop a fork feature listed below. If upstream rewrote the area so much that our change no
longer fits, re-implement the feature against the new code (the intent is described below) and say so in the PR.

After resolving, check every item in [Checklist after a merge](#checklist-after-a-merge).

---

## Fork feature 1: `ml_vid` cookie id in the dashboard

**Intent:** show each visitor's `ml_vid` cookie value (= `visitor_id` in the DB), click to copy, in the **Users tab** and the
**visitor profile modal**. The modal also shows `user_id` if the visitor was identified.

| File | What the fork adds |
| --- | --- |
| `src/dashboard/components/CookieId.tsx` | New file. A chip `ml_vid <id>` that copies on click and calls `e.stopPropagation()` so the table row doesn't open the modal. |
| `src/dashboard/components/GoalsPanel.tsx` | `import { CookieId }`; `VisitorCell` takes an extra `showId` prop and renders `{showId && id && <CookieId id={id} className="mt-1" />}` after the location/device line; the `Users` table passes `showId` to `VisitorCell` (the Journey table doesn't). |
| `src/dashboard/components/VisitorModal.tsx` | `import { CookieId }`; under the name/email in the header, a row with `<CookieId id={visitorId!} />` and the `user_id` chip. |

Conflict tips: if upstream restructures `VisitorCell` or the modal header, put the chip back under the visitor's name.
The API already returns `visitor_id`, so no backend change is part of this feature.

## Fork feature 2: MCP server for AI assistants

**Intent:** `POST /api/mcp` is an MCP server (Streamable HTTP, stateless, plain JSON responses, no SDK dependency) so
Claude, Cursor and similar clients can read stats and manage funnels. Auth is a bearer token `mlmcp_...` created in site settings.
A token acts as the account that created it and sees exactly the sites that account can see.

| File | What the fork adds |
| --- | --- |
| `src/worker/mcp.ts` | New file. Token check (`mcpUser`), the 11 tools, and the JSON-RPC handler (`handleMcp`). |
| `migrations/0008_mcp_tokens.sql` | New table `mcp_tokens` (`subject`, `token_hash` = SHA-256, `prefix`, `last_used_at`). |
| `src/worker/index.ts` | Imports `handleMcp, newMcpToken`, `sha256Hex` and `subjectOf`; route `app.all('/api/mcp', handleMcp)` in the public section; a "MCP tokens" section (`GET/POST /api/mcp-tokens`, `DELETE /api/mcp-tokens/:tid`, guarded by `requireUser`) placed just before the "dashboard API" section; `POST /api/sites/:id/funnels` uses `cleanFunnelSteps(b.steps)`. |
| `src/worker/auth.ts` | `currentUser` was split: the part after the expiry check is now `userForSubject(env, subject)` (subject is `"admin"` or `"u:<userId>"`), and `currentUser` ends with `return userForSubject(c.env, parts[0])`. Adds `subjectOf(user)`. |
| `src/worker/stats.ts` | `makeCtx` delegates to the new exported `ctxFor(db, site, q)`; `SESSION_DIMS` is `export`ed; new exported `cleanFunnelSteps(raw)` (moved out of `index.ts`). |
| `src/worker/lib/crypto.ts` | New `sha256Hex(value)`. |
| `src/dashboard/pages/Settings.tsx` | `fmtAgo` import; `<McpAccess origin={origin} />` rendered right after `<AiSetup … />`; `McpToken` interface and `McpAccess` component (create/list/revoke tokens and config snippets for Claude Code, mcp.json and Claude Desktop). |
| `README.md` | "AI access (MCP)" section before "Accuracy notes". |

The MCP tools call the same functions the dashboard uses: `overview`, `breakdown`, `visitors`, `visitorProfile`, `customers`,
`realtime` and `funnel` from `stats.ts`, plus `siteAccessSql` and `userForSubject` from `auth.ts`.

Conflict tips:
- **`auth.ts`:** if upstream changes how a user is loaded (new `User` fields, new plan logic), put that change in
  `userForSubject`, not in `currentUser`, so cookie logins and MCP tokens stay identical.
- **`stats.ts`:** if upstream changes `makeCtx`, apply the change inside `ctxFor`. If upstream changes funnel step
  validation in `index.ts`, move that change into `cleanFunnelSteps`. MCP `create_funnel` and `get_funnel_stats` use it too.
- **Signature changes:** if upstream changes the signature or return shape of a stats function used by `mcp.ts`, update
  the matching tool in `mcp.ts`, including its description and `properties` schema.
- **New stats:** if upstream adds a new dashboard report or filter (for example a new entry in `SESSION_FILTERS`), consider
  exposing it. Add it to `FILTER_KEYS` or add a tool in `mcp.ts`, and mention this in the PR.
- **New tables:** if upstream adds a table to the `DELETE FROM …` list in `app.delete('/api/sites/:id')`, nothing is
  needed. `mcp_tokens` is per account, not per site.
- **Migrations:** never rename or renumber `0008_mcp_tokens.sql`. Production already applied it, and D1 tracks
  migrations by file name. If upstream adds its own `0008_*.sql` or later files, keep them all. D1 applies whichever names
  aren't recorded yet. Check that upstream's migration doesn't create a table or column that clashes with `mcp_tokens`.

## Fork feature 3: link builder with more platforms and custom source/medium

**Intent:** the Settings → Link builder "Where you post it" dropdown has grouped presets for Social, Chat,
Communities & writing and Other, plus **Custom…**. Editable **Source** and **Medium** fields are prefilled by the preset.
Typing your own value switches the dropdown to Custom. Values are slugged (trimmed, lowercased, spaces become `-`).

| File | What the fork adds |
| --- | --- |
| `src/dashboard/pages/Settings.tsx` | The old flat `PRESETS` array is replaced by `Preset`, `PRESET_GROUPS`, `PRESETS = PRESET_GROUPS.flatMap(...)`, `CUSTOM` and `slug()`. `LinkBuilder` keeps `source`/`medium` state instead of a selected preset, uses an `<optgroup>` select, and adds Source/Medium inputs. |
| `src/shared/sources.ts` | `KNOWN_SOURCES` entries for WhatsApp, Telegram and Discord, inserted just before Hacker News. |
| `test/core.test.ts` | The test "names every link builder platform from its utm_source". |

Conflict tips:
- **New upstream presets:** if upstream adds a preset to its flat `PRESETS` list, add it to the right group in `PRESET_GROUPS` instead.
- **New `KNOWN_SOURCES` entries:** keep both lists. Every preset `source` must be matched by a `KNOWN_SOURCES` regex. The test above enforces this, so add a case when you add a preset.

---

## Checklist after a merge

1. `git diff origin/main -- src migrations test README.md` still shows every fork change listed above.
2. `npm run typecheck && npm test && npm run build` pass.
3. Optional end-to-end check:
   - Run `npm run db:migrate:local && npm run seed`, then `npm run build && npm run dev:api`.
   - Log in with the password in `.dev.vars`.
   - Users tab: rows show the `ml_vid` chip, and the profile modal shows it too.
   - Settings → AI access (MCP): **Create token** works.
   - Call the endpoint with the token, for example
     `curl -H "Authorization: Bearer <token>" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' localhost:8787/api/mcp`.
     It should list the 11 tools, and calling `list_sites` should return the demo site.
   - Settings → Link builder: the grouped presets show, and typing a custom source switches the dropdown to "Custom…".
4. Open the PR on `yogiw/minilytics`. List any conflicts and how you resolved them. **Don't deploy** until asked.

## When adding a new fork feature

Add a section to this file with the same shape: intent, a table of files and exactly what changed, and conflict tips.
Keep fork changes small and placed at clear seams (new files and exported helpers) so upstream merges stay easy.
