import type { Context } from 'hono';
import { siteAccessSql, userForSubject, type User } from './auth';
import type { AppEnv, Env, Site } from './env';
import { randomId, sha256Hex } from './lib/crypto';
import { PERIODS } from './lib/time';
import { currencyDecimals } from './payments';
import {
  SESSION_DIMS,
  breakdown,
  cleanFunnelSteps,
  ctxFor,
  customers,
  funnel,
  overview,
  realtime,
  visitorProfile,
  visitors,
  type FunnelStep,
} from './stats';

/**
 * MCP server (Streamable HTTP, stateless JSON responses) so AI assistants like Claude can read stats and manage funnels.
 * Auth: `Authorization: Bearer mlmcp_...`, a token created in site settings. It sees the same sites as its creator.
 */

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_TOKEN_PREFIX = 'mlmcp_';

const INSTRUCTIONS = `Minilytics is web analytics with revenue attribution. Start with list_sites to get site ids.
Money amounts are integers in the currency's minor units (e.g. cents): divide by 10^decimals (list_sites gives currency and decimals).
Periods: today, yesterday, 24h, 48h, 7d, 30d (default), 90d, 12m, all, or custom with from/to (YYYY-MM-DD, site timezone).
Filters narrow every report to matching visits, e.g. {"country":"US"} or {"utm_campaign":"launch"}; an empty string matches "none".
A visitor id is the ml_vid cookie set by the tracking script.`;

// ---------- tokens

export function newMcpToken() {
  return MCP_TOKEN_PREFIX + randomId(24);
}

/** The account a bearer token acts as, or null. */
export async function mcpUser(c: Context<AppEnv>): Promise<User | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m || !m[1].startsWith(MCP_TOKEN_PREFIX)) return null;
  const row = await c.env.DB.prepare('SELECT id, subject FROM mcp_tokens WHERE token_hash = ?')
    .bind(await sha256Hex(m[1]))
    .first<{ id: string; subject: string }>();
  if (!row) return null;
  const touch = c.env.DB.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  try {
    c.executionCtx.waitUntil(touch);
  } catch {
    await touch;
  }
  return userForSubject(c.env, row.subject);
}

// ---------- tools

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });

const FILTER_KEYS = [
  'channel', 'source', 'referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref',
  'country', 'region', 'city', 'browser', 'os', 'device', 'entry_page', 'exit_page', 'hostname', 'page', 'goal',
];

const SITE = { site_id: str('Site id (or its domain) from list_sites') };
const RANGE = {
  period: str('Time range, default 30d', { enum: [...PERIODS] }),
  from: str('First day (YYYY-MM-DD) when period is custom'),
  to: str('Last day, inclusive (YYYY-MM-DD) when period is custom'),
  filters: {
    type: 'object',
    description: 'Only count visits matching all of these, e.g. {"country":"US","source":"Google"}. "page" and "goal" match visits that viewed that page / completed that goal.',
    properties: Object.fromEntries(FILTER_KEYS.map((k) => [k, { type: 'string' }])),
    additionalProperties: false,
  },
};
const STEPS = {
  type: 'array',
  minItems: 2,
  maxItems: 10,
  description: 'Steps in order. A page step matches a path and supports * wildcards (/blog/*); a goal step matches a goal name.',
  items: {
    type: 'object',
    properties: { type: { type: 'string', enum: ['page', 'goal'] }, value: { type: 'string' } },
    required: ['type', 'value'],
  },
};

type Args = Record<string, any>;

interface Tool {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  readOnly?: boolean;
  run: (env: Env, user: User, args: Args) => Promise<unknown>;
}

async function findSite(env: Env, user: User, idOrDomain: unknown): Promise<Site> {
  if (typeof idOrDomain !== 'string' || !idOrDomain) throw new ToolError('site_id is required');
  const access = siteAccessSql(env, user);
  const site = await env.DB.prepare(`SELECT s.* FROM sites s WHERE (s.id = ? OR s.domain = ?) AND ${access.sql} LIMIT 1`)
    .bind(idOrDomain, idOrDomain.toLowerCase(), ...access.params)
    .first<Site>();
  if (!site) throw new ToolError(`No site "${idOrDomain}". Call list_sites to see the ids you can use.`);
  return site;
}

function rangeQuery(a: Args) {
  return {
    period: typeof a.period === 'string' ? a.period : undefined,
    from: typeof a.from === 'string' ? a.from : undefined,
    to: typeof a.to === 'string' ? a.to : undefined,
    filters: a.filters && typeof a.filters === 'object' ? JSON.stringify(a.filters) : undefined,
  };
}

async function siteCtx(env: Env, user: User, a: Args) {
  const site = await findSite(env, user, a.site_id);
  return ctxFor(env.DB, site, rangeQuery(a));
}

const money = (site: Site) => ({ currency: site.currency, decimals: currencyDecimals(site.currency) });
const limitOf = (a: Args, max: number, def: number) => Math.max(1, Math.min(max, Number(a.limit) || def));

const TOOLS: Tool[] = [
  {
    name: 'list_sites',
    description: 'List the websites you can access, with visitors in the last 24 hours.',
    properties: {},
    readOnly: true,
    async run(env, user) {
      const access = siteAccessSql(env, user);
      const now = Date.now();
      const [sites, stats] = await env.DB.batch([
        env.DB.prepare(`SELECT s.id, s.name, s.domain, s.timezone, s.currency, s.created_at FROM sites s WHERE ${access.sql} ORDER BY s.created_at`).bind(
          ...access.params,
        ),
        env.DB.prepare('SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors FROM sessions WHERE started_at > ? GROUP BY site_id').bind(now - 86_400_000),
      ]);
      const by = new Map((stats.results as any[]).map((r) => [r.site_id, r.visitors]));
      return (sites.results as any[]).map((s) => ({ ...s, decimals: currencyDecimals(s.currency), visitors24h: by.get(s.id) ?? 0 }));
    },
  },
  {
    name: 'get_overview',
    description:
      'Headline numbers for a period (visitors, sessions, pageviews, bounce rate, avg duration, revenue, customers, conversion rate) vs the previous period, people online now, and a time series.',
    properties: { ...SITE, ...RANGE, granularity: str('Time series bucket, picked automatically if omitted', { enum: ['hour', 'day', 'week', 'month'] }) },
    required: ['site_id'],
    readOnly: true,
    async run(env, user, a) {
      const site = await findSite(env, user, a.site_id);
      return overview(ctxFor(env.DB, site, { ...rangeQuery(a), granularity: typeof a.granularity === 'string' ? a.granularity : undefined }));
    },
  },
  {
    name: 'get_breakdown',
    description: 'Top values of one dimension (sources, pages, countries, goals...) with visitors, pageviews, revenue and customers for each.',
    properties: {
      ...SITE,
      dimension: str('What to group by', { enum: [...Object.keys(SESSION_DIMS), 'page', 'goal', 'exit_link'] }),
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max rows, default 50' },
      ...RANGE,
    },
    required: ['site_id', 'dimension'],
    readOnly: true,
    async run(env, user, a) {
      const ctx = await siteCtx(env, user, a);
      return { ...money(ctx.site), rows: await breakdown(ctx, String(a.dimension), limitOf(a, 500, 50)) };
    },
  },
  {
    name: 'list_visitors',
    description: 'Most recent visitors in the period (the Users tab): ml_vid cookie id, name/email if identified, source, location, device, visits, pages, time on site, amount spent.',
    properties: { ...SITE, ...RANGE, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max rows, default 50' } },
    required: ['site_id'],
    readOnly: true,
    async run(env, user, a) {
      const ctx = await siteCtx(env, user, a);
      return { ...money(ctx.site), visitors: (await visitors(ctx)).slice(0, limitOf(a, 200, 50)) };
    },
  },
  {
    name: 'get_visitor',
    description: 'Full history of one visitor: every visit with its attribution, pages viewed, goals, outbound clicks and payments.',
    properties: { ...SITE, visitor_id: str('The visitor id (ml_vid cookie value)') },
    required: ['site_id', 'visitor_id'],
    readOnly: true,
    async run(env, user, a) {
      if (typeof a.visitor_id !== 'string' || !a.visitor_id) throw new ToolError('visitor_id is required');
      const site = await findSite(env, user, a.site_id);
      return visitorProfile(env.DB, site, a.visitor_id);
    },
  },
  {
    name: 'list_customers',
    description: 'Payments in the period (the Journey tab), each with the paying visitor and the visit that gets credit (source, campaign, location...).',
    properties: { ...SITE, ...RANGE },
    required: ['site_id'],
    readOnly: true,
    async run(env, user, a) {
      const ctx = await siteCtx(env, user, a);
      return { ...money(ctx.site), payments: await customers(ctx) };
    },
  },
  {
    name: 'get_realtime',
    description: 'Who is on the site right now (last 5 minutes) and a feed of pageviews, goals and payments from the last 30 minutes.',
    properties: { ...SITE },
    required: ['site_id'],
    readOnly: true,
    async run(env, user, a) {
      return realtime(env.DB, await findSite(env, user, a.site_id));
    },
  },
  {
    name: 'list_funnels',
    description: 'Saved funnels of a site and their steps.',
    properties: { ...SITE },
    required: ['site_id'],
    readOnly: true,
    async run(env, user, a) {
      const site = await findSite(env, user, a.site_id);
      const res = await env.DB.prepare('SELECT id, name, steps, created_at FROM funnels WHERE site_id = ? ORDER BY created_at').bind(site.id).all();
      return res.results.map((f: any) => ({ ...f, steps: JSON.parse(f.steps) }));
    },
  },
  {
    name: 'get_funnel_stats',
    description: 'How many visitors reached each step of a funnel, in order, in the period. Pass funnel_id for a saved funnel, or steps to try one without saving.',
    properties: { ...SITE, funnel_id: str('A saved funnel id from list_funnels'), steps: STEPS, ...RANGE },
    required: ['site_id'],
    readOnly: true,
    async run(env, user, a) {
      const ctx = await siteCtx(env, user, a);
      let steps: FunnelStep[];
      if (a.funnel_id) {
        const f = await env.DB.prepare('SELECT steps FROM funnels WHERE id = ? AND site_id = ?').bind(String(a.funnel_id), ctx.site.id).first<{ steps: string }>();
        if (!f) throw new ToolError('Funnel not found. Call list_funnels to see the ids.');
        steps = JSON.parse(f.steps);
      } else {
        steps = cleanFunnelSteps(a.steps);
        if (steps.length < 2) throw new ToolError('Pass funnel_id, or at least 2 steps');
      }
      const rows = await funnel(ctx, steps);
      const rate = (n: number, of: number) => (of ? n / of : 0);
      return rows.map((r, i) => ({
        ...r,
        conversion_from_start: rate(r.visitors, rows[0].visitors),
        conversion_from_previous: i ? rate(r.visitors, rows[i - 1].visitors) : 1,
      }));
    },
  },
  {
    name: 'create_funnel',
    description: 'Save a funnel so it shows in the dashboard Funnel tab. Tip: check pages and goals that exist first with get_breakdown (dimension page / goal), and try the steps with get_funnel_stats.',
    properties: { ...SITE, name: str('Funnel name, e.g. "Signup"'), steps: STEPS },
    required: ['site_id', 'name', 'steps'],
    async run(env, user, a) {
      const site = await findSite(env, user, a.site_id);
      const steps = cleanFunnelSteps(a.steps);
      const name = typeof a.name === 'string' ? a.name.trim().slice(0, 100) : '';
      if (!name || steps.length < 2) throw new ToolError('A funnel needs a name and at least 2 steps');
      const id = randomId(8);
      await env.DB.prepare('INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, site.id, name, JSON.stringify(steps), Date.now())
        .run();
      return { id, name, steps };
    },
  },
  {
    name: 'delete_funnel',
    description: 'Delete a saved funnel.',
    properties: { ...SITE, funnel_id: str('Funnel id from list_funnels') },
    required: ['site_id', 'funnel_id'],
    async run(env, user, a) {
      const site = await findSite(env, user, a.site_id);
      const r = await env.DB.prepare('DELETE FROM funnels WHERE id = ? AND site_id = ?').bind(String(a.funnel_id), site.id).run();
      if (!r.meta.changes) throw new ToolError('Funnel not found');
      return { ok: true };
    },
  },
];

class ToolError extends Error {}

function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}) },
    annotations: { readOnlyHint: !!t.readOnly, destructiveHint: t.name.startsWith('delete_'), openWorldHint: false },
  }));
}

// ---------- JSON-RPC

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

const rpcError = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function dispatch(env: Env, user: User, req: RpcRequest) {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
  switch (req.method) {
    case 'initialize': {
      const asked = req.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'minilytics', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: toolList() });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === req.params?.name);
      if (!tool) return rpcError(req.id, -32602, `Unknown tool: ${req.params?.name}`);
      try {
        const out = await tool.run(env, user, req.params?.arguments ?? {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      } catch (e) {
        // Tool failures go back to the model as a result it can read and recover from.
        const msg = e instanceof ToolError ? e.message : `Failed: ${(e as Error).message}`;
        return ok({ content: [{ type: 'text', text: msg }], isError: true });
      }
    }
    default:
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

export async function handleMcp(c: Context<AppEnv>) {
  if (c.req.method !== 'POST') return c.body(null, 405, { Allow: 'POST' });
  const user = await mcpUser(c);
  if (!user) {
    return c.json(rpcError(null, -32001, 'Unauthorized: send "Authorization: Bearer mlmcp_..." (create a token in site settings → AI access)'), 401, {
      'WWW-Authenticate': 'Bearer realm="minilytics"',
    });
  }
  const body = await c.req.json<RpcRequest | RpcRequest[]>().catch(() => null);
  if (!body || typeof body !== 'object') return c.json(rpcError(null, -32700, 'Parse error'), 400);
  const reqs = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const r of reqs) {
    // Responses from the client (to requests we never send) get no reply.
    if (r && typeof r === 'object' && !('method' in r) && ('result' in r || 'error' in r)) continue;
    if (!r || r.jsonrpc !== '2.0' || typeof r.method !== 'string') {
      replies.push(rpcError(r?.id, -32600, 'Invalid request'));
      continue;
    }
    // Notifications (no id) get no reply.
    if (r.id === undefined || r.id === null) continue;
    replies.push(await dispatch(c.env, user, r));
  }
  if (!replies.length) return c.body(null, 202);
  return c.json(Array.isArray(body) ? replies : replies[0]);
}
