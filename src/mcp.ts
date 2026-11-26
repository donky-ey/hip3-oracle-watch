// MCP server over stdio. Read-only: five tools that answer from the local store.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NotFound, type Queries } from "./query.ts";

const EVENT_KINDS = [
  "mode_switch", "basis_breach", "oracle_jump", "oracle_stale", "funding_extreme", "oi_cap_near", "calendar_conflict",
] as const;

export function buildServer(q: Queries): McpServer {
  const server = new McpServer({ name: "hip3-oracle-watch", version: "0.1.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  const reply = (fn: () => unknown) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(fn(), null, 2) }] };
    } catch (e) {
      if (e instanceof NotFound || e instanceof RangeError) {
        return { isError: true, content: [{ type: "text" as const, text: e.message }] };
      }
      throw e;
    }
  };
  const coin = z.string().describe('Perp name, e.g. "xyz:NVDA". A bare ticker such as "NVDA" also works.');

  server.registerTool("get_oracle_state", {
    title: "Oracle state for one perp",
    description:
      "Current oracle state of a Hyperliquid HIP-3 perp: whether the oracle appears to follow an external market or the deployer's internal pricing, with the evidence, plus mark/oracle basis, funding and the next scheduled session change. The state is an inference, not published by the deployer.",
    inputSchema: { coin },
    annotations: readOnly,
  }, ({ coin }) => reply(() => q.oracleState(coin)));

  server.registerTool("list_dislocations", {
    title: "Perps with a wide mark/oracle gap",
    description:
      "Perps whose mark price is furthest from the oracle right now, largest gap first. Optionally filter by oracle state.",
    inputSchema: {
      minBp: z.number().min(0).default(20).describe("Minimum absolute basis in basis points."),
      state: z.enum(["external", "internal", "transition", "stale", "unknown"]).optional(),
      limit: z.number().int().min(1).max(200).default(25),
    },
    annotations: readOnly,
  }, ({ minBp, state, limit }) => reply(() => q.dislocations(minBp, state, limit)));

  server.registerTool("get_events", {
    title: "Detector events",
    description:
      "Recent events from the detector, newest first: oracle mode switches, basis breaches, oracle jumps, stale oracles, extreme funding, open-interest cap proximity and calendar conflicts.",
    inputSchema: {
      coin: coin.optional(),
      kind: z.enum(EVENT_KINDS).optional(),
      hours: z.number().positive().max(24 * 30).default(24),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: readOnly,
  }, (a) => reply(() => q.events(a)));

  server.registerTool("get_basis_history", {
    title: "Basis and funding history",
    description:
      "Time series of mark/oracle basis (basis points) and hourly funding for one perp. Raw ticks cover the last seven days; older history comes from one-minute bars.",
    inputSchema: {
      coin,
      hours: z.number().positive().max(24 * 90).default(6),
      intervalMinutes: z.number().int().min(1).max(1440).default(5),
    },
    annotations: readOnly,
  }, ({ coin, hours, intervalMinutes }) => reply(() => q.basisHistory(coin, hours, intervalMinutes)));

  server.registerTool("get_session_calendar", {
    title: "Underlying market sessions",
    description:
      "Trading sessions of the market a perp references: current phase and the next scheduled opens and closes. Hours are hand-compiled; check the verified flag.",
    inputSchema: { coin },
    annotations: readOnly,
  }, ({ coin }) => reply(() => q.sessionCalendar(coin)));

  return server;
}

export async function runStdio(q: Queries): Promise<void> {
  await buildServer(q).connect(new StdioServerTransport());
}
