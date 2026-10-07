# Ride Home

A VoiceOS integration that books Uber rides by voice, and is built to be trusted with your card.

```
  0s  you    "get me a ride home"
  0s  voice  UberX to home is $16.48, with pickup in 2 minutes and a 16-minute ride. Want me to book it?
  0s  card   [ UberX for $16.48 · From work to home · Book ride ]
  0s  voice  Booked. Uber is still finding you a driver. Want me to tell you when your driver is close?
  0s  you    "tell me when my driver is here"            (runs in the background)
 48s  notch  Maria is arriving now in a Gray Toyota Prius, plate 8 K L M 2 1 4.
```

*(A real run in demo mode, timestamps included.)*

## The hard part isn't booking a ride

Calling Uber's API is the easy part. The hard part is everything that goes wrong between "yes" and the car showing up:

- **The price changes.** Uber fares expire after two minutes, and people hesitate. If the new price is within 3% and $1 of what you approved, it books. Otherwise it books nothing and asks again with the new price.
- **Surge turns on.** Surge always goes through Uber's own accept step. A fixed-price approval never books a surge ride.
- **The network drops mid-booking.** It never resends a booking. If Uber doesn't answer, it checks your account for the ride. Then it tells you it's booked, that nothing was booked, or that it can't tell and you should check the Uber app. It never guesses.
- **You say yes twice.** Confirming the same quote twice, even at the same instant, gets you one ride.
- **The agent gets it wrong.** The confirmation card shows the product, price, pickup and destination. The server refuses to book unless all four match the stored quote exactly, so a model that misremembers a price can't book at it. And a booking that arrives seconds after the price was first shown, before anyone could have answered, is refused and turned back into the question. Testing in VoiceOS found this one: after "cancel my ride", the user said "confirm", and the agent quoted and booked an airport ride in the same breath.
- **The driver cancels, or there are no drivers.** You hear about it. It never rebooks silently.
- **You cancel.** Only the exact ride you were told about can be cancelled, never "whatever ride is current".
- **The sign-in expires.** It renews automatically. If that fails, it says how to sign in again.

## Results

The full report is in [`eval/results/latest.md`](eval/results/latest.md).

| | |
|---|---|
| Messy-state scenarios | **45/45 pass** |
| Randomized chaos sessions | **2,000** (about 43,000 Uber calls and 9,500 injected faults) |
| Double bookings | **0** |
| Rides booked above the approved price | **0** |
| Times it said "booked" / "not booked" and was wrong | **0** |
| Planted bugs the eval catches | **11/11** |

**Scenarios** ([`eval/scenarios.ts`](eval/scenarios.ts)). These are 45 named situations across price, double booking, network, ride state, sign-in, and places. Each one checks two things:
- what the integration *said*
- what the simulated Uber says *actually happened*

**Chaos run** ([`eval/chaos.ts`](eval/chaos.ts)). This runs 1,000 random sessions at a 12% fault rate and 1,000 more at 30%. A simulated user quotes, hesitates, double-taps confirm, checks status, and cancels, sometimes with a stale ride id. Meanwhile the simulated Uber:
- drops connections and loses responses *after* creating the ride
- returns 500s and 429s
- turns on surge and drifts prices
- runs out of drivers, has drivers cancel, and declines cards

Five rules are checked after every step:
- one approval, at most one ride
- never above the approved price
- what it says matches what happened
- cancel only touches the named ride
- it never throws

**Does the eval catch real bugs?** [`eval/mutants.ts`](eval/mutants.ts) plants 11 classic mistakes, one at a time, in a throwaway copy of the code, and reruns the eval. The mistakes include:
- resending a booking after a timeout
- assuming a timeout means it failed
- OR instead of AND on the price limits
- not serializing double-taps
- cancelling "the current ride"

All 11 make the eval fail.

The chaos run earned its place. The first version flagged 12 violations that the hand-written scenarios had missed. Each one was traced and explained. Two were checker mistakes, and the checker was fixed. The rest were requests Uber ended with "no drivers" while the response was lost, which are now counted on their own line rather than hidden.

## Try it

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/saumyg3/ride-home && cd ride-home
bun install
bun verify.ts      # manifest, cards, and a full conversation over real MCP stdio
bun eval/run.ts    # scenarios + 2,000 chaos sessions, about a second
```

Then add it to VoiceOS in whichever way your build offers:

- **By URL** (current builds: Apps → Custom → Create, then "paste an MCP server URL"). Run `bun server.ts --http` and keep that Terminal window open, then paste `http://localhost:8790/mcp`. This listens on your Mac only and rejects requests from web pages. You can stop and restart the server freely; VoiceOS picks it back up on the next request.
- **From a folder** (as in the docs): Settings → Agent Mode → Integrations → Install from folder, then pick this folder. In this mode you also get the manifest's confirmation cards and setup fields.

It starts in **Demo** mode: a simulated Uber with no account and no charges. Say "get me a ride home", and the driver shows up about 45 seconds later.

### Real Uber

1. Create an app at [developer.uber.com](https://developer.uber.com) and add `http://127.0.0.1:8789/callback` as a redirect URI.
2. `UBER_CLIENT_ID=... UBER_CLIENT_SECRET=... bun login.ts sandbox`
3. In VoiceOS, set **Mode** to Sandbox, add the client ID and secret, and set a **Default pickup**.
4. Optional: `DEFAULT_PICKUP="your address" bun sandbox-check.ts` runs the core flows against Uber's live sandbox, forcing the driver states, no-drivers, and surge with the sandbox's own controls.

Production works the same way with `bun login.ts production`. Uber's `request` scope works for your own account (and any developers you add) while the app is in development. Other users need Uber to approve the app.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `ride_quote` | read | Price, pickup time, trip length. Never books. |
| `request_ride` | act, confirmation card | Books the quote the user approved. |
| `ride_status` | read | Driver, car, plate, ETA, or what happened to the last ride. |
| `track_ride` | background | Watches the ride and reports when the driver arrives, or if it's cancelled. |
| `cancel_ride` | act, confirmation card | Cancels the named ride only. |

There are also fast intents for "get me a ride home", "ride to work", and "where's my Uber", plus ASR hints for the ride type names.

## How it's built

```
server.ts           MCP server: tools, spoken replies, cards
src/rides.ts        booking rules (the part that has to be right)
src/uber.ts         Uber Riders API v1.2 client: reads retry, ride creation never does
src/auth.ts         OAuth tokens, saved owner-only, renewed single-flight
src/places.ts       "home" / "the office" / addresses, asks when a name is ambiguous
src/speak.ts        how rides are said out loud (plates spelled out for TTS)
sim/fake-uber.ts    simulated Uber: sandbox endpoints, statuses, errors, fault injection
eval/               scenarios, chaos run, mutation check, results
login.ts            one-time Uber sign-in
sandbox-check.ts    the same flows against Uber's real sandbox
verify.ts           integration checks over MCP stdio
```

The rule `src/uber.ts` enforces is that **reads are retried, ride creation never is.** A booking that times out or gets a 5xx might have created a car. So it's reported as "ambiguous", and the booking code looks for the ride instead of sending the request again. Retrying blindly is how double bookings happen, and it's the first planted bug in the mutation check.

## Why not DoorDash

Kai suggested DoorDash or Uber. DoorDash's public API (Drive) is for businesses that want Dashers to deliver their own orders. Its FAQ says customer ordering happens only in the DoorDash app. So "order my usual from the Thai place" isn't possible through an official API. Uber's Riders API supports exactly the flow needed here, and its sandbox can simulate the messy states.

## Limits, honestly

- **Tested inside VoiceOS in demo mode, not yet against Uber's live sandbox.** The sandbox needs an Uber developer sign-in; `sandbox-check.ts` is ready for it. The simulated Uber follows Uber's documented endpoints, statuses, error codes, and fare expiry, but real responses may differ in details.
- **Added by URL, VoiceOS doesn't show the manifest's confirmation cards.** The agent's own "want me to book it?" is then the only check before booking, which is why the server also refuses a booking that arrives before anyone could have answered the price.
- **Sign-in is a one-time `bun login`** until VoiceOS ships its brokered OAuth. The manifest already supports `oauth2`, so switching later is a config change.
- **No GPS on a desktop.** The pickup is your default (home, work, or an address) unless you say otherwise.
- **Addresses use OpenStreetMap.** It's free, but quality varies. Ambiguous names ask which one instead of guessing.
- **Uber's API can't list recent requests.** If a booking's response is lost *and* Uber ends that request with "no drivers" before the integration checks, the integration can't see it. Nobody is picked up or charged. The chaos run counts these separately: 23 of 1,316 bookings, all under injected faults.

Not affiliated with or endorsed by Uber.
