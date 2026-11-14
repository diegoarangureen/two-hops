// Server only. The one live call the app makes: read an attendee's profile from Cala when it is not cached.
// The key never leaves the server; every call is logged; a cached profile is never fetched again.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, getGraph, type RawEntity } from "./graph";
import type { LiveCall } from "./types";

// CALA_API_BASE exists so the live call can be exercised against a local stand-in without spending credits.
const BASE = (process.env.CALA_API_BASE ?? "https://api.cala.ai/v1").replace(/\/+$/, "");
const LOG = path.join(DATA_DIR, "cala_calls.jsonl");
const MIN_GAP_MS = 6500; // Cala allows about 10 calls per minute
const TIMEOUT_MS = 20000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000; // a profile whose read failed is not asked for again for a while

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

type Result = { entity?: RawEntity; live: LiveCall };

interface State {
  /** Live calls started by this server process, in flight ones included. */
  started: number;
  /** Calls started but not yet written to the log. */
  pending: number;
  last: number;
  queue: Promise<unknown>;
  inflight: Map<string, Promise<Result>>;
  failed: Map<string, { at: number; why: string }>;
}

const holder = globalThis as unknown as { __twoHopsCala?: State };
const state: State = (holder.__twoHopsCala ??= { started: 0, pending: 0, last: 0, queue: Promise.resolve(), inflight: new Map(), failed: new Map() });
// a hot reload in development can hand back a state object made by an older version of this file
state.started ??= 0;
state.pending ??= 0;
state.failed ??= new Map();

function apiKey(): string | null {
  const k = process.env.CALA_API_KEY?.trim();
  if (k) return k;
  try {
    for (const raw of fs.readFileSync(path.join(os.homedir(), ".cala_key"), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line); // NAME=value, as in an env file
      return assignment ? assignment[1].trim().replace(/^["']|["']$/g, "") : line;
    }
  } catch {
    // no key file
  }
  return null;
}

/** A short tag that tells keys apart in the log without revealing them. Same as tools/cala.py. */
function keyId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 6);
}

/** A whole number from the environment, or the fallback when it is missing or not a number. */
function envNumber(name: string, fallback: number | null): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Credits the log holds for one key. A line that cannot be read is skipped, not allowed to hide the others. */
function creditsLogged(id: string): number {
  let n = 0;
  let text = "";
  try {
    text = fs.readFileSync(LOG, "utf8");
  } catch {
    return 0;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { credits?: number; key?: string };
      if (e.key === id) n += Number(e.credits ?? 0) || 0;
    } catch {
      // a damaged line: ignore it
    }
  }
  return n;
}

/**
 * Live calls this server may still make: CALA_LIVE_BUDGET per process (default 10), and, when
 * CALA_MONTHLY_CREDITS says what the plan allows, no more than what the log shows is left for this key.
 */
export function liveBudgetLeft(): number {
  const key = apiKey();
  if (!key) return 0;
  const perProcess = (envNumber("CALA_LIVE_BUDGET", 10) ?? 10) - state.started;
  const monthly = envNumber("CALA_MONTHLY_CREDITS", null);
  const monthlyLeft = monthly === null ? Infinity : monthly - creditsLogged(keyId(key)) - state.pending;
  return Math.max(0, Math.min(perProcess, monthlyLeft));
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
export function fetchProfile(id: string, entityType: string): Promise<Result> {
  const running = state.inflight.get(id);
  if (running) return running;
  const p = doFetch(id, entityType).finally(() => state.inflight.delete(id));
  state.inflight.set(id, p);
  return p;
}

async function doFetch(id: string, entityType: string): Promise<Result> {
  const key = apiKey();
  if (!key) return { live: { called: false, error: "The server has no Cala key, so it works from the cached graph only.", budgetLeft: 0 } };
  const failed = state.failed.get(id);
  if (failed && Date.now() - failed.at < RETRY_AFTER_FAILURE_MS) {
    return { live: { called: false, error: `${failed.why} a few minutes ago; not asking again yet. Working from the cached graph only.`, budgetLeft: liveBudgetLeft() } };
  }
  if (liveBudgetLeft() <= 0) {
    return { live: { called: false, error: "The live-call budget is used up; working from the cached graph only.", budgetLeft: 0 } };
  }
  // counted before the call, so requests arriving together cannot overshoot either budget
  state.started++;
  state.pending++;
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
      // the answer has to be the entity that was asked for: anything else is not cached under its name
      if (status === 200 && j?.id === id) entity = j;
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
      credits: status === 429 ? 0 : 1,
      key: keyId(key),
      ...(entity ? { saved } : {}),
    });
    state.pending--;
    if (!entity) {
      const why =
        status === 429 ? "Cala's rate limit was hit" : status === 0 ? "Cala did not answer in time" : status === 200 ? "Cala answered with a different entity" : `Cala answered HTTP ${status}`;
      state.failed.set(id, { at: Date.now(), why });
      return { live: { called: true, seconds, status, error: `${why}; working from the cached graph only.`, budgetLeft: liveBudgetLeft() } };
    }
    try {
      const dir = path.join(DATA_DIR, "companies");
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `${id}.json.tmp`); // written whole, then renamed: a reader never sees half a file
      fs.writeFileSync(tmp, JSON.stringify(entity, null, 1), "utf8");
      fs.renameSync(tmp, path.join(dir, `${id}.json`));
    } catch {
      // read-only disk: the profile still lives in memory for this server
    }
    getGraph().ingest(entity, saved);
    return { entity, live: { called: true, seconds, status, budgetLeft: liveBudgetLeft() } };
  });
}
