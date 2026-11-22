# Today's plan: Stadium Flow at Sundai Hack 150

Demos at 20:00. Feature freeze 18:30. Read this first, then [README.md](README.md) for the full
background.

## Scope in one line

**A planning tool for Gillette's event operators:** before each game it says which lots should
get the $50 delayed-release cards for a given budget, and after each game it saves what happened,
so the next plan is better.

- **The user is the operator:** stadium event operations, with Foxborough police and MassDOT.
- **Not in scope today:** a fan app, fan accounts, or personal offers.
- **The memory holds counts per lot,** no personal data.

## The operator's problem

- Route 1 is the only road out. Two lanes north clear about 3,600 cars an hour, so 14,000 cars
  take more than two hours whatever we do.
- The stadium already pays $50 per car for some lots to leave about 75 minutes late. **The lots
  that get the cards are fixed**, and nobody measures whether they are the right lots for the money.
- After each game the operator knows how many cards each lot took. Nothing turns that into a
  better plan next time.

## What we give the operator

1. **Conditions in:** expected cars, fans on trains, contraflow yes or no, and the card budget.
2. **Two plans out, on the same Route 1 model and the same budget:**
   - **Today's plan:** the fixed delayed-release lot. In our data that is Lot 55, standing in for
     the stadium's Lots 45 and 55B, which aren't named in OpenStreetMap.
   - **Our plan:** the lots ranked by how much road their waiting frees.
3. **Three numbers for each plan:**
   - average minutes in the car,
   - when the last car leaves the lots,
   - **car-minutes saved per $1,000** of cards.
4. **3D playback** of either plan on the real map.
5. **After the game,** a record of the event is saved to localmem.
6. **Next game,** the plan reads the records and says what changed and why.

**Car-minutes saved** means the waiting removed, added up over all cars. If 1,000 cars each wait
10 minutes less, that is 10,000 car-minutes saved.

## Three goals for 19:00

1. **Our plan beats today's plan.** Both columns fill in after one click, for the same budget.
2. **You can see why.** In 3D, today's plan leaves the lots full and Route 1 backed up, while
   ours holds back the right lots and the road keeps moving. A 20-second clip should make the
   point on its own.
3. **Event 2 is smarter than event 1.** The event 2 plan changes because of event 1's record, and
   the screen shows which record. For example: "Lot 42 took only 30% of its cards, so $8,000 moved
   to Lot 15."

Sundai also requires that the app reacts to input, and that we hand in a public link, this repo
and a screen recording.

## Who does what

| | Owns | Files |
|---|---|---|
| **Vijay** | The model and the plan logic, data checks, the demo script, the recording, submission, and the Google key | `src/plan.js`, `src/sim.js`, `scripts/` |
| **Maggie** (`hello-magnolia`) | The operator screen: panel, results, 3D playback, memory panel | `index.html`, `src/main.js`, `src/ui/` |
| **Sid** (`siddhrajp`) | Memory and backend: the events API, localmem, deploy | `api/`, `server/`, `vercel.json` |

Owning a file means you merge changes to it; ask before editing someone else's. Maggie and Sid
can swap roles if they'd rather.

## The contracts (agree these at 11:45, then everyone works in parallel)

### 1. A plan (from `src/plan.js`, read by the UI)

```js
// planEvent(net, conditions, records) -> { today, ours, why }
conditions = { cars: 14000, trains: 3000, contraflow: false, budget: 50000 }

plan = {
  kind: 'today' | 'ours',
  budget: 50000,
  cards: { 'Lot 15': 400, 'Lot 42': 250, ... },   // cards offered per lot ($50 each)
  result: {
    avgInCarMin: 51.2,        // average minutes in the car
    lastOutMin: 175,          // minutes after the game the last car leaves the lots
    carMinSaved: 61000,       // vs no cards at all
    perThousand: 1220         // carMinSaved / (cards taken × $50 / 1000)
  }
}

why = ["Lot 42 took 30% of its cards last game (record 2026-11-23-g1), so $8,000 moved to Lot 15"]
```

Until `plan.js` lands, the UI uses a fixture: `public/data/plan.sample.json` (Vijay commits it
by 12:15).

### 2. An event record (saved after each game, read before the next)

```json
{
  "id": "2026-11-23-g1",
  "venue": "gillette",
  "conditions": { "cars": 14000, "trains": 3000, "contraflow": false, "weather": "clear" },
  "plan": { "kind": "ours", "budget": 50000, "cards": { "Lot 15": 400, "Lot 42": 250 } },
  "result": {
    "taken": { "Lot 15": 310, "Lot 42": 75 },
    "clearedMin": { "Lot 15": 128, "Lot 42": 96 },
    "avgInCarMin": 44.0,
    "lastOutMin": 171
  }
}
```

In the demo, "taken" comes from the model: each lot has a hidden real take rate, so event 1
produces counts that the plan for event 2 can learn from.

### 3. The events API (Sid's server, called by the page)

| Call | Does |
|---|---|
| `POST /api/events` with an event record | Saves it to localmem, returns `{ ok, id }` |
| `GET /api/events?venue=gillette` | Returns past records, newest first |

The localmem key lives **only in the server's environment**, never in the page or the repo. If
localmem can't be reached, the server falls back to a local JSON file and the response says
`"memory": "offline"`, so the UI can show it.

## Maggie's tasks: the operator screen

The current left panel has sliders and a "Run game" button (`index.html`, `startGame()` in
`src/main.js`). It turns into the operator's planning screen.

| By | Task | Done when |
|---|---|---|
| 11:30 | `npm install` and `npm run dev`; put the key line in `.env.local`; read `src/main.js` (`startGame`, `drawCars`, `finishGame`) | Photoreal Gillette on your laptop |
| 13:00 | **Panel:** an "Event" group (cars, fans on trains, contraflow) and a "Budget" slider ($0 to $100,000 in $5,000 steps, showing the card count, budget ÷ 50), then a **Plan event** button. Fill it from `plan.sample.json` first | Clicking Plan event shows a table with the two plans as columns and the three numbers as rows |
| 15:00 | **3D playback:** a Today / Ours switch that replays that plan. Lots with cards get an outline and a label ("Lot 15 · 400 cards"); held cars get their own colour until they leave at +75 min | Switching plans and replaying shows the difference on the map |
| 16:00 | **Memory panel:** after a game, a **Save event** button (calls `POST /api/events`); a list of past events from `GET /api/events`; the `why` lines under the plan table, each linked to its record; an "offline" badge when the API says so | Plan, save, plan again: the second plan shows a "what changed" line |
| 17:00 | **Polish:** a fly-in camera on load, readable at phone width, no overlapping panels | Looks right at 1440 px and 390 px wide |

Tips:
- Keep the three.js scene as it is. Your work is mostly the DOM panel, and colouring and labelling
  lots that already exist (`data.lots`, each with `name`, `c` as its centre and `p` as its outline).
- `CSS2DObject` labels are already used (`label()` in `main.js`).

## Sid's tasks: memory and backend

| By | Task | Done when |
|---|---|---|
| 11:30 | Run the app; read the [localmem quickstart](https://localmem.org/docs/memory-api/quickstart.md) and [SDKs](https://localmem.org/docs/memory-api/sdks.md); get the key from Vijay by private message | You understand write and recall in the SDK |
| 12:30 | **API skeleton:** `api/events.js` as a Vercel function (or a small Node server that Vite proxies `/api` to), with POST and GET backed by a JSON file. Commit early so Maggie can call it | `curl` POST, then GET, returns the record |
| 13:00 | **localmem:** `npm i @localmem/memory`; on POST, write the record (one memory per event, about "gillette events"); on GET, recall them and return the JSON. Key from `process.env` only | One test record written to localmem and read back |
| 16:00 | **In the loop:** check that the plan really reads the records. Add an "offline" fallback to the local file when localmem fails or is slow (over 3 seconds) | Event 2's plan changes after event 1 is saved, and still works with the network off |
| 17:30 | **Deploy** to Vercel: environment variables set, the Maps key line set as `VITE_GOOGLE_MAPS_KEY`; send Vijay the domain so he can allow it on the Google key | The public link works on a phone |

Rules for the backend:
- Never log or return the localmem key.
- Validate the POST body: known fields only, numbers as numbers, at most 50 KB.

## Vijay's tasks

| By | Task |
|---|---|
| 12:15 | Commit `public/data/plan.sample.json` for the UI |
| 13:00 | `src/plan.js`: groups (lot × direction), value of 100 cars waiting 75 min, take rates (hidden real rates in the model, learned rates from records), ranking, budget fill; a headless check prints today vs ours |
| 16:00 | `why` lines from the records; event 2 changes because of event 1 |
| 17:30 | Add the deploy domain to the Google key's allowed sites |
| 18:45 | Check every number on screen against its source or label it an estimate; demo script; recording; submission |

## The day

| Time | Milestone |
|---|---|
| 11:30 | Everyone running on their own laptop |
| 11:45 | Contracts above agreed (15 minutes, all three) |
| 13:00 | M1: plan logic headless, API round-trip, panel on the fixture. Lunch |
| 15:00 | M2: the real plan on screen, playback of both plans |
| 16:00 | M3: memory in the loop (save, then plan again, and it changes) |
| 17:30 | M4: public link |
| 18:30 | Feature freeze, fixes only |
| 18:45 | Recording |
| 19:00 | Rehearse twice, under 3 minutes |
| 19:45 | Submit |

## The 3-minute demo

| At | What happens on screen |
|---|---|
| 0:00 | Fly in over Gillette: "One road out. 14,000 cars. You run game-day traffic." |
| 0:30 | Enter tonight's event with a $50,000 budget, then Plan event. Two columns: today's lot vs ours |
| 1:15 | Play today's plan, then ours. Point at Route 1 and the lots. Read car-minutes saved per $1,000 |
| 2:00 | Save the event. Plan the next game: the plan changes, with "Lot 42 took only 30%, $8,000 moved to Lot 15" |
| 2:40 | "Any venue with one road out. We want one operator to try it on a real game." |

## Team rules

- No keys in the repo, ever. The Maps key line is shared by private message; the localmem key
  lives only in the server environment.
- Small commits to `main`, pull before you push, and say in the chat what you're starting.
- Every number on screen is either sourced or labelled an estimate.
- If a milestone slips 30 minutes, cut scope, not the demo. Cut in this order: fly-in, the memory
  list (keep the `why` line), the phone layout.

## If something breaks

- **Google tiles fail on the venue wifi:** the OpenStreetMap model loads on its own.
- **localmem can't be reached:** the local file fallback, with "memory offline" on screen.
- **Our plan doesn't beat today's:** say so on stage, and show which lots gave the most. That is
  still a result.
