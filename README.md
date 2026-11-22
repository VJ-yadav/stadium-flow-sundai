# Stadium Flow: Leaving Fenway

A real 3D model of Fenway Park and the streets around it in Boston, with a traffic model of the
hour after the last out. Rebuilt from the Gillette Stadium version of this project (Sundai Hack
150): same viewer, same kind of traffic model, a very different problem.

Gillette has huge lots and one road. Fenway has no lots of its own and a whole city grid. Fans park
in small surface lots, multi-level garages and underground garages spread over about a mile, then
squeeze out through streets that are still full of people walking to Kenmore.

---

## The problem

- Fenway seats **37,755** for night games ([Red Sox facts and figures](https://www.mlb.com/redsox/ballpark/facts-figures)).
- The Red Sox list **19 lots and garages** near the park with **3,137 spaces** between them, from 30
  to 500 each, plus two official garages a long walk away: the Prudential Center Garage (3,000
  spaces, shared with a mall and offices) and 100 Clarendon Street (2,000 spaces)
  ([Red Sox parking page](https://www.mlb.com/redsox/ballpark/transportation/parking)).
- A lot of that parking is stacked or buried. Van Ness is "a subterranean parking facility"
  ([VPNE](https://vpne.com/facilities/van-ness-garage/)), 1330 Boylston is an underground garage
  ([The Fenway](https://thefenway.com/explore/park/)), the Prudential garage sits under the whole
  complex, and 401 Park has one level below ground and four above
  ([Suffolk](https://suffolk.com/project/401-park/)). A car on the third level down has to drive up
  three levels and through one gate before it even reaches the traffic.
- The model holds **31 places to park** with room for about **5,300 fan cars** (6,900 if the two
  official garages fill up): 11 surface lots, 15 garages above ground, 5 underground.
- There is no single way out. The model has **11**: Storrow Drive east and west, the Mass Pike
  ramp at Mass Ave, the Mass Ave and BU bridges, Commonwealth Ave, Beacon Street, Route 9, the
  Jamaicaway, Mass Ave south and Boylston Street east.
- For the first quarter hour the streets beside the park belong to people on foot.

Most fans do not drive. A 2010 report put the share taking the T above 50%
([quoted here](https://amateurplanner.blogspot.com/2010/05/transit-mode-share-to-ballparks.html)).
The model's default of **4,500 cars** assumes about a third of a full house comes by car at 2.7 fans
a car. That is an estimate, not a count.

### What the model shows

**Where you park matters more than when you leave.** On the default night the average car spends
24 minutes between its driver reaching it and leaving the map. Cars in the Prudential garage, a
20 minute walk away, are on the street in about 3 minutes and gone in about 8. Cars in the lots and
garages on Van Ness, Ipswich and Lansdowne Streets and in the Kenmore Lot average 35 to 55 minutes,
about half of it waiting to get out of the door, because the street outside is full.

**Fewer cars is not automatically quicker per car.** The closest places fill first, so on a
3,000 car night every car is parked in the crowded blocks beside the park and the average is
25 minutes. The extra 1,500 cars of a full night park farther out, leave by quiet streets and pull
the average down.

**Fans can't fix it alone.** When every fan remembers their own waits and adjusts when they leave,
the average time in the car barely moves (23.5 minutes, then about 23 over 8 games). Same finding as
Gillette: it is a coordination problem.

## What already exists

- **The official garages.** The Red Sox discount the Prudential Center Garage ($25 with a same-day
  ticket) and 100 Clarendon ($12 on nights and weekends). Both are far enough away to exit onto
  streets the Fenway crowd does not use.
- **The T.** Kenmore (Green Line B, C, D), Fenway (D) and Lansdowne (Framingham/Worcester commuter
  rail, across the street from the park).
- **Police and closures.** The city posts traffic advisories for Fenway events, with street
  closures and parking bans run by Boston Police.
- **Traffic simulation tools** (PTV Vissim, Eclipse SUMO) model one event as a consulting job. They
  do not remember across games.

## The idea

The Gillette version proposed paying the right fans to wait. At Fenway the same question has three
levers, all in the viewer:

1. **Move cars out.** Shift a share of close-in cars to the official garages (the discount already
   exists; this asks how much more of it would help).
2. **Hold cars back.** A stay-late offer for cars within a 450 m walk: half of them head out at
   +45 min. This is borrowed from Gillette's delayed-release lots. It is not a real Fenway program.
3. **Open the road.** Police waving outbound traffic through the signals.

Not built yet, same as in the Gillette version: choosing who gets an offer. The groups here would
be garage by direction (31 places to park, 3 directions), ranked by car-minutes saved per dollar.

**Car-minutes saved** = waiting removed, added up over every car. 1,000 cars each waiting
10 minutes less = 10,000 car-minutes saved.

## What runs now

- Real 3D Fenway: Google Photorealistic 3D Tiles when a key is set, otherwise an OpenStreetMap
  model (streets, buildings within 1.1 km, the Charles, the Fens, rail, the ballpark).
- **Every lot and garage in its real place.** Garages are drawn as stacked decks, above or below
  ground. The X-ray switch shows the decks, the cars on them and the tunnels through whatever
  covers them.
- **Cars parked the way the lot is striped.** Rows run along the long side of each footprint,
  cars sit across the rows, and rows come in back-to-back pairs with aisles between. Row
  directions were checked against overhead imagery (Esri World Imagery) for the Kenmore Lot, the
  Van Ness, Boylston and Maitland lots. Small lots that hold more cars than striping allows are
  stack-parked with no aisles, as attendants do on game nights.
- **The closest places fill first.** Lots and garages fill completely in order of the walk to the
  park. A farther one only gets cars once the nearer ones are full.
- A traffic model of the real streets, one-ways included: 109 km counting each direction (`src/sim.js`): a cell transmission model
  (Daganzo 1994) with whole cars, cells of about 40 m and 3 s steps. Each car has its own garage,
  its own level, its own way out and its own route, so jams spill back through intersections and
  past garage doors.
- Cars shaped like cars, with pale headlights and red tail lights, so you can see which way each
  one is going. Lanes sit where the road is: straddling the mapped line on one-way roadways, to
  the right of it on two-way streets.
- Queues marked on the street: a strip fades in amber where traffic backs up and turns red where
  it is jammed. Moving traffic gets no strip.
- Sliders: cars parked, more fans on the T, the west/north/south split, other city traffic, cars
  moved to the official garages, plus the police, stay-late and X-ray switches and the time-lapse.
- A game log: each run is one event the operator would remember, with the slowest place to park.
- Labels count the cars still inside each lot and garage.

### Model results (`node scripts/check_sim.mjs`)

| Scenario | Avg minutes in car | Of which reaching the street | Final-out rush clear | Slowest place to park |
|---|---|---|---|---|
| 4,500 cars, a normal night | 24 | 11 | 81 min | Boston Conservatory lot, 60 |
| Same, police wave traffic out | 21 | 11 | 80 min | Van Ness / Jersey lot, 59 |
| Same, 20% of close-in cars moved to the official garages | 21 | 11 | 76 min | Ipswich Garage, 49 |
| Same, stay-late offer near the park | 17 | 7 | 57 min | 645 Beacon lot, 42 |
| Same, heavy city traffic (55% of the road taken) | 40 | 22 | 109 min | Boston Conservatory lot, 89 |
| 3,000 cars (more fans on the T) | 25 | 14 | 76 min | Boston Conservatory lot, 50 |
| 6,000 cars (few on the T) | 28 | 16 | 78 min | Boston Conservatory lot, 89 |

"In car" runs from the driver reaching the car to the car leaving the map. "Final-out rush clear"
is when 95% of the cars that headed out at the last out are gone. It moves in jumps because it
hangs on a few cars in the worst garage, so read the averages first.

## Numbers and where they come from

Published:

| What | Value | Source |
|---|---|---|
| Seats, night game | 37,755 | Red Sox facts and figures |
| Spaces in each listed lot and garage | 30 to 500, 3,137 in all | Red Sox parking page |
| Prudential Center Garage | 3,000 spaces, 4 entrances | Red Sox parking page |
| 100 Clarendon Street Garage | 2,000 spaces | Red Sox parking page |
| Van Ness, 1330 Boylston: underground | | VPNE, The Fenway |
| 401 Park: 1 level below ground, 4 above | | Suffolk Construction |
| Somerset 6 levels, Ipswich 2, Clarendon 8; Prudential underground | | OpenStreetMap tags |
| Streets, one-ways, lanes, footprints | | OpenStreetMap |

Estimated (every one of these should be replaced by a count):

| What | Value | Why |
|---|---|---|
| Cars at a full house | 4,500 | a third of fans by car, 2.7 a car |
| Kenmore Lot | 194 cars | OpenStreetMap capacity tag and about 190 stalls visible from above; the Red Sox list says 150 |
| 645 Beacon Street lot | 40 cars | all that fits in the lot mapped at that address, stack-parked; the Red Sox list says 60 |
| Which places fill | nearest first, each one completely | fans take the closest space they can get |
| Fan cars in the Prudential garage | 900, up to 1,800 | 30% of the garage, at most 60% |
| Fan cars at 100 Clarendon | 500, up to 1,200 | 25% of the garage, at most 60% |
| Mapped public garages and lots not on the Red Sox list | 9 places, about 690 cars | spaces from area and levels; fans take 90% within 300 m, falling to 15% at 1 km |
| Levels where nobody publishes them | 2 to 4 | marked `levels_src: assumed` in `data/facilities.json` |
| Road capacity | 1,800 cars a lane an hour of green | green share: 50% primary, 45% secondary, 40% tertiary, 30% side streets, 70% ramps, 100% Pike and Storrow |
| Gate rate | 10 cars a minute per exit for a surface lot, 6 garage, 5 underground | pay gates and ramps |
| Driving one level inside a garage | 35 s up or down, 45 s underground | |
| Walking | 75 m a minute, 1.25 times the straight line | crowd pace on a street grid |
| Crowd on the streets | 40% capacity within 350 m for 15 min, back to normal by 30 min | |
| Other city traffic | 30% of every street | late evening |
| Police | 30% more green on signalised streets | |
| Where fans are going | 40% west, 35% north, 25% south | |
| Jersey Street | closed beside the park | the city closes it for big events; the model assumes every game |

One outside check: a parking guide puts getting out of the Ipswich Garage at about 25 to 30
minutes ([parkingaccess.com](https://parkingaccess.com/fenway-park-parking), unsourced). The model
says about 55 for cars that leave at the last out, so the close-in streets are probably too slow in
the model. The crowd and side-street numbers above are the first ones to calibrate.

## Limits

- No street parking, no rideshare pickups, no buses. Only cars from the lots and garages.
- Signals are an average share of green, not real phases.
- Routes are chosen before the game from up to three drives per garage and exit, spread by how
  loaded each street will be. Drivers do not reroute once they are moving.
- Garage footprints come from OpenStreetMap where it has them. Where it does not, the building
  outline or a square of the right area stands in (`shape` in `fenway.json`). Three small lots are
  placed by address only (`approx` in `data/facilities.json`).
- The OpenStreetMap view only has buildings within 1.1 km of the park, so the Prudential and
  Clarendon garages stand in open ground there. The Google view has everything.

## Run it

Needs Node 20+.

```sh
npm install
cp .env.example .env.local    # optional: add VITE_GOOGLE_MAPS_KEY for photoreal tiles
npm run dev                   # http://localhost:5173
npm run check                 # headless model runs, no browser
```

Without a key the viewer shows the OpenStreetMap model, which is fine for development.

To rebuild the data:

```sh
npm run fetch                 # downloads OpenStreetMap data to data/raw/osm.json (not committed)
npm run data                  # writes public/data/fenway.json, takes about 40 s
```

**Keys:** never commit `.env.local` (it's in `.gitignore`), never paste a key in chat or an issue.
Any key used for a public deploy must be restricted to the deployed domain and to the Map Tiles
API only.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Page, control panel, HUD, legend, game log |
| `src/main.js` | three.js viewer: tiles or OSM scene, parking decks and X-ray, stall rows, cars, sliders, game log |
| `src/sim.js` | Traffic model: cells on the street network, garage gates and levels, routes, a season of games |
| `public/data/fenway.json` | Streets, 31 lots and garages, 11 ways out, 1,682 links, rail, buildings, the ballpark, in local metres |
| `data/facilities.json` | The parking table: published spaces, type, levels, exits, and which values are assumed |
| `scripts/fetch_osm.py` | Downloads the OpenStreetMap data |
| `scripts/build_data.py` | Matches parking to footprints, finds the ways out, routes every garage to every exit |
| `scripts/check_sim.mjs` | Headless scenarios and timings |
| `public/draco/` | Draco decoder for the Google tiles |

Coordinates are metres around the centre of the ballpark (42.3465, -71.0971): x east, z south
(in three.js, -z is north).

## Data and credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Row directions in the lots were checked by eye against Esri World Imagery. No imagery is stored
  in this repo.
- Google Photorealistic 3D Tiles must show Google's attribution on screen and may not be cached
  or used for analysis (Map Tiles API policies).
- Built with [three.js](https://threejs.org) and
  [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS).
- Started from Stadium Flow: Leaving Gillette, built at Sundai Hack 150.
