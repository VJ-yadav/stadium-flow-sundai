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

## Our idea

Use the same $50 offers and the same budget, but **give them to the fans whose waiting frees the
most road**, and learn from every game.

1. **Groups.** Split cars by lot and direction (north or south), about 68 groups.
2. **Value.** For each group: how many car-minutes are saved in total if 100 of its cars wait
   75 minutes? (This counts the extra wait of the cars that hold back.)
3. **Yes rate.** From memory of past games: how often fans in that group accepted an offer.
4. **Rank and offer.** Sort groups by value × yes rate. Offer $50 down the list until the budget
   is spent.
5. **Score.** Car-minutes saved per $1,000, flat offer vs targeted, same budget.

**Car-minutes saved** = waiting removed, added up over every car. 1,000 cars each waiting
10 minutes less = 10,000 car-minutes saved.

### What "memory" means here

- **The operator remembers each event:** the plan, the conditions (crowd, weather, trains,
  contraflow) and how each lot cleared.
- **Each fan can opt in** to remember their own exits ("52 min, then 31, then 12 in the car")
  and get a personal suggestion and offers.
- **Each lot has patterns** across events: which lots jam first, which groups say yes.
- **What we don't do:** no tracking of people. Fan memory is opt-in and only covers the fan's own
  exits.

Memory is stored through the [localmem](https://localmem.org) public API, called from a server
route so no key ever reaches the browser.

## Goals for today (done by 19:00)

1. **One number:** targeted beats flat on car-minutes saved per $1,000, shown side by side after a run.
2. **One picture:** the same game with and without the plan on the 3D map: lots full and Route 1
   jammed vs the chosen lots holding back and the road moving.
3. **One memory moment:** game 2 reads what game 1 saved and changes who gets the offer, plus a
   fan card showing one fan's history.

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
| Lead, model and offers | Targeted vs flat offers in `sim.js`, the score per $1,000 |
| 3D and interface | Fly-in camera, car models, before/after view, offer panel, fan card |
| Memory and backend | Server route to localmem (write each game, read before the next), deploy |
| Data, story and ship | Real numbers with sources, demo script, recording, submission |

Working rules: small PRs to `main`, pull before you push, say in chat what you're taking, no keys
in code.

## Data and credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Google Photorealistic 3D Tiles must show Google's attribution on screen and may not be cached
  or used for analysis (Map Tiles API policies).
- Built with [three.js](https://threejs.org) and
  [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS).
