# Stadium Flow: Leaving Gillette

A real 3D model of Gillette Stadium and Route 1 in Foxborough, MA. Built at Sundai Hack 150
("Building 3D worlds", MIT E38).

After a big game, cars sit in the Gillette lots for an hour or more. Route 1 is the only road in
or out. We can't widen it, but we can change **where people spend the wait**: in the stadium, or
in their car with the engine running.

---

## The problem

- Gillette seats about 65,900. The mapped lots hold roughly **17,900 cars** (our estimate from lot
  area in OpenStreetMap).
- Every car leaves on **Route 1**, two lanes each way, toward I-95 (north) or I-495 (south).
- Two lanes move about 3,600 cars an hour. With 14,000 cars and 60% heading north, the road alone
  needs **about 2 h 20 min** to clear the northbound traffic. No plan beats that floor.
- Fans have reported waits of 90+ minutes just to get out of the lot.

The road sets **when the last car is gone**. A plan only decides **who waits, and where**.

### Why fans can't fix it alone

Everyone leaving at the final whistle is the reasonable choice for each fan, and the worst outcome
for all of them. Our model shows this: when every fan learns from their own past waits and adjusts,
the average time in the car barely moves (51 min to 50 min over 8 games). It's a coordination
problem, so someone has to coordinate.

## What already exists

- **Gillette's delayed-release lots:** fans in some lots get a $50 card to leave about 75 minutes
  after the game. It works, but it's the same offer to everyone in a fixed lot.
- **MassDOT contraflow:** an extra northbound lane for big events. In our model this cuts the
  average time in the car from about 51 to 29 minutes.
- **Traffic simulation studies** (PTV Vissim, Eclipse SUMO, a Google Research study for Seattle):
  they model one event as a consulting job. None of them remember across games or pick who gets
  an offer.

## Who it's for: the event operator

Our user is the team that runs game-day traffic at Gillette: stadium event operations, working
with Foxborough police and MassDOT. There is no fan app in this version.

Before each event they already decide:

- **which lots are delayed-release** (today a fixed set, such as Lots 45 and 55B),
- **how many $50 cards** to fund, which means the budget,
- whether to ask for **contraflow** on Route 1,
- when to open each lot's exits.

After each event they know some things: how many cards were taken in each lot, and roughly when
the lots emptied. Nothing turns that into a better plan for the next event.

## What we offer the operator

**A plan before each event, and a record after it that makes the next plan better.**

1. **Before the event,** the operator enters the conditions: expected cars, fans on trains,
   contraflow or not, and the card budget.
2. **Stadium Flow recommends where the cards go:** which lots and how many cars in each. This is
   compared with the plan they use today on the same Route 1 model and the same budget.
3. **It shows the result of both plans:**
   - average minutes in the car,
   - when the last car leaves the lots,
   - **car-minutes saved per $1,000** of cards.
   The operator can watch both plans play out in 3D.
4. **After the event,** the operator records what happened: cards taken per lot and when the lots
   cleared. That record is saved as memory.
5. **The next event's plan reads that memory.** A lot where few people took the card gets fewer
   cards next time. A lot that cleared slower than the model said gets a slower exit rate. The
   screen says what changed and why.

### How the recommendation works

1. **Groups.** Split cars by lot and direction (north to I-95 or south to I-495), about 68 groups.
2. **Value.** For each group, the car-minutes saved in total if 100 of its cars leave 75 minutes
   later. This counts the extra wait of the cars that hold back.
3. **Take rate.** The share of offered cards that were taken in that group, from past events.
   Before there is any history, every group uses the same starting estimate.
4. **Rank and fund.** Sort the groups by value × take rate and fund cards down the list until the
   budget is spent.

**Car-minutes saved** means the waiting removed, added up over every car. If 1,000 cars each wait
10 minutes less, that is 10,000 car-minutes saved.

### What memory stores

One record per event, held by the operator:

- the conditions (cars, trains, contraflow, weather),
- the plan (which lots got cards, and the budget),
- the result (cards taken per lot, when each lot cleared).

It is stored through the [localmem](https://localmem.org) public API, called from a server route,
so no key reaches the browser. It holds no personal data: only counts per lot.

**Later, not today:** opt-in fan history and personal offers.

## Goals for today (done by 19:00)

1. **The plan beats today's plan.** For one event, show today's fixed lots next to our recommended
   lots, with the same $ budget, as average minutes in the car, last car out, and car-minutes saved
   per $1,000. *Done when* both columns fill in after one click and the difference is clear.
2. **You can see why.** On the 3D map, play both plans. In today's plan, the lots stay full and
   Route 1 backs up. In ours, the chosen lots hold back and the road keeps moving. *Done when* a
   20-second clip makes the point without anyone explaining it.
3. **Event 2 is smarter than event 1.** Run event 1, save its record to localmem, then plan
   event 2. The plan changes because of the record, for example "Lot 22 took only 30% of its cards,
   so we moved $8,000 to Lot 15". *Done when* the screen shows the change and the record it came
   from.

Plus a public link, this repo and a recording.


## What runs now

- Real 3D Gillette: Google Photorealistic 3D Tiles when a key is set, otherwise an OpenStreetMap
  model (lots, roads, rail, buildings, the stadium).
- A traffic model of the real 7.3 km of Route 1 (`src/sim.js`): a cell transmission model
  (Daganzo 1994) with whole cars, 40 m cells and 3 s steps, so jams spill back into the lots.
- Sliders: cars parked, fans on trains, north/south split, northbound lanes, contraflow, the
  delayed-release lot and the time-lapse speed.
- A game log: each run is one event the operator would remember.
- Cars you can watch: amber is waiting in a lot, teal is moving on Route 1.

### Model results so far (`node scripts/check_sim.mjs`)

| Scenario | Avg minutes in car | Last car out of the lots |
|---|---|---|
| 14,000 cars, 2 lanes north | 51 | 175 min |
| Same, plus contraflow lane | 29 | 136 min |
| 14,000 cars, 1 lane north | 120 | 305 min |
| 8,000 cars, 2 lanes north | 22 | 113 min |

All rates are estimates until the venue provides counts: 1,800 cars per lane per hour, 15 cars a
minute per lot exit, 30 m² a car for lot capacity, 60% heading north.

## Run it

Needs Node 20+ (we use 24).

```sh
npm install
cp .env.example .env.local    # optional: add VITE_GOOGLE_MAPS_KEY for photoreal tiles
npm run dev                   # http://localhost:5173
node scripts/check_sim.mjs    # headless model runs, no browser
```

Without a key the viewer shows the OpenStreetMap model, which is fine for development.

**Keys:** never commit `.env.local` (it's in `.gitignore`), never paste a key in chat or an issue.
Any key used for a public deploy must be restricted to the deployed domain and to the Map Tiles
API only.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Page, control panel, HUD, legend, game log |
| `src/main.js` | three.js viewer: tiles or OSM scene, camera limits, cars, sliders, game log |
| `src/sim.js` | Traffic model: cells on Route 1, lot release, leaving times, a season of games |
| `public/data/foxborough.json` | Route 1, roads, 34 lots, rail, buildings, stadium in local metres |
| `scripts/build_data.py` | Turns OSM exports into `foxborough.json` (raw exports not included) |
| `scripts/check_sim.mjs` | Headless scenarios and timings |
| `public/draco/` | Draco decoder for the Google tiles |

Coordinates are metres around the stadium centre (42.0909, -71.2643): x east, z south
(in three.js, -z is north).

## Team and tasks

| Role | Owns |
|---|---|
| Lead, model and plan | Recommended vs today's plan in `sim.js`, take rates from records, score per $1,000 |
| 3D and interface | Operator panel (conditions, budget, plan vs today), before/after playback, fly-in camera, cars |
| Memory and backend | Server route to localmem: save each event record, read it before planning the next; deploy |
| Data, story and ship | Real numbers with sources, demo script, recording, submission |

Working rules: small PRs to `main`, pull before you push, say in chat what you're taking, no keys
in code.

## Data and credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Google Photorealistic 3D Tiles must show Google's attribution on screen and may not be cached
  or used for analysis (Map Tiles API policies).
- Built with [three.js](https://threejs.org) and
  [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS).
