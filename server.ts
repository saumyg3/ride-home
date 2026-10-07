/** Ride Home: a VoiceOS integration server (standard MCP over stdio). */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serve } from "./src/serve";
import manifest from "./voiceos.integration.json" with { type: "json" };
import { buildBackend } from "./src/backend";
import { badges, fit, glanceResult, header, jsonResult, keyValue, list, stats, type Block } from "./src/glance";
import type { BookResult, CancelResult, Problem, QuoteResult, StatusResult, TrackResult } from "./src/rides";
import { car, describeQuote, describeRide, minutes } from "./src/speak";
import type { Place, Quote, RideStatus, UberRide } from "./src/types";
import { ACTIVE } from "./src/types";

const { env, service } = buildBackend();
/** product_id -> name, learned from quotes, so rides can say "UberX" instead of "Uber". */
const productNames = new Map<string, string>();
console.error(`ride-home: running in ${env} mode`);

const meta = (name: string) => {
  const t = manifest.tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing from manifest`);
  return { title: t.title, description: t.description };
};

const TITLE = env === "demo" ? "Ride Home (demo)" : env === "sandbox" ? "Ride Home (sandbox)" : "Ride Home";
const head = (trailing?: string) => ({ ...header(TITLE, trailing), icon: "car" });

/** The model narrates from `say`; `how_to_answer` keeps it from improvising around money. */
const reply = (data: Record<string, unknown>, blocks: Block[]) => jsonResult({ mode: env, ...data, ...glanceResult(blocks) });

const problem = (p: Problem, extra: Record<string, unknown> = {}) =>
  reply({ ok: false, code: p.code, say: p.say, ...extra, how_to_answer: "Tell the user `say`. Don't retry on your own." }, [
    head(),
    badges([{ text: p.code === "auth_required" ? "Sign in needed" : "Couldn't do that", tone: "bad" }]),
    keyValue([["Details", p.say]]),
  ]);

function rideSummary(r: UberRide): string {
  const parts = [(r.product_id && productNames.get(r.product_id)) || "Uber"];
  if (r.driver?.name) parts.push(`with ${r.driver.name}`);
  const c = car(r);
  return c ? `${parts.join(" ")}, ${c}` : parts.join(" ");
}

function rideData(r: UberRide) {
  return {
    request_id: r.request_id,
    status: r.status,
    driver: r.driver?.name,
    driver_rating: r.driver?.rating,
    car: car(r),
    plate: r.vehicle?.license_plate,
    pickup_eta_minutes: r.pickup?.eta ?? undefined,
    summary: rideSummary(r),
    active: ACTIVE.has(r.status),
  };
}

/** "John Wayne Airport (18601 Airport Way, Santa Ana, CA 92707)": the name people said, plus where it is. */
function placeLine(p: Place): string {
  if (!p.address || p.address === p.label) return p.address ?? p.label;
  // A geocoded address usually starts with the place name; don't say it twice.
  if (p.address.toLowerCase().startsWith(p.label.toLowerCase())) return p.address;
  return `${p.label} (${p.address})`;
}

/** Plain-language status for the badge. */
const STATUS_LABEL: Record<RideStatus, { text: string; tone: "good" | "bad" | "neutral" }> = {
  processing: { text: "Finding a driver", tone: "neutral" },
  accepted: { text: "On the way", tone: "good" },
  arriving: { text: "Arriving", tone: "good" },
  in_progress: { text: "On the trip", tone: "good" },
  completed: { text: "Completed", tone: "neutral" },
  rider_canceled: { text: "Canceled", tone: "neutral" },
  driver_canceled: { text: "Driver canceled", tone: "bad" },
  no_drivers_available: { text: "No drivers", tone: "bad" },
};

function rideCard(r: UberRide, trailing: string): Block[] {
  const pairs: [string, string][] = [];
  if (r.driver?.name) pairs.push(["Driver", `${r.driver.name}${r.driver.rating ? ` (${r.driver.rating}★)` : ""}`]);
  if (car(r)) pairs.push(["Car", car(r)!]);
  if (r.vehicle?.license_plate) pairs.push(["Plate", r.vehicle.license_plate]);
  if (r.status === "accepted" && r.pickup?.eta) pairs.push(["Pickup in", minutes(r.pickup.eta)!]);
  return [
    head(trailing),
    badges([STATUS_LABEL[r.status] ?? { text: r.status.replace(/_/g, " "), tone: "neutral" }]),
    ...(pairs.length ? [keyValue(pairs)] : [keyValue([["Status", describeRide(r)]])]),
  ];
}

function buildServer(): McpServer {
const server = new McpServer({ name: "ride-home", version: manifest.version });

// ---------- ride_quote ----------

function quoteReply(r: QuoteResult) {
  if (r.kind === "problem") return problem(r);
  if (r.kind === "already_on_trip") {
    return reply(
      { ok: false, code: "already_on_trip", ride: rideData(r.ride), say: `You already have a ride. ${describeRide(r.ride)}`, how_to_answer: "Tell the user `say`. Don't quote or book another ride." },
      rideCard(r.ride, "Already booked"),
    );
  }
  if (r.kind === "ambiguous") {
    const opts = r.options.map((o) => o.address ?? o.label);
    return reply(
      {
        ok: false,
        code: "ambiguous_place",
        field: r.field,
        options: opts,
        say: `There's more than one "${r.query}". Did you mean ${opts.slice(0, 3).join(", or ")}?`,
        how_to_answer: `Ask which one they mean, then call ride_quote again with the full address they pick as the ${r.field}.`,
      },
      [head("Which one?"), list(opts.map((o) => ({ title: o.split(",")[0], subtitle: o, icon: "pin" })), `Which ${r.query}?`)],
    );
  }
  const q: Quote = r.quote;
  productNames.set(q.product.id, q.product.name);
  const eta = minutes(q.pickupEtaMin) ?? "a few minutes";
  const alt = r.alternative;
  if (alt) productNames.set(alt.product.id, alt.product.name);
  const bookWith = (x: Quote) => ({
    quote_id: x.id,
    product: x.product.name,
    price: x.priceDisplay,
    pickup: x.pickup.label,
    destination: x.destination.label,
    pickup_eta: minutes(x.pickupEtaMin) ?? "a few minutes",
  });
  return reply(
    {
      ok: true,
      say: alt
        ? `${describeQuote(q)} ${alt.product.name} would be ${alt.priceDisplay}. Which one do you want?`
        : `${describeQuote(q)} Want me to book it?`,
      book_with: bookWith(q),
      ...(alt ? { book_with_alternative: bookWith(alt) } : {}),
      surge: q.surge ? { multiplier: q.surge.multiplier } : undefined,
      price_valid_for_seconds: q.fare ? Math.max(0, Math.round((q.fare.expiresAt - Date.now()) / 1000)) : undefined,
      other_ride_types: r.otherProducts,
      how_to_answer: alt
        ? "Say `say` and let the user choose. If they pick " + q.product.name + ", call request_ride with book_with; if they pick " +
          alt.product.name + ", call request_ride with book_with_alternative. Pass every field exactly as given."
        : "Say `say` and wait for a yes. Only then call request_ride with every field of book_with exactly as given. " +
          "If they want a different ride type, call ride_quote again with that product.",
    },
    [
      head(q.surge ? `${q.surge.multiplier}x surge` : alt ? "Pick one" : "Price"),
      stats([
        { label: q.product.name, value: q.fare ? q.fare.price.display : q.surge?.display ?? q.priceDisplay, ...(q.surge ? { tone: "bad" as const } : {}) },
        ...(alt ? [{ label: alt.product.name, value: alt.fare ? alt.fare.price.display : alt.priceDisplay }] : []),
        { label: "Pickup in", value: eta },
        ...(alt ? [] : [{ label: "Trip", value: q.tripMinutes ? `${q.tripMinutes} min` : "-" }]),
      ]),
      keyValue([
        ["From", placeLine(q.pickup)],
        ["To", placeLine(q.destination)],
      ]),
    ],
  );
}

server.registerTool(
  "ride_quote",
  {
    ...meta("ride_quote"),
    inputSchema: {
      destination: z.string().min(1).max(200).describe("Where to go: 'home', 'work', a place name, or a street address"),
      pickup: z.string().max(200).optional().describe("Where to be picked up, if the user said. Leave out to use their default pickup"),
      product: z.string().max(40).optional().describe("Copy the user's own words for the ride type from their LATEST message only, e.g. 'Black', 'an XL', 'Comfort'. If their latest message didn't name a ride type, leave this out, even if an earlier message did; the default is used."),
    },
  },
  async (args) => quoteReply(await service.quote(args)),
);

// ---------- request_ride ----------

function bookReply(r: BookResult) {
  switch (r.kind) {
    case "booked": {
      const price = r.repriced?.to ?? r.quote.priceDisplay;
      const note = r.repriced ? ` The fare refreshed to ${r.repriced.to}, within what you approved.` : "";
      return reply(
        {
          ok: true,
          booked: true,
          ride: rideData(r.ride),
          price,
          recovered_after_timeout: r.recoveredAfterTimeout,
          say: `Booked. ${describeRide(r.ride)}${note} Want me to tell you when your driver is close?`,
          how_to_answer: "Say `say`. If they want updates, call track_ride.",
        },
        [
          head("Booked"),
          badges([{ text: "Booked", tone: "good" }, { text: r.quote.product.name }]),
          keyValue([
            ["Price", price],
            ["To", r.quote.destination.label],
            ["Status", r.ride.status === "processing" ? "Finding a driver" : r.ride.status.replace(/_/g, " ")],
          ]),
        ],
      );
    }
    case "price_changed": {
      const q = r.quote;
      return reply(
        {
          ok: false,
          booked: false,
          code: "price_changed",
          say: `Nothing booked yet. The price changed from ${r.was} to ${q.priceDisplay}. Want it at the new price?`,
          book_with: {
            quote_id: q.id,
            product: q.product.name,
            price: q.priceDisplay,
            pickup: q.pickup.label,
            destination: q.destination.label,
            pickup_eta: minutes(q.pickupEtaMin) ?? "a few minutes",
          },
          how_to_answer: "Say `say`. Only if they say yes, call request_ride again with the new book_with.",
        },
        [head("Price changed"), badges([{ text: "Not booked", tone: "bad" }]), keyValue([["Was", r.was], ["Now", q.priceDisplay]])],
      );
    }
    case "surge_acceptance":
      return reply(
        {
          ok: false,
          booked: false,
          code: "surge_acceptance_required",
          surge_link: r.href,
          say: "Nothing booked yet. Uber has surge pricing on right now, and you have to accept it on Uber's page first. I've put the link on screen. Tell me once you've accepted and I'll book it.",
          book_with_after_accepting: {
            quote_id: r.quote.id,
            product: r.quote.product.name,
            price: r.quote.priceDisplay,
            pickup: r.quote.pickup.label,
            destination: r.quote.destination.label,
          },
          how_to_answer: "Say `say`. After the user says they accepted, call request_ride again with book_with_after_accepting.",
        },
        [
          head("Surge"),
          badges([{ text: "Accept surge first", tone: "bad" }]),
          keyValue([["Price", r.quote.priceDisplay], ["Accept at", fit(r.href ?? "the Uber app", 64)]]),
        ],
      );
    case "needs_answer": {
      const q = r.quote;
      return reply(
        {
          ok: false,
          booked: false,
          code: "user_has_not_answered",
          say: `I haven't booked anything. ${q.product.name} to ${q.destination.label} is ${q.priceDisplay}. Want me to book it?`,
          book_with: {
            quote_id: q.id,
            product: q.product.name,
            price: q.priceDisplay,
            pickup: q.pickup.label,
            destination: q.destination.label,
            pickup_eta: minutes(q.pickupEtaMin) ?? "a few minutes",
          },
          how_to_answer:
            "This price was only just shown, so the user hasn't answered it yet. Say `say` and wait. Only if they say yes to this price, call request_ride again with book_with. A 'yes' or 'confirm' about something else (like canceling) is not a yes to this.",
        },
        [
          head("Not booked yet"),
          stats([
            { label: q.product.name, value: q.priceDisplay },
            { label: "Pickup in", value: minutes(q.pickupEtaMin) ?? "soon" },
          ]),
          keyValue([
            ["From", placeLine(q.pickup)],
            ["To", placeLine(q.destination)],
          ]),
        ],
      );
    }
    case "already_on_trip":
      return reply(
        { ok: false, booked: false, code: "already_on_trip", ride: rideData(r.ride), say: `You already have a ride, so I didn't book another. ${describeRide(r.ride)}` },
        rideCard(r.ride, "Already booked"),
      );
    case "not_booked":
      return reply(
        { ok: false, booked: false, code: r.code, say: r.say.startsWith("Nothing") || /nothing was booked/i.test(r.say) ? r.say : `${r.say} Nothing was booked.` },
        [head("Not booked"), badges([{ text: "Not booked", tone: "bad" }]), keyValue([["Why", r.say]])],
      );
    case "unknown":
      return reply(
        {
          ok: false,
          booked: "unknown",
          code: "booking_unconfirmed",
          ride: r.ride ? rideData(r.ride) : undefined,
          say: r.say,
          how_to_answer: "Say `say`. Do not call request_ride again in this conversation unless the user confirms in the Uber app that no ride was booked.",
        },
        [head("Check Uber"), badges([{ text: "Unconfirmed", tone: "bad" }]), keyValue([["What to do", "Check the Uber app before booking again"]])],
      );
  }
}

server.registerTool(
  "request_ride",
  {
    ...meta("request_ride"),
    inputSchema: {
      quote_id: z.string().min(1).describe("book_with.quote_id from ride_quote"),
      product: z.string().min(1).describe("book_with.product from ride_quote"),
      price: z.string().min(1).describe("book_with.price from ride_quote, exactly"),
      pickup: z.string().min(1).describe("book_with.pickup from ride_quote"),
      destination: z.string().min(1).describe("book_with.destination from ride_quote"),
      pickup_eta: z.string().min(1).describe("book_with.pickup_eta from ride_quote"),
    },
  },
  async ({ quote_id, product, price, pickup, destination }) => bookReply(await service.book({ quote_id, product, price, pickup, destination })),
);

// ---------- ride_status ----------

function statusReply(r: StatusResult) {
  if (r.kind === "problem") return problem(r);
  if (r.kind === "none") {
    return reply({ ok: true, active: false, say: "You don't have an Uber on the way." }, [head(), badges([{ text: "No active ride" }])]);
  }
  return reply({ ok: true, ...rideData(r.ride), say: describeRide(r.ride) }, rideCard(r.ride, ACTIVE.has(r.ride.status) ? "Live" : "Ended"));
}

server.registerTool("ride_status", { ...meta("ride_status"), inputSchema: {} }, async () => statusReply(await service.status()));

// ---------- track_ride (background) ----------

function trackReply(r: TrackResult) {
  if (r.kind === "problem") return problem(r);
  if (r.kind === "none") return reply({ ok: true, active: false, say: "You don't have an Uber on the way." }, [head(), badges([{ text: "No active ride" }])]);
  const ride = r.ride;
  const reassigned = r.events.find((e) => e.startsWith("driver_changed:"));
  let say = describeRide(ride);
  if (reassigned) say = `Heads up, Uber switched your driver. ${say}`;
  if (r.timedOut) say = `I stopped watching. ${say}`;
  return reply({ ok: true, ...rideData(ride), events: r.events, timed_out: r.timedOut, say }, rideCard(ride, ride.status === "arriving" ? "Driver here" : "Update"));
}

server.registerTool(
  "track_ride",
  {
    ...meta("track_ride"),
    inputSchema: {
      max_minutes: z.number().min(0).max(45).optional().describe("Stop watching after this many minutes. Default 20, maximum 45. 0 checks once."),
    },
  },
  async ({ max_minutes }) => trackReply(await service.track(max_minutes ?? 20)),
);

// ---------- cancel_ride ----------

function cancelReply(r: CancelResult) {
  if (r.kind === "problem") return problem(r);
  if (r.kind === "refused") {
    return reply({ ok: false, canceled: false, code: r.code, ride: r.ride ? rideData(r.ride) : undefined, say: r.say }, [
      head("Not canceled"),
      badges([{ text: "Nothing canceled" }]),
      keyValue([["Why", r.say]]),
    ]);
  }
  return reply({ ok: true, canceled: true, request_id: r.ride.request_id, say: "Your ride is canceled." }, [
    head("Canceled"),
    badges([{ text: "Ride canceled", tone: "neutral" }]),
  ]);
}

server.registerTool(
  "cancel_ride",
  {
    ...meta("cancel_ride"),
    inputSchema: {
      request_id: z.string().min(1).describe("request_id from ride_status"),
      summary: z.string().min(1).describe("summary from ride_status, e.g. 'UberX with Maria, Gray Toyota Prius'"),
    },
  },
  async ({ request_id }) => cancelReply(await service.cancel(request_id)),
);

return server;
}

await serve(buildServer, "ride-home", 8790);
