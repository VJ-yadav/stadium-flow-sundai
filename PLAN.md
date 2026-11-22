# Stadium Flow: the exit planner for Gillette Stadium

Sundai Hack 150, MIT E38, 23 November 2026. Team: Vijay, Maggie, Sid.

> **The goal:** a 3D tool that lets Gillette's operator spend their game-day money where it
> actually keeps Route 1 moving, and see the result before the game.
>
> **What we built:** the operator picks the options they can use tonight (a contraflow lane,
> extra staff at slow gates, paid delayed lots). Stadium Flow plays the night on a traffic model
> of the real Route 1, shows what each option does and what it takes, and replays the plan in 3D.
>
> **What it found:** together, the three options get the average fan to the highway in
> **53 minutes instead of 78**, cut drivers stuck over an hour in their car from **5,549 to 391**,
> and the last car leaves at **132 minutes instead of 242**. Today's single delayed lot moves
> those numbers by almost nothing.

## The problem

After a Patriots game about 13,000 cars leave through one road, Route 1. It carries about 1,800
cars per lane per hour. The queue backs up from the road into the lots: a lot's gate can't let
anyone out when the road outside is full. Some lots are also slow on their own, because one gate
lets out only a few cars a minute. Fans sit in running cars for close to an hour; the slowest lots
are still emptying four hours later.

## What Gillette does today

- **"Be Paid to Park"** (stadium parking page, 2025 season): Lots 45 and 55B are delayed lots.
  Parking there is free, the lot opens 75 minutes after the game, and every car gets a $50 Visa
  card. About 750 cars in our model, $37,500 a game.
- **Contraflow:** MassDOT can turn one southbound lane of Route 1 northbound for big events.
- Gate staffing is the stadium's own choice.

The operator has these levers but no way to see, before the game, what each one does or which
combination is worth the money.

## How the tool works, plainly

1. **Every car is simulated.** About 13,000 cars, each with a lot, a direction (60% north to I-95)
   and the time its driver reaches the car after the game.
2. **Route 1 is cut into 40 m boxes.** A box holds at most 5 cars per lane and the road passes at
   most 1,800 cars per lane per hour. Every 3 seconds cars move forward a box if there is room.
3. **Each lot has a gate** that lets out a few cars a minute (6 to 24, our estimate per lot), but
   only when the road box outside it has room. If it is full, the gate is blocked.
4. **The options change the model:** contraflow adds a northbound lane; extra staff raises a
   gate to 24 cars a minute; a delayed lot holds its cars until its opening time.
5. **Every option is played on the same night** (same cars, same lots), alone and together, and
   we count what the operator cares about.

## The numbers on the screen

| Number | What it means |
|---|---|
| **Route 1 jammed** | Minutes with 400 m or more of Route 1 at walking pace. How smooth the road is. |
| **Avg to highway** | Minutes from the whistle until the average driver reaches I-95 or I-495. |
| **Over an hour in the car** | Drivers who sit more than an hour in their car (lot queue plus Route 1). |
| **Last car out** | When the last car reaches the highway. |
| **Takes** | What the option needs: a police detail for the lane, a crew at the gates, cards. |

## Results (14,000 cars, 3,000 on trains, default merge rule)

| Option | Route 1 jammed | Avg to highway | Over an hour in the car | Last car out | Takes |
|---|---|---|---|---|---|
| Nothing extra | 100 min | 78 min | 5,549 | 242 min | nothing |
| Today: Lot 55 delayed | 97 min | 79 min | 5,234 | 241 min | $37,500 of cards |
| Contraflow lane | 48 min | 61 min | 2,707 | 239 min | police detail for the lane |
| Extra staff at the 3 slowest gates | 115 min | 75 min | 5,085 | 208 min | crew at 3 gates |
| 8 delayed lots (chosen by the planner) | 101 min | 77 min | 4,341 | 233 min | $48,150 of cards |
| **Plan: all three together** | **48 min** | **53 min** | **391** | **132 min** | lane, crew at 3 gates, $48,150 |

**What this says:**

- **Contraflow is the big lever for the road:** it halves the time Route 1 is jammed.
- **Extra staff fixes the slow lots:** Lots 42, 50A and 55 hold over 3,000 cars behind gates of 6
  to 8 cars a minute. On its own it pushes cars onto Route 1 sooner (the road jams longer), so it
  needs the lane.
- **Delayed lots spread out what is left:** fans in the chosen lots wait in the stadium for $50
  and free parking, then drive out in about 10 minutes. Today's Lot 55 fans wait 75 minutes and
  then sit about 69 minutes more, because Lot 55's gate is one of the slowest.
- **Together they work far better than any one alone:** the lane takes the flow, the staff empty
  the slow lots, the delayed lots keep the peak down. For the same card money as today (about
  $48,000 vs $37,500), the night goes from 78 to 53 minutes on average.

## How the lots open under the plan

The Results panel shows a bar per lot: when its cars leave and when it is empty, against the same
lot with nothing extra. Examples from the plan:

| Lot | Cars | Under the plan | Empty at | With nothing extra |
|---|---|---|---|---|
| Lot 42 | 1,337 | extra staff, gate 24 cars a minute | 103 min | 237 min |
| Lot 55 | 750 | extra staff | 103 min | 188 min |
| Lot 50A | 1,082 | extra staff | 103 min | 164 min |

The 8 delayed lots (963 cars, mostly small lots near the stadium) open at 75 minutes; their bars
start there in the panel.

## Maggie's merge rule, plainly

When the road outside a lot's gate is full and a gap opens, who takes it: the car already on
Route 1, or the car waiting at the gate? Our first model said Route 1 always goes first. Maggie's
change (the standard merge rule from traffic research, Daganzo 1995) lets them **take turns, like
a zipper**, in proportion to how much each side can carry. It is more realistic, and it changes
**which** lots wait: with Route 1 first, the lots nearest I-95 wait longest; with a full zipper,
the southern lots do. Around a setting of 0.25 they wait about the same, so that is our default.

How much a full merge is shared at Gillette is unknown until someone counts it, so it is a model
setting in the tool. **The plan's result holds under every setting:**

| Merge rule | Avg to highway: nothing, plan | Over an hour: nothing, plan | Last car: nothing, plan |
|---|---|---|---|
| Route 1 always first (0) | 77, **53** min | 5,785, **475** | 233, **132** min |
| Mostly Route 1 first (0.25, default) | 78, **53** min | 5,549, **391** | 242, **132** min |
| Full zipper (1) | 78, **54** min | 5,062, **815** | 282, **155** min |

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
- **Click a tower** to fly to it and see its numbers; it can switch a lot between delayed and
  normal.

## The 5-minute demo

| Time | What we show | What we say |
|---|---|---|
| 0:00 | Map at the whistle, 13,000 cars in white towers | "After a Patriots game, 13,000 cars leave through one road. The average fan needs 78 minutes to reach the highway; the last car, four hours." |
| 0:40 | Jump to 30 min, Nothing extra: red bars, red rings | "Two problems: the road is full, and some lots have slow gates." |
| 1:20 | Plan panel: the three options | "Gillette already has these levers: a contraflow lane, gate staff, and $50 delayed lots. The question is which, and what they buy." |
| 2:00 | Results table | "Each alone helps a little. Today's delayed lot barely moves anything. Together: 53 minutes instead of 78, 391 drivers over an hour instead of 5,549, the last car out in two hours instead of four." |
| 3:00 | Watch: switch Nothing extra / Plan at 45 min | "Same moment: fewer red rings, lower bars, the slow lots already emptying." |
| 3:40 | Lot schedule, click Lot 42 | "Lot 42: empty at 103 minutes instead of 237, with a crew at its gate." |
| 4:20 | Close | "One screen for the operator: spend the money where it keeps Route 1 moving, and see it before the game." |

## Assumptions (said out loud)

| Assumption | Value | Source or reason |
|---|---|---|
| Road capacity | 1,800 cars per lane per hour | Standard traffic engineering figure |
| Gate speeds | 6 to 24 cars a minute, fixed per lot | Our estimate; no counts yet |
| Extra staff | Brings a gate to 24 cars a minute | Estimate: two attendants or a second exit lane |
| Contraflow | One extra northbound lane | MassDOT practice for big events |
| Delayed lot | Whole lot, opens at 75 min, $50 a car | Gillette's 2025 parking page |
| Merge rule | 0.25 by default, 0 to 1 in the tool | Maggie's model; unknown for Gillette |
| Heading north | 60% | Estimate; I-95 north to Boston is the bigger flow |
| Cars | 14,000 minus about 1,200 per 5,000 train riders | Lot area estimate; Foxborough police for trains |
| When people leave | 55% within 15 min of the end, the rest over 90 min | Estimate |
| Lot names | OpenStreetMap; "Lot 55" stands in for Lots 45 and 55B | Some OSM lots may not be Gillette's |

Staff and police costs are not in dollars yet: we don't have the rates.

## Who did what

- **Vijay:** the exit planner (`src/plan.js`): options, choosing delayed lots, the numbers, the lot
  schedule; the operator screen.
- **Maggie:** the merge rule in the traffic model (`src/sim.js`).
- **Sid:** 3D v2 (the comparison option on the same clock, cars waiting at gates, map credits)
  and the events API (`api/events.js`) for saving games later.

## Next, after the demo

- Count real gate speeds and the merge at Gillette for one game; the tool then uses them
  (the memory part, built but switched off for the demo).
- Dollar costs for staff and the lane, so "what it takes" is one number.
- Deploy (Vercel), then delete the one-day Google key.
