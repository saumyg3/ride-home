// A tiny offline map of Orange County for demo mode and tests. Includes the
// awkward cases on purpose: a name that matches two different streets, and a
// place that's too far for Uber.

import type { Geocoder, GeoResult } from "../src/places";
import type { LatLng } from "../src/types";

const G = (name: string, address: string, lat: number, lng: number, importance: number, aliases: string[] = []) => ({
  name,
  address,
  coords: { lat, lng },
  importance,
  keys: [name, ...aliases].map((k) => k.toLowerCase()),
});

const PLACES = [
  G("Home", "4521 Campus Drive, Irvine, CA 92612", 33.6496, -117.8343, 0.3, ["4521 campus drive, irvine, ca 92612"]),
  G("Work", "100 Spectrum Center Drive, Irvine, CA 92618", 33.6505, -117.7437, 0.3, ["100 spectrum center drive, irvine, ca 92618"]),
  G("John Wayne Airport", "18601 Airport Way, Santa Ana, CA 92707", 33.6762, -117.8675, 0.72, ["sna", "the airport", "orange county airport", "airport"]),
  G("UC Irvine", "UC Irvine, Irvine, CA 92697", 33.6405, -117.8443, 0.68, ["uci", "campus"]),
  G("Irvine Spectrum Center", "670 Spectrum Center Drive, Irvine, CA 92618", 33.6496, -117.7425, 0.55, ["spectrum", "the spectrum"]),
  G("Disneyland", "1313 Disneyland Drive, Anaheim, CA 92802", 33.8121, -117.919, 0.8, ["disney"]),
  G("Main Street", "Main Street, Huntington Beach, CA 92648", 33.6603, -117.9992, 0.4, ["main street", "main st"]),
  G("Main Street", "Main Street, Santa Ana, CA 92701", 33.7493, -117.8676, 0.4, ["main street", "main st"]),
  G("Los Angeles International Airport", "1 World Way, Los Angeles, CA 90045", 33.9416, -118.4085, 0.82, ["lax"]),
  G("Las Vegas Strip", "Las Vegas Boulevard South, Las Vegas, NV", 36.1147, -115.1728, 0.75, ["vegas", "las vegas"]),
];

export class FakeGeocoder implements Geocoder {
  failNext = 0;
  async search(query: string, _near?: LatLng): Promise<GeoResult[]> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Map search failed (HTTP 503)");
    }
    const q = query.toLowerCase().trim();
    const exact = PLACES.filter((p) => p.keys.includes(q));
    const hits = exact.length ? exact : PLACES.filter((p) => q.length >= 4 && p.keys.some((k) => k.includes(q) || q.includes(k)));
    return hits.sort((a, b) => b.importance - a.importance).map(({ keys, ...r }) => r);
  }
}

export const DEMO_PLACES = {
  home: { address: PLACES[0].address, coords: PLACES[0].coords },
  work: { address: PLACES[1].address, coords: PLACES[1].coords },
};
