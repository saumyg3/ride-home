// Shared types. Field names on Uber* types follow Uber's Riders API v1.2.

export type Env = "demo" | "sandbox" | "production";

export type LatLng = { lat: number; lng: number };

/** A pickup or drop-off point, resolved enough to send to Uber and to say out loud. */
export type Place = {
  /** What we say back to the user: "home", "work", "John Wayne Airport". */
  label: string;
  /** Uber's saved places. Sent as start_place_id / end_place_id. */
  placeId?: "home" | "work";
  coords?: LatLng;
  address?: string;
};

export type Money = { value: number; display: string; currency: string };

export type Quote = {
  id: string;
  createdAt: number;
  product: { id: string; name: string };
  pickup: Place;
  destination: Place;
  /** Upfront fare. Absent when surge pricing applies. */
  fare?: { id: string; expiresAt: number; price: Money };
  /** Surge pricing: Uber only gives a range and needs the rider to accept it. */
  surge?: { multiplier: number; display: string; confirmationId?: string; href?: string };
  /** The price string shown on the confirmation card, exactly. */
  priceDisplay: string;
  pickupEtaMin?: number;
  tripMinutes?: number;
  distanceMiles?: number;
  /** Set once this quote has produced a ride, so re-confirming can't book twice. */
  usedByRequestId?: string;
};

export type RideStatus =
  | "processing"
  | "no_drivers_available"
  | "accepted"
  | "arriving"
  | "in_progress"
  | "driver_canceled"
  | "rider_canceled"
  | "completed";

export const ACTIVE: ReadonlySet<RideStatus> = new Set(["processing", "accepted", "arriving", "in_progress"]);
export const TERMINAL: ReadonlySet<RideStatus> = new Set([
  "no_drivers_available",
  "driver_canceled",
  "rider_canceled",
  "completed",
]);

export type UberRide = {
  request_id: string;
  product_id?: string;
  status: RideStatus;
  surge_multiplier?: number | null;
  driver?: { name?: string; rating?: number; phone_number?: string; picture_url?: string } | null;
  vehicle?: { make?: string; model?: string; license_plate?: string; color?: string } | null;
  location?: { latitude: number; longitude: number; bearing?: number } | null;
  pickup?: { latitude?: number; longitude?: number; eta?: number } | null;
  destination?: { latitude?: number; longitude?: number; eta?: number } | null;
};

export type UberProduct = {
  product_id: string;
  display_name: string;
  capacity?: number;
  upfront_fare_enabled?: boolean;
  shared?: boolean;
};
