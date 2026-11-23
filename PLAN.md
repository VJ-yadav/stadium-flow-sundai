# Stadium Flow: the exit planner for Gillette Stadium

Sundai Hack 150, MIT E38, 23 November 2026. Team: Vijay Yadav, Magnolia Cheng, Siddhraj Parmar.

**Live:** https://stadium-flow-sundai-five.vercel.app · **Code:** https://github.com/VJ-yadav/stadium-flow-sundai

> **The goal:** a 3D tool that lets Gillette's operator spend their game-day money where it
> actually keeps Route 1 moving, and see the result before the game.
>
> **What we built:** the operator picks the options they can use tonight: a contraflow lane,
> extra staff at the slowest gates, paid delayed lots. Stadium Flow plays the night on a traffic
> model of the real Route 1, shows what each option does and what it takes, and replays it in 3D.
>
> **What it found (15,000 cars):** together, the three options get the average fan to the
> highway in **56 minutes instead of 83**, cut drivers stuck over an hour in their car from
> **6,506 to 992**, and the last car leaves at **143 minutes instead of 259**, for about the same
> card money Gillette spends today. Today's single delayed lot barely moves those numbers.

## The problem

After a Patriots game about 14,000 cars leave through one road, Route 1. It carries about 1,800
cars per lane per hour. The queue backs up from the road into the lots: a lot's gate can't let
anyone out when the road outside is full. Some lots are also slow on their own, because one gate
lets out only a few cars a minute. Fans sit in running cars for close to an hour, and the slowest
lots are still emptying four hours after the whistle.

## What Gillette does today

- **"Be Paid to Park"** (stadium parking page, 2025 season): Lots 45 and 55B are delayed lots.
  Parking there is free, the lot opens 75 minutes after the game, and every car gets a $50 Visa
  card. About 800 cars in our model, $40,350 a game.
- **Contraflow:** MassDOT can turn one southbound lane of Route 1 northbound for big events.
- **Gate staffing** is the stadium's own choice.

The operator has these levers, but no way to see before the game what each one does, or which
combination is worth the money.

## How the tool works, plainly

1. **Every car is simulated.** About 14,000 cars, each with a lot, a direction (60% north to
   I-95) and the time its driver reaches the car after the game.
2. **Route 1 is cut into 40 m boxes.** A box holds at most 5 cars per lane, and the road passes
   at most 1,800 cars per lane per hour. Every 3 seconds cars move forward a box if there is room.
3. **Each lot has a gate** that lets out a few cars a minute (6 to 24, our estimate per lot), but
   only when the road box outside it has room. If it is full, the gate is blocked.
4. **The options change the model:** contraflow adds a northbound lane; extra staff raises a gate
   to 24 cars a minute; a delayed lot holds its cars until its opening time. The planner picks
   which delayed lots, within the card budget.
5. **Every option is played on the same night** (same cars, same lots), alone and together, and
   we count what the operator cares about.

## The numbers on the screen

| Number | What it means |
|---|---|
| **Route 1 jammed** | Minutes with 400 m or more of Route 1 at walking pace. |
| **Avg to highway** | Minutes from the whistle until the average driver reaches I-95 or I-495. |
| **Over an hour in the car** | Drivers who sit more than an hour in their car (lot queue plus Route 1). |
| **Last car out** | When the last car reaches the highway. |
| **Takes** | What the option needs: a police detail for the lane, a crew at the gates, cards. |

## Results: 15,000 cars, 3,000 fans on trains (14,280 cars), $50,000 card budget

| Option | Route 1 jammed | Avg to highway | Over an hour in the car | Last car out | Takes |
|---|---|---|---|---|---|
| Nothing extra | 107 min | 83 min | 6,506 | 259 min | nothing |
| Today: Lot 55 delayed | 106 min | 84 min | 6,227 | 259 min | $40,350 of cards |
| Contraflow lane | 56 min | 65 min | 3,199 | 258 min | police detail for the lane |
| Extra staff at the 3 slowest gates | 124 min | 79 min | 5,990 | 220 min | crew at 3 gates |
| 5 delayed lots (chosen by the planner) | 107 min | 83 min | 5,758 | 257 min | $48,050 of cards |
| **Plan: all three together** | **69 min** | **56 min** | **992** | **143 min** | lane, crew at 3 gates, $48,050 |

**What this says:**

- **Today's program barely moves anything:** $40,350 a game and the average fan still needs 84
  minutes. Its fans wait 75 minutes and then sit about 79 minutes more in their car, because
  Lot 55's gate is one of the slowest.
- **Contraflow is the biggest single lever for the road:** the jam halves, the average drops to
  65 minutes. But the last car still leaves after four hours: the slow lots are untouched.
- **Extra staff fixes the long tail:** Lots 42, 50A and 55 hold about 3,400 cars behind gates of
  6 to 8 cars a minute. On its own it pushes cars onto Route 1 sooner, so the road jams longer;
  it needs the lane.
- **Delayed lots spread out what is left:** small on their own (about 750 fewer drivers over an
  hour), and the planner's lots open onto a road that is already clearing.
- **Together:** 27 minutes faster on average, **85% fewer drivers stuck over an hour**, and the
  last car out almost **two hours sooner**, for about the same card money as today.
- The plan's Route 1 jam (69 min) is longer than contraflow alone (56 min) because the staffed
  lots empty onto the road instead of holding people in the lots: the road stays busy, but far
  fewer people are stuck.

## How the lots open under the plan

The Results panel shows a bar per lot: when its cars leave and when it is empty, against the same
lot with nothing extra. The slowest lots:

| Lot | Cars | Under the plan | Empty at | With nothing extra |
|---|---|---|---|---|
| Lot 42 | 1,437 | extra staff, gate 24 cars a minute | 103 min | 254 min |
| Lot 55 | 807 | extra staff | 102 min | 203 min |
| Lot 51 | 804 | normal, gate 6 cars a minute | 138 min | 190 min |
| Lot 50A | 1,163 | extra staff | 103 min | 176 min |
| Lot 54A | 647 | normal, gate 6 cars a minute | 129 min | 169 min |

The 5 delayed lots (Unnamed lots 26, 29 and 33, Parking Lot 6A, Lot 54B) open at 75 minutes.
Opening them at 45 minutes would leave 1,702 drivers over an hour instead of 992.

## Maggie's merge rule, plainly

When the road outside a lot's gate is full and a gap opens, who takes it: the car already on
Route 1, or the car waiting at the gate? Our first model said Route 1 always goes first.
Magnolia's change (the standard merge rule from traffic research, Daganzo 1995) lets them **take
turns, like a zipper**, in proportion to how much each side can carry. It is more realistic, and
it changes **which** lots wait: with Route 1 first, the lots nearest I-95 wait longest; with a
full zipper, the southern lots do. Around a setting of 0.25 they wait about the same, so that is
our default.

How a full merge is shared at Gillette is unknown until someone counts it, so it is a model
setting in the tool. **The plan's result holds under every setting (15,000 cars):**

| Merge rule | Avg to highway: nothing, plan | Over an hour: nothing, plan | Last car: nothing, plan |
|---|---|---|---|
| Route 1 always first (0) | 83, **56** min | 6,685, **1,055** | 250, **142** min |
| Mostly Route 1 first (0.25, default) | 83, **56** min | 6,506, **992** | 259, **143** min |
| Full zipper (1) | 84, **57** min | 6,147, **1,148** | 305, **166** min |

## The demo, step by step (5 minutes)

**Inputs (Plan panel):** cars parked **15,000** · fans on trains **3,000** · contraflow lane
**on** · extra staff **3 slowest gates** · delayed lots **on** · card budget **$50,000** · open at
**75 min** · model setting unchanged. Click **Test these options** (about 15 seconds).

| Time | What we show | What we say |
|---|---|---|
| 0:00 | Map at the whistle, white towers | "After a Patriots game, 14,000 cars leave through one road. The average fan needs 83 minutes to reach the highway; the last car, over four hours." |
| 0:40 | Jump to 45 min, **Nothing extra**: red bars, 15 red rings | "Two problems: the road is full, and some lots have slow gates. Red rings are lots that can't let anyone out." |
| 1:20 | Plan panel: the inputs above | "Gillette already has three levers: a contraflow lane, gate staff, and $50 delayed lots. Which ones, and what do they buy?" |
| 2:00 | Results table | "Each alone helps a little. Today's delayed lot barely moves anything. Together: 56 minutes instead of 83, 992 drivers over an hour instead of 6,506, the last car out in under two and a half hours instead of four." |
| 3:00 | 45 min, switch **Nothing extra ↔ Plan** | "Same moment: 8 red rings instead of 15, 4,671 cars waiting at gates instead of 7,468." |
| 3:30 | Jump to **2 h**, click **Lot 42** | "With nothing extra, Lot 42 still has cars after two hours. With a crew at its gate it was empty at 103 minutes." |
| 4:10 | Close | "One screen for the operator: spend the money where it keeps Route 1 moving, and see it before the game." |

**What the map shows at each jump (Plan / Nothing extra):**

| Jump to | Waiting at gates | Gates blocked |
|---|---|---|
| 20 min | 4,853 / 6,039 | 12 / 25 |
| 45 min | 4,671 / 7,468 | 8 / 15 |
| Delayed lots open (76 min) | 1,568 / 5,842 | 0 / 7 |
| 2 hours | 165 / 2,753 | 0 / 0 |

## How to read the screen

- **Icons on the left** (top on a phone): Plan, Results, Map key. Each opens a large panel; click
  the icon again or press Esc to fold it away.
- **Towers** are lots; height is the cars still in the lot. White: not at the car yet. Amber: in
  the car, engine on. Blue: a delayed lot waiting on purpose. Green tag: extra staff at the gate.
- **Bars along Route 1** are the queue: green moving, tall and red packed. **Red rings** are
  blocked gates.
- **Player bar:** Nothing extra / Today: Lot 55 / Plan at the same minute; Play; jump to a moment.
  "Watch" on any row of the results replays that option. The top right shows the same counts for
  the option you compare against.
- **Click a tower** to fly to it and see when it empties; it can switch a lot between delayed and
  normal. Scroll or pinch to zoom.

## Assumptions (said out loud)

| Assumption | Value | Source or reason |
|---|---|---|
| Road capacity | 1,800 cars per lane per hour | Standard traffic engineering figure |
| Gate speeds | 6 to 24 cars a minute, fixed per lot | Our estimate; no counts yet |
| Extra staff | Brings a gate to 24 cars a minute | Estimate: two attendants or a second exit lane |
| Contraflow | One extra northbound lane | MassDOT practice for big events |
| Delayed lot | Whole lot, opens at 75 min, $50 a car | Gillette's 2025 parking page |
| Merge rule | 0.25 by default, 0 to 1 in the tool | Magnolia's model; unknown for Gillette |
| Heading north | 60% | Estimate; I-95 north to Boston is the bigger flow |
| Cars | Cars parked minus about 1,200 per 5,000 train riders | Lot area estimate; Foxborough police for trains |
| When people leave | 55% within 15 min of the end, the rest over 90 min | Estimate |
| Lot names | OpenStreetMap; "Lot 55" stands in for Lots 45 and 55B | Some OSM lots may not be Gillette's |

Staff and police costs are not in dollars yet: we don't have the rates.

## Built with

three.js (3D, labels, picking), Google Photorealistic 3D Tiles (the real Gillette and Route 1),
OpenStreetMap (lots, roads), a cell transmission traffic model in the browser (Daganzo 1994, with
the 1995 merge), a Web Worker for the planner, Vite, Vercel.

## Who did what

- **Vijay Yadav:** the exit planner (`src/plan.js`): options, choosing delayed lots, the numbers,
  the lot schedule; the operator screen; the story.
- **Magnolia Cheng:** the merge rule in the traffic model (`src/sim.js`).
- **Siddhraj Parmar:** 3D v2 (the comparison option on the same clock, cars waiting at gates, map
  credits), the events API (`api/events.js`), and deploy.

## Next

- Count real gate speeds and the merge at Gillette for one game, and let the tool learn them.
- Dollar costs for staff and the lane, so "what it takes" is one number.
