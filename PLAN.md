# Today's plan: Stadium Flow at Sundai Hack 150

Demos at 20:00. Feature freeze 18:30. Read this first; [README.md](README.md) has more background.

## What we're building, in plain words

After a Patriots game, about 13,000 cars try to leave Gillette at once, and there is one road out:
Route 1. The road can only take so many cars a minute, so people sit in the parking lots for an
hour or more.

The stadium already does one smart thing: it pays **$50 to drivers in one lot who agree to leave
75 minutes after the game**. Fewer cars at the whistle means the rest get out faster. But it's
always the same lot, and nobody checks whether that lot is the best place to spend the money.

**We're building a planning tool for the people who run game-day traffic.** Before a game it
answers one question:

> "We have $50,000 for cards. Which lots should get them?"

After the game, it saves what happened, so the next answer is better.

**Not today:** a fan app, fan accounts, payments, or the localmem API. Memory is kept in the
browser (see "Memory" below).

## How it works

### 1. Before the game: the operator enters the event

Expected cars, fans on trains, contraflow lane yes or no, and the card budget.

### 2. The tool compares two plans on a model of the real Route 1

- **Today's plan:** cards go to the one fixed lot. In our map data that is Lot 55, standing in
  for the stadium's Lots 45 and 55B, which aren't named in OpenStreetMap.
- **Our plan:** for every lot, and each direction (north to I-95, south to I-495), the model asks:
  *"if 100 cars from here leave 75 minutes later, how many minutes of driving does everyone
  save?"* The cards go to the lots where that number is highest.

For each plan it shows:
- **Average time in the car**, from the moment you get to your car until you're out on the highway.
- **When the last car leaves.**
- **Minutes saved per $1,000:** the time in the car we remove, added up over every car, for each
  $1,000 of cards. This is the one number that says which plan uses the money better.

### 3. The game is played

The model plays the game with the plan the operator picked. In the demo, the model also plays the
part of the real world (see "Realistic assumptions").

### 4. After the game: the tool saves what happened

It records, per lot:
- how many cards were offered and how many were taken,
- **how many cars a minute actually got out of each lot's gates.** Parking staff or a gate counter
  can count this.

### 5. Next game: the plan uses what was saved

The biggest unknown is how fast each lot really empties. Some lots have one narrow exit; some have
three. We start by assuming 15 cars a minute for every lot. After one game, the counts show the
real speeds, and the plan changes. The screen says what changed and why, for example:

> Lot 52: last game its gates let out about 6 cars a minute (we had assumed 15). Holding one car
> there now saves about 103 minutes of driving in total, up from 76. So 156 more cards ($7,800).

## Does it actually help? What the model says (run `node scripts/check_plan.mjs`)

13,280 cars (14,000 minus 3,000 fans on trains), two lanes north, $50,000 budget:

| | Avg time in car | Minutes saved per $1,000 |
|---|---|---|
| No cards at all | 54 min | n/a |
| Today's plan (one fixed lot) | 52 min | 1,268 |
| Our plan, first game (no history yet) | 47 min | 1,882 |
| Our plan, second game (after learning gate speeds) | 47 min | 1,984 |

**What that means in plain terms:**
1. **Spending the cards on the right lots saves about 50% more driving time per dollar** than the
   fixed lot.
2. **Memory adds about 5% more** after one game, and **the forecast becomes accurate.** Game 1's
   plan predicted 43.7 minutes and the real game gave 47.4. Game 2 predicted 46.7 and got 46.6.
   An operator can trust the plan's numbers.
3. **The last car still leaves 2 to 4 hours after the game.** No plan widens the road. What
   changes is how many people spend that time sitting in a car with the engine running.

These numbers come from our model with made-up lot speeds, not from real Gillette data. The model
is the tool; the real numbers need the stadium's counts.

## Realistic assumptions (said out loud in the demo)

| Assumption | Value | Why we think it's fair |
|---|---|---|
| Road capacity | 1,800 cars per lane per hour | The standard figure traffic engineers use |
| Lot gates | **6 to 24 cars a minute, different per lot**, unknown to the plan at first | Lots differ in exits and staff; we have no real counts |
| Share who take the card | **20% to 80%, different per lot** | Gillette says 1,000+ cars a game use its delayed lot |
| Heading north | 60% | Estimate; I-95 north to Boston is the bigger flow |
| Cars | 14,000 minus about 1,200 per 5,000 train riders | Lot area estimate; the train figure is from Foxborough police |
| When people leave | 55% within 15 min of the end, the rest spread over 90 min | Estimate |

The "real" lot speeds and take rates are hidden in the code (`trueExit`, `trueTake` in
`src/plan.js`). The plan never reads them. It only learns from saved game records, the same way it
would at the real stadium.

## Why 3D? What it should show

A map that just looks real isn't enough. Think of a 3D cutaway of an engine: it's useful because
it shows **the part that's failing and why**. Our 3D view should do the same for the exit:

1. **Lots as tanks.** A column over each lot, as tall as the number of cars still inside. You see
   which lots drain and which stay full.
2. **The road as a queue.** Route 1 coloured, or raised, by how packed each stretch is. You watch
   the jam start at the merge and grow back toward the lots.
3. **The broken part: blocked gates.** When the road next to a lot's exit is full, that gate can't
   let anyone out. Show it as a red ring on the exit. This is the real cause of the hour in the
   lot: not the lot, but the road backing up into it.
4. **Card holders in their own colour.** They stay parked, then leave at +75 minutes onto a road
   that's moving.
5. **Today vs ours on the same clock.** One switch replays either plan, so you see fewer red rings
   and shorter queues with ours.

That is what the 20-second clip should show: **in today's plan the gates by the merge go red and
stay red; in ours, the cards empty out exactly those spots.**

## Memory (local for now)

- A game record is saved in the browser (`src/memory.js`: `listEvents`, `saveEvent`,
  `exportEvents`, `importEvents`).
- Records are counts per lot: no names, plates or phones.
- Export and import a JSON file so the demo can start from a known history.
- Later, the same records can move to a memory service such as localmem. Nothing else changes.

## How the pieces connect (for Maggie and Sid)

```js
import { buildNet, planEvent, runEvent } from './plan.js';
import { listEvents, saveEvent } from './memory.js';

const net = buildNet(data);                         // data = public/data/foxborough.json
const conditions = { cars: 14000, trains: 3000, contraflow: false, budget: 50000 };

const plan = planEvent(net, conditions, listEvents()); // takes 4 to 10 s: show "Planning..."
// plan.today / plan.ours: { kind, budget, cards: { 'Lot 52': 156, ... }, result: {...} }
// plan.ours.result: { avgInCarMin, lastOutMin, carMinSaved, spent, perThousand, offered, taken }
// plan.why: [ 'Lot 52: last game its gates let out about 6 cars a minute ...' ]
// plan.values: [{ lot, dir, cars, value }] every group ranked, best first

const { record, replay } = runEvent(net, conditions, plan.ours, 'game-2');
saveEvent(record);                                  // record.result.exitPerMin = gate counts
const { game, held, crowd } = replay();             // a fresh Game to step for the 3D view
// game.step() moves 3 s; game.state[i]: 0 parked, 1 waiting in lot, 2 on Route 1, 3 gone
// game.cell[dir][c].length = cars in road cell c; game.lotQ[l].length = cars queued at lot l
// held[i] = 1 if car i took a card; crowd.lot[i] = its lot
```

There's a sample output to build the screen against before wiring it up:
`public/data/plan.sample.json`.

## Who does what

| | Owns | Files |
|---|---|---|
| **Vijay** | Plan logic (done: `src/plan.js`), wiring it into the page, numbers, demo script, recording, submission, Google key | `src/plan.js`, `src/sim.js`, `scripts/` |
| **Maggie** (`hello-magnolia`) | The operator screen: event inputs, the two-plan table, the "why" lines, past games | `index.html`, `src/ui/` |
| **Sid** (`siddhrajp`) | The 3D "what's going on" layers, the Today/Ours replay, deploy | `src/main.js`, `src/layers/` |

Owning a file means you merge changes to it; ask before editing someone else's. Swap if you prefer.

## Maggie's tasks: the operator screen

| By | Task | Done when |
|---|---|---|
| 11:45 | Run the app (`npm install`, `npm run dev`, key line in `.env.local`); read this file and `plan.sample.json` | Gillette on your screen |
| 13:00 | **Event panel:** cars, fans on trains, contraflow, budget ($0 to $100,000 in $5,000 steps, showing "= N cards"), and a **Plan game** button. Replace the old sliders | The inputs make a `conditions` object |
| 14:00 | **Two-plan table** from `plan.sample.json`: columns Today and Ours; rows avg time in car, last car out, minutes saved per $1,000, money spent; under it the top lots getting cards | It reads well to someone who's never seen it |
| 15:00 | **Wire it up:** call `planEvent` on click with "Planning..." while it runs (or move it to a Web Worker), then fill the table with live numbers | Changing the budget changes the table |
| 16:00 | **Past games:** a "Play game and save" button (`runEvent` + `saveEvent`), the list of past games from `listEvents()`, the `why` lines under the table, and "Reset history" | Plan, play and save, plan again: the why lines appear |
| 17:00 | Polish: phone width, plain labels, the assumptions in one "How this works" popover | Works at 390 px wide |

## Sid's tasks: the 3D layers and deploy

| By | Task | Done when |
|---|---|---|
| 11:45 | Run the app; read `src/main.js` (`startGame`, `drawCars`, `finishGame`) and the `Game` class in `src/sim.js` | You can explain how a car moves from lot to road |
| 13:00 | **Lots as tanks:** a column per lot (`data.lots[i].c` is its centre), height = cars still inside, updated each frame | Columns shrink as lots empty |
| 14:00 | **Road as a queue:** colour or raise Route 1 cells by `game.cell[dir][c].length` (packed = red) | You see the jam grow back from the merge |
| 15:00 | **Blocked gates:** a red ring on a lot exit when its road cell (`net.lots[l].cell`) is full and the lot still has cars waiting | Red rings appear near the merge at the whistle |
| 16:00 | **Card holders and replay:** held cars in their own colour; a Today/Ours switch that replays either plan from `runEvent(...).replay()` | Switching plans shows fewer red rings with ours |
| 17:30 | **Deploy** to Vercel or Netlify (a static site, no server), with `VITE_GOOGLE_MAPS_KEY` set in the host; send Vijay the domain for the Google key | The public link works on a phone |

## Vijay's tasks

| By | Task |
|---|---|
| Done | `src/plan.js`, `src/memory.js`, `scripts/check_plan.mjs`, `plan.sample.json` |
| 13:00 | Help Maggie and Sid wire in; keep `planEvent` under 10 s (Web Worker if needed) |
| 15:00 | A "start from history" JSON with two past games for the demo |
| 17:30 | Add the deploy domain to the Google key |
| 18:45 | Check every number on screen; demo script; recording; submission |

## The day

| Time | Milestone |
|---|---|
| 11:45 | Everyone running, this file read |
| 13:00 | M1: event panel, lot tanks |
| 15:00 | M2: live table, road queue, blocked gates |
| 16:00 | M3: save a game, plan again, why lines; Today/Ours replay |
| 17:30 | M4: public link |
| 18:30 | Feature freeze, fixes only |
| 18:45 | Recording |
| 19:00 | Rehearse twice, under 3 minutes |
| 19:45 | Submit |

## The 3-minute demo

| At | On screen |
|---|---|
| 0:00 | Gillette in 3D. "One road out. 13,000 cars. You run game-day traffic, and you have $50,000 for cards." |
| 0:30 | Plan game. Today's lot vs ours: minutes saved per $1,000, 1,268 vs 1,882 |
| 1:00 | Replay today's plan: red rings at the gates by the merge, a long queue on Route 1. Switch to ours: the cards empty exactly those spots |
| 1:45 | Play and save. Plan the next game: "Lot 52's gates let out 6 cars a minute, not 15, so 156 more cards there." 1,984 per $1,000, and the forecast now matches what happens |
| 2:30 | "This needs one thing from a real stadium: gate counts per lot. We want one operator to try it for a season." |

## Team rules

- No keys in the repo. The Google key line is shared by private message.
- Small commits to `main`, pull before you push, and say in the chat what you're starting.
- Plain words on screen. Every number is either sourced or labelled an estimate.
- If a milestone slips 30 minutes, cut scope, not the demo. Cut in this order: phone polish, the
  past-games list (keep the why lines), the road colours (keep the red rings).

## If something breaks

- **Google tiles fail on the venue wifi:** the OpenStreetMap model loads on its own.
- **`planEvent` is too slow on a laptop:** use a smaller budget step, or a cached `plan.sample.json`.
- **Our plan doesn't win on some setting:** say so, and show which lots mattered. That's still a
  result.
