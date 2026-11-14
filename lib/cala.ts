// Server only. The one live call the app makes: read an attendee's profile from Cala when it is not cached.
// The key never leaves the server; every call is logged; a cached profile is never fetched again.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, getGraph, type RawEntity } from "./graph";
import type { LiveCall } from "./types";

const BASE = "https://api.cala.ai/v1";
const LOG = path.join(DATA_DIR, "cala_calls.jsonl");
const MIN_GAP_MS = 6500; // free plan: 10 calls per minute
const TIMEOUT_MS = 20000;

// Same projection as tools/cala.py, so files written here and by the crawler are interchangeable.
const COMPANY_PROPS = [
  "name", "legal_name", "aliases", "website", "description", "founding_date", "headquarters_address",
  "registered_address", "operational_status", "company_ownership_status", "employee_count_range",
  "total_funding", "total_funding_units", "total_funding_excluding_debt", "funding_stage",
];
const ORG_PROPS = ["name", "aliases", "website", "description", "founding_date", "registered_address"];
const RELS = {
  outgoing: [
    "PARTICIPATES_IN_FUNDING_ROUND", "PARTICIPATES_IN_CORPORATE_EVENT", "PARTICIPATES_IN_EVENT",
    "OPERATES_IN_INDUSTRY", "HAS_HEADQUARTERS_IN", "IS_REGISTERED_IN", "HAS_PRESENCE_IN", "INVESTED_IN",
  ],
  incoming: ["INVESTED_IN", "FOUNDED", "IS_CEO_OF", "IS_CTO_OF", "IS_BOARD_MEMBER_OF", "WORKS_AT"],
};

interface State {
  liveCalls: number;
  last: number;
  queue: Promise<unknown>;
  inflight: Map<string, Promise<{ entity?: RawEntity; live: LiveCall }>>;
}

const holder = globalThis as unknown as { __twoHopsCala?: State };
const state: State = (holder.__twoHopsCala ??= { liveCalls: 0, last: 0, queue: Promise.resolve(), inflight: new Map() });

function apiKey(): string | null {
  const k = process.env.CALA_API_KEY?.trim();
  if (k) return k;
  try {
    for (const raw of fs.readFileSync(path.join(os.homedir(), ".cala_key"), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      return line.includes("=") ? line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") : line;
    }
  } catch {
    // no key file
  }
  return null;
}

function creditsLogged(): number | null {
  try {
    let n = 0;
    for (const line of fs.readFileSync(LOG, "utf8").split(/\r?\n/)) {
      if (line.trim()) n += Number(JSON.parse(line).credits ?? 0);
    }
    return n;
  } catch {
    return null;
  }
}

export function liveBudgetLeft(): number {
  if (!apiKey()) return 0;
  const perProcess = Number(process.env.CALA_LIVE_BUDGET ?? 10) - state.liveCalls;
  const used = creditsLogged();
  const monthly = used === null ? Infinity : Number(process.env.CALA_MONTHLY_CREDITS ?? 100) - used;
  return Math.max(0, Math.min(perProcess, monthly));
}

function logCall(entry: Record<string, unknown>) {
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    console.log("[cala call]", JSON.stringify(entry)); // read-only disk: keep the record in the server log
  }
}

async function spaced<T>(fn: () => Promise<T>): Promise<T> {
  const run = state.queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - state.last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    state.last = Date.now();
    return fn();
  });
  state.queue = run.catch(() => undefined);
  return run;
}

/** Read one attendee profile from Cala, cache it on disk, and take it into the graph. */
export function fetchProfile(id: string, entityType: string): Promise<{ entity?: RawEntity; live: LiveCall }> {
  const running = state.inflight.get(id);
  if (running) return running;
  const p = doFetch(id, entityType).finally(() => state.inflight.delete(id));
  state.inflight.set(id, p);
  return p;
}

async function doFetch(id: string, entityType: string): Promise<{ entity?: RawEntity; live: LiveCall }> {
  const key = apiKey();
  if (!key) return { live: { called: false, error: "The server has no Cala key, so it works from the cached graph only.", budgetLeft: 0 } };
  if (liveBudgetLeft() <= 0) {
    return { live: { called: false, error: "The live-call budget is used up; working from the cached graph only.", budgetLeft: 0 } };
  }
  state.liveCalls++; // counted before the call so parallel requests cannot overshoot the budget
  const body = {
    properties: entityType === "Organization" ? ORG_PROPS : COMPANY_PROPS,
    relationships: Object.fromEntries(
      Object.entries(RELS).map(([dir, rels]) => [dir, Object.fromEntries(rels.map((r) => [r, { limit: 1000, offset: 0 }]))]),
    ),
  };
  return spaced(async () => {
    const t0 = Date.now();
    let status = 0;
    let text = "";
    try {
      const res = await fetch(`${BASE}/entities/${id}`, {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "two-hops/1.0" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      text = JSON.stringify({ client_error: String(e) });
    }
    const seconds = Math.round((Date.now() - t0) / 10) / 100;
    const saved = `data/companies/${id}.json`;
    let entity: RawEntity | undefined;
    try {
      const j = JSON.parse(text) as RawEntity;
      if (status === 200 && j?.id) entity = j;
    } catch {
      // not JSON
    }
    logCall({
      ts: new Date().toISOString().replace(/\.\d+Z$/, "+00:00"),
      method: "POST",
      path: `/entities/${id}`,
      purpose: "find yourself: live profile read from the app",
      status,
      seconds,
      bytes: text.length,
      credits: 1,
      ...(entity ? { saved } : {}),
    });
    if (!entity) {
      const why = status === 429 ? "Cala's rate limit was hit" : status === 0 ? "Cala did not answer in time" : `Cala answered HTTP ${status}`;
      return { live: { called: true, seconds, status, error: `${why}; working from the cached graph only.`, budgetLeft: liveBudgetLeft() } };
    }
    try {
      fs.mkdirSync(path.join(DATA_DIR, "companies"), { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, "companies", `${id}.json`), JSON.stringify(entity, null, 1), "utf8");
    } catch {
      // read-only disk: the profile still lives in memory for this server
    }
    getGraph().ingest(entity, saved);
    return { entity, live: { called: true, seconds, status, budgetLeft: liveBudgetLeft() } };
  });
}
