// How rides are described out loud. Short, and with the details someone
// actually needs at the curb: who, what car, which plate, how long.

import type { Quote, UberRide } from "./types";

export const minutes = (n: number | undefined | null) =>
  n === undefined || n === null ? undefined : n <= 1 ? "about a minute" : `${Math.round(n)} minutes`;

export function car(r: UberRide): string | undefined {
  const v = r.vehicle;
  if (!v) return undefined;
  const name = [v.color, v.make, v.model].filter(Boolean).join(" ");
  return name || undefined;
}

/** Plates are read character by character so they're understandable over TTS. */
export function plateSpoken(plate: string | undefined): string | undefined {
  return plate ? plate.toUpperCase().replace(/\s+/g, "").split("").join(" ") : undefined;
}

export function describeQuote(q: Quote): string {
  const eta = minutes(q.pickupEtaMin);
  const trip = q.tripMinutes ? `${Math.round(q.tripMinutes)}-minute` : undefined;
  let s = `${q.product.name} to ${q.destination.label} is ${q.surge ? `about ${q.surge.display}` : q.priceDisplay}`;
  if (eta) s += `, with pickup in ${eta}`;
  if (trip) s += ` and a ${trip} ride`;
  s += ".";
  if (q.surge) s += ` Prices are ${q.surge.multiplier}x higher than normal right now.`;
  return s;
}

export function describeRide(r: UberRide): string {
  const driver = r.driver?.name;
  const vehicle = car(r);
  const plate = plateSpoken(r.vehicle?.license_plate);
  const eta = minutes(r.pickup?.eta);
  switch (r.status) {
    case "processing":
      return "Uber is still finding you a driver.";
    case "accepted":
      return [
        `${driver ?? "Your driver"} is on the way`,
        eta ? ` and about ${eta} out` : "",
        vehicle ? `, in a ${vehicle}` : "",
        plate ? `, plate ${plate}` : "",
        ".",
      ].join("");
    case "arriving":
      return `${driver ?? "Your driver"} is arriving now${vehicle ? ` in a ${vehicle}` : ""}${plate ? `, plate ${plate}` : ""}.`;
    case "in_progress":
      return `You're already on the trip${driver ? ` with ${driver}` : ""}${r.destination?.eta ? `, about ${minutes(r.destination.eta)} from your destination` : ""}.`;
    case "completed":
      return "Your last ride is complete.";
    case "no_drivers_available":
      return "Uber couldn't find a driver for that ride. Nothing was booked. I can try again or try a different ride type.";
    case "driver_canceled":
      return "Your driver canceled the ride. I can request a new one if you'd like.";
    case "rider_canceled":
      return "That ride was canceled.";
  }
}
