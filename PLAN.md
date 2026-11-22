# Stadium Flow: the delayed-lot planner for Gillette Stadium

Sundai Hack 150, MIT E38, 23 November 2026. Team: Vijay, Maggie, Sid.

> **One line:** Gillette already pays fans $50 to leave one lot late. Stadium Flow tells the
> operator **which lots, and how many**, to make delayed lots for tonight's game, shows the effect
> on a 3D model of Route 1, and gets better each game by remembering how fast every gate really
> emptied.

## The problem

After a Patriots game about 13,000 cars try to leave at once through one road, Route 1. The road
carries about 1,800 cars per lane per hour, so the crowd can't all leave in the first half hour.
The queue backs up from Route 1 into the lots: a lot's gate can't let anyone out when the road
outside it is full. People sit in running cars for close to an hour.

## What Gillette does today

Gillette's "Be Paid to Park" program (stadium parking page, 2025 season):

- **Lots 45 and 55B are delayed lots.** Parking there is free, fans reserve a spot before the
  game, the lot is locked 30 minutes after kickoff, and it opens **75 minutes after the game**.
- **Every car in a delayed lot gets a $50 Visa gift card.**
- Stadium-side lots are paid. General parking across Route 1 is free.

So the operator already has the lever. What they don't have is a way to decide **which lots** to
delay and **how many**, for a given game, and to see the effect before the night.

## What Stadium Flow does

1. **Before the game** the operator enters the night: cars expected, fans on trains, contraflow
   lane or not, the card budget, and when delayed lots open.
2. **The planner recommends delayed lots.** It tries each lot as a delayed lot on a traffic model
   of the real 7.3 km of Route 1, adds the lot that helps most per dollar, tries again with that
   lot included (lots on the same stretch of road help each other less), and stops when the
   budget is spent. A delayed lot is the whole lot: every car in it is held and gets the card.
3. **The operator can overrule it.** Every lot can be switched between delayed and normal, from
   a list or by clicking its tower on the map, and the plan is re-tested in a few seconds.
4. **The 3D view replays the night** for three plans on the same clock: no delayed lots,
   today's Lot 55, and the plan.
5. **After the game the operator saves it.** The record holds how fast each lot's gates really
   let cars out. The next plan uses those counts instead of the guess (15 cars a minute).

## What the operator sees (the numbers that matter to them)

We measure the night the way an operator or the town would judge it, not by one average:

| Number | What it means |
|---|---|
| **Gate-minutes blocked** | Minutes a lot had cars waiting at its gate while Route 1 outside was full, added up over all lots. The "stuck in the lot" feeling. |
| **Engine idling, all cars** | Hours spent in a car with the engine on: in the lot queue and on Route 1. |
| Route 1 jammed | Minutes with 400 m or more of Route 1 at walking pace. |
| Cars stuck at the worst moment | Cars waiting in lots or on packed road at the peak, about 28 minutes after the whistle. |
| Avg whistle to highway | Shown, but it barely moves (see below). |

**Why time-to-highway barely moves, and why that's fine:** Route 1 carries the same number of cars
an hour whatever we do. Delayed lots don't make the road faster. They move about 1,000 cars' wait
out of running cars and out of the jam, into the stadium and Patriot Place, so the other lots'
gates are blocked less and fewer engines idle. Those fans get home about an hour later, for free
parking and $50. That is the trade Gillette already makes; we make it pay off more.

## Results (14,000 cars, 3,000 on trains, $50,000 budget, real gate speeds)

Default merge rule ("Route 1 mostly first", see the next section). First game, no memory yet:

| | No delayed lots | Today: Lot 55 | Plan (7 lots) |
|---|---|---|---|
| **Gate-minutes blocked** | 1,301 | 1,178 (−9%) | **953 (−27%)** |
| **Engine idling** | 12,002 h | 11,408 h (−594 h) | **11,010 h (−992 h)** |
| Route 1 jammed | 100 min | 97 min | 102 min |
| Cars held (one card each) | 0 | 750 | 951 |
| Card cost | $0 | $37,500 | $47,550 |

**For 27% more money than today's lot, about three times the drop in blocked gates and 1.7 times
the idling saved.** The plan does it with smaller lots spread along Route 1, where each held car
unblocks the most gates behind it, instead of one big lot.

Second game, after saving the first one's gate counts: the planner swaps three lots whose gates
turned out slower or faster than assumed. Route 1 jammed 92 min instead of 102; blocked gates and
idling about the same (969 gate-minutes, 900 h saved). The first plan was already close; memory
mostly corrects lots the guess got wrong, and each change is explained on screen with the count
that caused it.

Run it yourself: `node scripts/check_plan.mjs` (add `--zipper=0` or `--zipper=1` for the other
merge rules).

## Maggie's zipper merge: what it models and why it matters

**What it is.** When the road beside a lot's gate is full, who goes next: a car already on Route 1,
or a car waiting at the gate? Our first model said Route 1 always goes first. Maggie's branch adds
the standard rule from traffic research (Daganzo 1995, the merge in the cell transmission model):
the space that opens is **shared between the road and the gates in proportion to their
capacities**. A gate that lets out 15 cars a minute beside two lanes (60 a minute) gets 20% of
the space. A setting from 0 to 1 says how strongly gates get their share:

| Setting | In plain words |
|---|---|
| 0 | Route 1 cars always go first. Lots wait until the road behind them thins out. |
| **0.25 (our default)** | Route 1 mostly goes first; gates get a quarter of their fair share. |
| 0.5 | In between. |
| 1 | Full zipper: gates get their full share, like cars taking turns at a merge. |

**Why it is good for the model.**

- **It is closer to how a real merge works.** Drivers at a gate do get in; police at Gillette wave
  lots out in turns. A model where a gate waits for an empty road overstates how long the lots
  nearest the highway sit, and understates how long the road itself stays packed.
- **It changes who waits, not only how long.** Maggie's runs (14,000 cars, 2 lanes north), average
  minutes waiting in the lot:

  | Lots by where they join Route 1 | Route 1 first (0) | Full zipper (1) |
  |---|---|---|
  | Southern lots (5,462 cars) | 13 | 75 |
  | Middle lots (4,569 cars) | 47 | 36 |
  | Northern lots, nearest I-95 (3,969 cars) | 99 | 13 |

  Around 0.25 the three groups wait about the same, which is why we use it as the default.

- **It keeps us honest.** With Route 1 always first, our plan looked like it halved the time
  Route 1 is jammed (52 to 25 min). With merges shared, the road itself becomes the queue, and the
  jam barely moves for any plan. We now lead with the numbers that hold under every rule.

**What it does to our results** (first game, $50,000, real gate speeds):

| Merge rule | Blocked gate-minutes: none, Lot 55, plan | Idling saved: Lot 55, plan | Route 1 jammed: none, Lot 55, plan |
|---|---|---|---|
| 0, Route 1 first | 1,118, 1,040 (−7%), **710 (−36%)** | 652 h, **869 h** | 52, 42, **19** min |
| **0.25, default** | 1,301, 1,178 (−9%), **953 (−27%)** | 594 h, **992 h** | 100, 97, 102 min |
| 1, full zipper | 1,814, 1,637 (−10%), **1,359 (−25%)** | 515 h, **890 h** | 111, 106, 109 min |

So: **under every rule the plan beats today's lot on blocked gates and idling.** How much Route 1's
jam shortens depends on the rule, which we can't know until we see a real night. The merge rule is
a setting in the planner so the operator can see that range. Real gate and road counts from one
game would tell us which rule fits Gillette; that is the next thing memory should learn.

## Memory: what is saved, for whom

- **Saved after each game, per lot:** how many cars a minute its gates really let out (from the
  5 busiest minutes, only lots with 100 or more queued cars), when it emptied, and the plan used.
  No names, plates or phones.
- **For the operator:** the next plan uses real gate speeds instead of a guess, and says which
  lots changed and why ("Lot 41: its gate let out about 6 cars a minute in game 1, we had
  assumed 15; now a delayed lot.").
- **Where:** in the browser for the demo (`src/memory.js`, with download). Sid's `api/events.js`
  can save the same records to localmem, with a local file fallback; it is merged but not wired
  into the demo.

## How to read the screen

- **Icons on the left** (top on a phone): Plan, Results, Past games, Map key. Each opens a large
  panel; click the icon again or press Esc to fold it away and see the whole map.
- **Towers** are lots. Height is the cars still in the lot (1,000 cars is about 200 m). White: not
  at the car yet. Amber: in the car, engine on, trying to get out. **Blue: a delayed lot, waiting
  on purpose.**
- **Bars along Route 1** are the queue, one per 40 m and direction: green moving, tall and red
  packed.
- **Red rings** are blocked gates; the red line points to the stretch of Route 1 blocking it.
- **Player bar** at the bottom: switch No delayed lots / Today: Lot 55 / Plan at the same minute,
  Play, jump to a moment. The top right shows the same counts for the plan you compare against.
- **Click a tower** to fly to it, see its numbers, and switch it between delayed and normal.
- **Zoom**: scroll or pinch (toward the pointer), the + and − buttons, or "Go to a lot".

## The 5-minute demo

| Time | What we show | What we say |
|---|---|---|
| 0:00 | The 3D map paused at the whistle, 13,000 cars in white towers | "After a Patriots game, 13,000 cars leave through one road. People sit in running cars for close to an hour." |
| 0:30 | Jump to 30 min: amber towers, red Route 1 bars, red rings | "This is the broken part. The lots aren't slow; the road outside is full, so the gates are blocked." |
| 1:00 | Plan panel | "Gillette already pays $50 a car to hold one lot until 75 minutes after the game. The operator's question is which lots, and how many." |
| 1:30 | Recommend delayed lots; Results panel | "Same kind of budget. Today's lot cuts blocked gates 9%. These seven smaller lots cut them 27% and save about 1,000 hours of idling." |
| 2:15 | Switch Today / Plan at minute 30 | "Same moment, two plans: count the red rings." |
| 2:45 | Click a tower, make it a normal lot, re-test | "The operator stays in charge: switch any lot, see the effect in seconds." |
| 3:15 | Merge rule setting, 0 to 1 | "We don't know yet how Gillette's merges behave. Under every rule the plan beats today's lot; the jam itself shortens only if Route 1 gets priority." |
| 3:45 | Save the game, plan again, "What memory changed" | "Each game we count how fast every gate really emptied. Next game the plan swaps the lots the guess got wrong, and says why." |
| 4:30 | Close | "Same lever Gillette already pulls, aimed better, getting better every game." |

## Realistic assumptions (said out loud)

| Assumption | Value | Source or reason |
|---|---|---|
| Road capacity | 1,800 cars per lane per hour | Standard traffic engineering figure |
| Lot gates | 6 to 24 cars a minute, different per lot, hidden from the planner | No real counts; memory learns them |
| Merge rule | 0.25 by default, 0 to 1 in the planner | Maggie's model; unknown for Gillette |
| Delayed lot | Whole lot held, opens at 75 min, $50 a car | Gillette's 2025 parking page |
| Heading north | 60% | Estimate; I-95 north to Boston is the bigger flow |
| Cars | 14,000 minus about 1,200 per 5,000 train riders | Lot area estimate; Foxborough police for trains |
| When people leave | 55% within 15 min of the end, the rest over 90 min | Estimate |
| Lot names | OpenStreetMap; "Lot 55" stands in for Gillette's Lots 45 and 55B | Some OSM lots may not be Gillette's to delay |

## Who did what

- **Vijay:** the planner (`src/plan.js`): whole delayed lots, choosing lots by blocked gates,
  idling and jam, the operator's switches, memory of gate speeds, the operator screen.
- **Maggie:** the zipper merge in the traffic model (`src/sim.js`), with the lot-wait comparison.
- **Sid:** 3D v2 (the comparison plan on the same clock, cars waiting at gates, readable map
  credits) and the events API (`api/events.js`, `server/events.js`) for saving games to localmem.

## Branches and next steps

- **`backup-full-demo`** has everything merged: the planner, Maggie's merge rule and both of Sid's
  branches. Test it locally first (`npm ci`, then `npm run dev`, open localhost:5173).
- **`main`** takes it once the team has looked at it locally.
- **Deploy (Vercel)** after that: add the deploy address to the Google key's allowed sites.
- After the demo: delete the one-day Google key; wire Sid's events API into the app; learn the
  merge rule from real counts.
