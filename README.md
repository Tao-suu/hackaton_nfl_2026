# 🏈 NFL Pass Analyzer

An interactive viewer for the passing game, built on the NFL Big Data Bowl tracking
data (2021, weeks 1-8, 122 games, `data_nfl/`). It replays each dropback frame by
frame and answers three questions: **what were the options**, **was the throw
precise**, and **was the decision on time**.

## What it shows

- **Pass Options (multi-criteria)**: every eligible receiver is scored on 4 criteria,
  each estimated from ~7,100 real passes in similar situations:
  - **Completion**: probability the pass is caught
  - **1st down**: probability of a catch that moves the chains
  - **Yards**: expected yards (15+ yds = 100)
  - **Safety**: low interception risk (8 %+ = 0)

  The pass score is a weighted average (weights adjustable with sliders). The panel
  shows the ranking, the 4 sub-scores of each receiver, the gap with the actual
  throw, and which criteria explain it. "Evaluate at this frame" scores the options
  at any moment, not just at the throw.
- **Precision (CPOE)**: completion percentage over expected, for the play and for
  the QB's season, with his rank among QBs with 50+ passes.
- **Decision timing**: chart of the best option score vs the chosen receiver from
  snap to throw. Shows time to throw, the best window, the decision lag (throw minus
  best window), and the hold after the first receiver got open.
- **Timing Delta** (`compute_timing.py`): receiver clock vs pocket clock, with a live
  banner, green halos on open receivers and red halos on pressuring defenders.
- **Viewer**: zoom/pan without markers stacking, a chess.com-style navigator
  (Snap, Open, Pressure, Best window, Throw…), click a receiver to inspect it.

## The pass options model (`pass_options.py`)

For each receiver at a given frame we compute 4 geometric inputs:

| Input | Meaning |
|---|---|
| separation at catch | receiver and defenders extrapolated along their velocity for the ball flight time (0.3 s + distance / 20 yd/s) |
| throwing lane | closest defender to the QB → catch point segment |
| depth | air yards past the line of scrimmage |
| pressure | closest defender to the QB |

Each historical pass is weighted by its similarity (Gaussian kernel on the 4 inputs,
same coverage type ×2). The weighted outcomes give completion, interception,
1st-down probability and expected yards.

Validation (leave-one-out on the 7,092 passes): AUC **0.736** for completion vs
**0.684** with separation alone. Calibration by bin: predicted 39/53/67/83 %,
observed 29/48/71/85 %. These are associations on observed plays, not causal
effects. The ball-flight model is a simple approximation.

## Data

The dataset is not in this repo (≈1 GB). Clone it into `data_nfl/` with `make data_install`, or by hand:

```bash
git clone https://github.com/ThompsonJamesBliss/nfl-big-data-bowl-regional-event-data.git data_nfl
```

The app expects `data_nfl/data/{games,plays,players,pffScoutingData}.csv` and
`data_nfl/data/tracking/tracking_<gameId>.csv`.

## Run it

```bash
pip3 install -r requirements.txt
make all                # clone the data, build it, launch the app
```

| Rule | What it does |
|---|---|
| `make data_install` | clones the dataset into `data_nfl/` (skipped if already there) |
| `make data_build` | links `data -> data_nfl/data`, then runs `compute_timing.py` (→ `data_timing_tmp/`), `explore_gravity.py`, `build_dataset.py` (→ `data_enriched/`) |
| `make launch` | starts the app on http://localhost:5000 |
| `make all` | `data_install` + `data_build` + `launch` |

Use another interpreter with `make launch PYTHON=python3.12`.

First run builds `pass_reference.json` (~2.5 min, all 122 games), then it is cached.
Delete the file to rebuild.

Timing Delta export for analysis (1.4 GB, git-ignored, ~5 min):

```bash
python3 compute_timing.py --data data_nfl/data --out data_timing
```

## Project structure

```
app.py               Flask server + JSON API
nfl_analytics.py     data loading, per-frame play data, target detection
pass_options.py      multi-criteria pass model, CPOE, decision timeline
compute_timing.py    Timing Delta metric (batch export)
timing.py            Timing Delta for the viewer (same process_game, on demand)
templates/, static/  UI (canvas field, panels)
```

## API

| Endpoint | Description |
|---|---|
| `GET /api/games` | games |
| `GET /api/plays/<gameId>` | plays of a game |
| `GET /api/play/<gameId>/<playId>` | frames, players, receiver separation |
| `GET /api/options/<gameId>/<playId>[?frame=N]` | multi-criteria options, precision, decision timeline |
| `GET /api/qb/<nflId>` | season CPOE and time to throw of a QB |
| `GET /api/timing/<gameId>/<playId>` | Timing Delta per frame |
| `GET /api/timing-labels/<gameId>` | Timing Delta verdict per play |
