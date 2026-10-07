// Turns what the user said ("home", "the office", "John Wayne Airport") into a
// Place. When a name could mean several real places it returns the options
// instead of picking one, because booking a car to the wrong Main Street is
// worse than asking.

import type { LatLng, Place } from "./types";
import type { Fetcher } from "./uber";

/** The map search itself failed (not "no results"). */
export class MapUnavailable extends Error {}

export type GeoResult = { name: string; address: string; coords: LatLng; importance: number };

export interface Geocoder {
  search(query: string, near?: LatLng): Promise<GeoResult[]>;
}

export type Resolved =
  | { kind: "ok"; place: Place }
  | { kind: "ambiguous"; query: string; options: Place[] }
  | { kind: "not_found"; message: string };

const HOME = /^(home|my (home|house|place|apartment|apt)|back home|the house)$/i;
const WORK = /^(work|the office|office|my office|my work|my job)$/i;
const HERE = /^(here|current location|my location|where i am|from here)?$/i;
const LATLNG = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/;

/** Great-circle distance in miles. */
export function miles(a: LatLng, b: LatLng): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function clean(input: string): string {
  return input
    .trim()
    .replace(/^(to|from|at)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

export function savedPlaceId(input: string): "home" | "work" | null {
  const s = clean(input);
  if (HOME.test(s)) return "home";
  if (WORK.test(s)) return "work";
  return null;
}

export const isHere = (input: string | undefined) => HERE.test(clean(input ?? ""));

type SavedLookup = (id: "home" | "work") => Promise<{ address: string } | null>;

export class PlaceResolver {
  constructor(
    private readonly geocoder: Geocoder,
    private readonly saved: SavedLookup,
  ) {}

  private async search(q: string, near?: LatLng): Promise<GeoResult[]> {
    try {
      return await this.geocoder.search(q, near);
    } catch (e) {
      throw new MapUnavailable(`Map search is unavailable right now (${(e as Error).message}).`);
    }
  }

  async resolve(input: string, near?: LatLng): Promise<Resolved> {
    const s = clean(input);
    if (!s) return { kind: "not_found", message: "I need a place to go to." };

    const id = savedPlaceId(s);
    if (id) {
      const p = await this.saved(id);
      if (!p?.address) {
        return {
          kind: "not_found",
          message: `You don't have a ${id} address saved in Uber. Add one in the Uber app, or tell me the address.`,
        };
      }
      // Coordinates are needed for the price estimate; place_id is still sent so Uber uses its exact pin.
      const hit = (await this.search(p.address, near))[0];
      return { kind: "ok", place: { label: id, placeId: id, address: p.address, coords: hit?.coords } };
    }

    const m = s.match(LATLNG);
    if (m) {
      const coords = { lat: Number(m[1]), lng: Number(m[2]) };
      return { kind: "ok", place: { label: s, coords, address: s } };
    }

    let results = await this.search(s, near);
    if (results.length === 0) return { kind: "not_found", message: `I couldn't find "${s}" on the map.` };

    // Uber won't go over 100 miles, and a match that far away is almost always the wrong one.
    if (near) {
      const close = results.filter((r) => miles(near, r.coords) <= 100);
      if (close.length === 0) {
        // Short on purpose: this is spoken and shown on a card with a 64-character line.
        return { kind: "not_found", message: `${results[0].name} is over 100 miles away, past Uber's limit.` };
      }
      results = close;
    }

    // Collapse results that are really the same spot (an airport and its terminal).
    const distinct: GeoResult[] = [];
    for (const r of results) {
      if (!distinct.some((d) => miles(d.coords, r.coords) < 0.25)) distinct.push(r);
    }

    const [top, second] = distinct;
    const clearWinner = !second || top.importance - second.importance >= 0.15;
    if (!clearWinner) {
      return {
        kind: "ambiguous",
        query: s,
        options: distinct.slice(0, 4).map((r) => ({ label: r.name, address: r.address, coords: r.coords })),
      };
    }
    return { kind: "ok", place: { label: top.name, address: top.address, coords: top.coords } };
  }
}

/**
 * OpenStreetMap's Nominatim. Free, no key, but its usage policy requires an
 * identifying User-Agent and at most one request per second.
 */
export class NominatimGeocoder implements Geocoder {
  private last = 0;
  constructor(
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
    private readonly userAgent = "ride-home-voiceos/1.0 (https://github.com/saumyg3/ride-home)",
  ) {}

  async search(query: string, near?: LatLng): Promise<GeoResult[]> {
    const wait = this.last + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();

    const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "6" });
    if (near) {
      // Prefer nearby matches without excluding far ones.
      const d = 0.6;
      params.set("viewbox", `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
    }
    const res = await this.fetcher(`https://nominatim.openstreetmap.org/search?${params}`, {
      method: "GET",
      headers: { "User-Agent": this.userAgent, "Accept-Language": "en" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Map search failed (HTTP ${res.status})`);
    const rows: any[] = await res.json();
    return rows.map((r) => ({
      name: (r.name || String(r.display_name).split(",")[0]).trim(),
      address: String(r.display_name),
      coords: { lat: Number(r.lat), lng: Number(r.lon) },
      importance: Number(r.importance ?? 0),
    }));
  }
}
