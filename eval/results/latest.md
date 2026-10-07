# Ride Home reliability eval

Run against the simulated Uber in `sim/`, which mirrors the sandbox API's endpoints, statuses, error codes, and two-minute fare expiry, and adds the faults real networks produce.

## Headline

| | |
|---|---|
| Messy-state scenarios passing | **45/45** |
| Randomized sessions | 2,000 (43,496 Uber calls, 9,662 injected faults) |
| Double bookings | **0** |
| Rides booked above the approved price | **0** |
| Times it said "booked" or "not booked" and was wrong | **0** |
| Total rule violations | **0** |
| Planted bugs caught by the eval | **11/11** |

## Scenarios

### Happy path

| | What goes wrong | What it does |
|---|---|---|
| ✅ | Quote, confirm, driver found, driver arriving | One ride at the quoted price; tracking reports the driver arriving with car and plate |

### Price & confirmation

| | What goes wrong | What it does |
|---|---|---|
| ✅ | User takes 3 minutes to confirm; the 2-minute fare expires, price unchanged | Gets a fresh fare and books without asking again |
| ✅ | Fare expires and the new price is 20% higher | Books nothing and asks again with the new price; booking the new quote then works |
| ✅ | Fare expires and the new price is 2% higher (under the 3% and $1 limits) | Books, and says the fare refreshed to the new price |
| ✅ | Long Black ride: new price is 2.5% higher but that's over $1 | Both limits must hold, so it asks again |
| ✅ | Fare expires and the new price is lower | Books at the lower price |
| ✅ | Fare looks valid locally but Uber says invalid_fare_id (clock skew) | Re-quotes once and books if within approval |
| ✅ | Surge pricing (1.8x) is on | Quote says so; booking stops for Uber's own accept step; after accepting, one ride |
| ✅ | Fixed price when quoted, surge starts before the fare refresh | Doesn't book; shows the surge price for approval |
| ✅ | Agent passes a lower price than the quote to request_ride | Refused, nothing booked |
| ✅ | Agent chains ride_quote straight into request_ride in one turn (seen in VoiceOS: the user said "confirm" about a cancel) | Nothing booked; it asks about that price. Booking works once the user has had time to answer |
| ✅ | User says yes, and the agent re-quotes the same ride before booking it | Books: the same ride type, places, and price count as already shown |
| ✅ | Agent puts a different destination on the confirmation card than the quote | Refused, nothing booked |
| ✅ | request_ride with a quote id that was never issued | Asks for a new quote, nothing booked |

### Double booking

| | What goes wrong | What it does |
|---|---|---|
| ✅ | User confirms, then confirms the same quote again | Second confirm returns the same ride; still one ride |
| ✅ | Two confirmations arrive at the same moment | One ride; both report it |
| ✅ | User asks for another ride while one is on the way | Points to the existing ride instead of quoting |
| ✅ | Ride booked from quote A; user then confirms an older quote B | Doesn't book B; reports the active ride |
| ✅ | Ride completed; agent re-sends the same old confirmation | Refuses to reuse the old quote |

### Network

| | What goes wrong | What it does |
|---|---|---|
| ✅ | Uber creates the ride but the response never arrives | Doesn't resend; finds the ride and reports it booked; one ride |
| ✅ | Uber creates the ride, then returns a 500 | Treats it as unknown, finds the ride, one ride |
| ✅ | Connection drops before Uber gets the booking | Checks, finds no ride, says nothing was booked; doesn't retry on its own |
| ✅ | Uber returns 500 without creating anything | Says nothing was booked; one booking attempt only |
| ✅ | Booking response lost, and every follow-up check fails too | Says it can't tell, and to check the Uber app before trying again |
| ✅ | Price and ride-type lookups hit a 429 and a 503 first | Retries reads and quotes normally |
| ✅ | Uber answers 409 retry_request to the booking | Checks no ride was created, retries once; one ride |
| ✅ | Booking gets a 429 rate limit | A 429 means Uber did nothing: says not booked, no blind retry |

### Ride state

| | What goes wrong | What it does |
|---|---|---|
| ✅ | No drivers available | Status says no driver was found and nothing was booked |
| ✅ | Driver accepts, then cancels while the user is waiting | Tracking reports the cancellation; it doesn't silently rebook |
| ✅ | Driver canceled; the user later asks where their ride is | Explains the driver canceled, instead of 'no ride' |
| ✅ | Driver stuck at 'accepted' longer than the tracking window | Stops after the window and says so |
| ✅ | User cancels while the driver is on the way | Cancels exactly that ride and confirms it |
| ✅ | Cancel is called with an old ride's id while a new ride is active | Refuses; the active ride is untouched |
| ✅ | User tries to cancel after the trip started | Refuses and explains |
| ✅ | Cancel goes through but the response is lost | Retries safely, then confirms the ride is canceled |

### Auth

| | What goes wrong | What it does |
|---|---|---|
| ✅ | Uber rejects the access token mid-booking (401) | Renews the sign-in and books, once |
| ✅ | Token rejected and the refresh token was revoked | Nothing booked; tells the user to run bun login |
| ✅ | Card has insufficient funds | Nothing booked; says to update payment in the Uber app |
| ✅ | Account has no payment method | Nothing booked; says to add one in the Uber app |

### Places

| | What goes wrong | What it does |
|---|---|---|
| ✅ | "Main Street" matches streets in two cities | Asks which one; no quote |
| ✅ | Destination is Las Vegas, over Uber's 100-mile limit | Explains why it can't quote |
| ✅ | Pickup and destination are both work | Says they're the same place |
| ✅ | Address lookup service fails | Clear message; suggests home or work |
| ✅ | Agent passes a ride type the user didn't ask for this time ("Black" carried over) | Quotes it, plus the default UberX price, so the user chooses; picking UberX books UberX |
| ✅ | User asks for a ride type that doesn't exist there ("helicopter") | Lists the ride types that are available |

## Chaos run

Each session is a simulated user (quoting, hesitating, double-tapping confirm, checking status, cancelling, sometimes with a stale ride id) against a simulated Uber that randomly drops connections, loses responses after acting, returns 500s and 429s, turns on surge, drifts prices, runs out of drivers, has drivers cancel, declines cards, and revokes sign-ins. After every step it checks:

- **R1** One approval never creates more than one real ride.
- **R2** No fixed-price ride is charged above the approved fare plus the stated tolerance (3% and $1), and no surge ride is booked on a fixed-price approval.
- **R3** "Booked" means the ride exists. "Not booked", "price changed", "surge" and "already riding" mean the call created no real ride.
- **R4** Cancel only ever touches the ride it was given.
- **R5** Nothing throws. Every failure becomes a sentence for the user.

| Fault rate | Sessions | Uber calls | Faults injected | Rides created | Violations | Couldn't tell | Dead requests |
|---|---|---|---|---|---|---|---|
| 12% of calls | 1000 | 19,242 | 2,357 | 685 | **0** | 0 | 7 |
| 30% of calls | 1000 | 24,254 | 7,305 | 624 | **0** | 0 | 11 |

"Couldn't tell" counts bookings where Uber didn't answer and every follow-up check failed too. Then the integration says so and tells the user to check the Uber app, instead of guessing. "Dead requests" are bookings whose response was lost while Uber ended them with no drivers available. Nobody is picked up or charged. They're listed so the count is honest, not hidden.

| Fault | 12% run | 30% run |
|---|---|---|
| 409 retry_request | 62 | 184 |
| Rate limited | 513 | 1484 |
| 500, nothing done | 460 | 1448 |
| Uber acts, then returns 500 | 465 | 1417 |
| Uber acts, response is lost | 449 | 1434 |
| Connection fails before Uber sees it | 408 | 1338 |

## Does the eval catch real bugs?

Each row plants one classic bug in a copy of the booking code and reruns the eval. A row that isn't caught would mean the eval can't see that kind of failure.

| Planted bug | Caught by |
|---|---|
| Books a price the user hasn't had time to answer | 1 scenario (booked-before-user-answered) |
| Re-quoting the same ride restarts the wait, so a real yes is refused | 1 scenario (requoted-on-yes-turn) |
| Resends the booking after a timeout instead of checking for the ride | 5 scenarios (lost-response-after-booking, 500-after-booking, connection-fails-before-uber, …), chaos rules R3 |
| Assumes a timed-out booking failed, without checking | 3 scenarios (lost-response-after-booking, 500-after-booking, lost-response-and-uber-down), chaos rules R3 |
| Books any re-quoted price without asking again | 2 scenarios (fare-expired-price-up-20, fare-expired-price-up-over-1), chaos rules R2 |
| Price limits use OR instead of AND (3% OR $1) | 1 scenario (fare-expired-price-up-over-1) |
| Doesn't check the card matches the quote | 2 scenarios (tampered-confirmation, wrong-destination-on-card) |
| Confirming the same quote twice books again | 3 scenarios (confirm-twice, confirm-concurrently, reuse-quote-after-ride-ended), chaos rules R1 |
| Bookings aren't serialized (double-tap race) | 1 scenario (confirm-concurrently) |
| Cancels whatever ride is current, ignoring the id it was given | 1 scenario (cancel-stale-id), chaos rules R4 |
| Retries the booking call on 5xx inside the HTTP client | 2 scenarios (500-after-booking, 500-before-booking), chaos rules R3 |

