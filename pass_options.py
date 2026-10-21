"""
Pass options engine: multi-criteria evaluation of every possible pass.

For each eligible receiver at a given frame we measure 4 geometric inputs:
  sep_arr   projected separation when the ball arrives (receiver and defenders
            extrapolated along their current velocity for the ball flight time)
  lane      how clear the throwing lane is (closest defender to the QB→catch
            point segment, excluding both ends)
  depth     air yards past the line of scrimmage
  pressure  distance of the closest defender to the QB

Those inputs are matched (Gaussian kernel) against ~7,000 real passes from the
122 games to estimate, for that throw:
  completion probability, interception probability,
  first-down probability, expected yards.

Each estimate becomes a 0-100 sub-score; the pass score is a weighted average
(weights adjustable in the UI). We also compute precision (CPOE: completion %
over expected, per play and per QB) and decision timing.
"""
import math
import os

import numpy as np
import pandas as pd

import nfl_analytics as nfl
from nfl_analytics import parse_target_from_description

CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pass_reference.json")
FPS = 10

# ball flight model: release overhead + average ball speed (yd/s)
RELEASE_S = 0.3
BALL_SPEED = 20.0

# kernel bandwidths (yards)
BW = {"sep_arr": 1.5, "lane": 1.5, "depth": 4.0, "pressure": 2.0}
PRESSURE_CAP = 8.0  # beyond 8 yds the QB is "clean", no extra information

# default weights of the pass score (sum = 100), also used by the UI
DEFAULT_WEIGHTS = {"completion": 35, "conversion": 25, "gain": 25, "safety": 15}
INT_ZERO = 0.08   # 8 % interception risk → safety score 0
GAIN_FULL = 15.0  # 15 expected yards → gain score 100

THROW_EVENTS = ("pass_forward", "autoevent_passforward", "pass_shovel")
SNAP_EVENTS = ("ball_snap", "autoevent_ballsnap")


def _abbrev_matches(abbrev, full_name):
    if not abbrev or "." not in abbrev or not full_name:
        return False
    fi, last = abbrev.split(".", 1)
    parts = full_name.split()
    return (len(parts) >= 2 and parts[0][:1].upper() == fi.strip().upper()
            and parts[-1].lower() == last.strip().lower().split()[-1])


def _velocity(s, dir_deg):
    # tracking convention (checked on the data): 0° = +y, 90° = +x
    r = np.radians(dir_deg)
    return s * np.sin(r), s * np.cos(r)


def _seg_dist(px, py, ax, ay, bx, by):
    """Distance from points (px,py) to segment AB, restricted to its 15-85 % part."""
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 < 1e-6:
        return np.hypot(px - ax, py - ay)
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0.15, 0.85)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy))


# ---------------------------------------------------------------------------
# Geometry of one frame
# ---------------------------------------------------------------------------

def frame_context(play_track, frame_id, roles, def_team):
    """Extract QB, receivers and defenders (raw coords) for a frame."""
    f = play_track[play_track["frameId"] == frame_id]
    qb, recs, defs = None, [], []
    for r in f.itertuples(index=False):
        if pd.isna(r.nflId):
            continue
        nid = int(r.nflId)
        role = roles.get(nid)
        vx, vy = _velocity(r.s, r.dir if pd.notna(r.dir) else 0.0)
        item = (nid, r.x, r.y, vx, vy)
        if role == "Pass":
            qb = item
        elif role == "Pass Route":
            recs.append(item)
        elif r.team == def_team:
            defs.append(item)
    return qb, recs, defs


def option_features(qb, rec, defs, los_x, sign):
    """The 4 model inputs + raw facts for a pass from qb to rec."""
    _, qx, qy, _, _ = qb
    _, rx, ry, rvx, rvy = rec
    d = np.array([[x, y, vx, vy] for _, x, y, vx, vy in defs]) if defs else np.zeros((0, 4))

    throw_dist = math.hypot(rx - qx, ry - qy)
    t_air = RELEASE_S + throw_dist / BALL_SPEED
    ax, ay = rx + rvx * t_air, ry + rvy * t_air  # catch point

    if len(d):
        sep_now = float(np.min(np.hypot(d[:, 0] - rx, d[:, 1] - ry)))
        dax, day = d[:, 0] + d[:, 2] * t_air, d[:, 1] + d[:, 3] * t_air
        sep_arr = float(np.min(np.hypot(dax - ax, day - ay)))
        lane = float(np.min(_seg_dist(d[:, 0], d[:, 1], qx, qy, ax, ay)))
        pressure = float(np.min(np.hypot(d[:, 0] - qx, d[:, 1] - qy)))
    else:
        sep_now = sep_arr = lane = pressure = 10.0

    return {
        "sep_now": round(sep_now, 2),
        "sep_arr": round(sep_arr, 2),
        "lane": round(min(lane, 10.0), 2),
        "depth": round(sign * (rx - los_x), 2),
        "pressure": round(min(pressure, PRESSURE_CAP), 2),
        "throw_dist": round(throw_dist, 2),
        "t_air": round(t_air, 2),
        "catch_x": round(ax, 2),
        "catch_y": round(ay, 2),
    }


def _play_setup(track, play_id, pff_g):
    tp = track[track["playId"] == play_id]
    if tp.empty:
        return None
    ev = tp.loc[tp["event"].notna(), ["frameId", "event"]].drop_duplicates()
    snap = ev[ev["event"].isin(SNAP_EVENTS)]["frameId"].min()
    if pd.isna(snap):
        return None
    after = ev[ev["frameId"] > snap]
    throw = None
    for e in THROW_EVENTS:  # manual tag first
        hit = after[after["event"] == e]["frameId"]
        if len(hit):
            throw = int(hit.min())
            break
    ball = tp[(tp["frameId"] == snap) & tp["nflId"].isna()]
    if ball.empty:
        return None
    los_x = float(ball["x"].iloc[0])
    sign = 1.0 if tp["playDirection"].iloc[0] == "right" else -1.0
    roles = {int(r.nflId): r.pff_role for r in pff_g[pff_g["playId"] == play_id].itertuples(index=False)
             if pd.notna(r.nflId)}
    return {"tp": tp, "snap": int(snap), "throw": throw, "los_x": los_x, "sign": sign,
            "roles": roles, "last": int(tp["frameId"].max())}


# ---------------------------------------------------------------------------
# Historical reference table
# ---------------------------------------------------------------------------

def build_reference(progress=True):
    games = nfl.load_games()
    plays = nfl.load_plays()
    pff = nfl.load_pff()
    name_by_id = dict(zip(nfl.load_players()["nflId"], nfl.load_players()["displayName"]))
    rows = []
    for gi, gid in enumerate(games["gameId"]):
        gp = plays[(plays["gameId"] == gid) & plays["passResult"].isin(["C", "I", "IN"])]
        track = nfl.load_tracking(gid)
        pff_g = pff[pff["gameId"] == gid]
        for pr in gp.itertuples(index=False):
            st = _play_setup(track, int(pr.playId), pff_g)
            if not st or st["throw"] is None:
                continue
            qb, recs, defs = frame_context(st["tp"], st["throw"], st["roles"], pr.defensiveTeam)
            abbrev = parse_target_from_description(str(pr.playDescription))
            tgt = next((r for r in recs if _abbrev_matches(abbrev, name_by_id.get(r[0], ""))), None)
            if qb is None or tgt is None:
                continue
            feat = option_features(qb, tgt, defs, st["los_x"], st["sign"])
            comp = int(pr.passResult == "C")
            yds = int(pr.playResult) if comp and pd.notna(pr.playResult) else 0
            rows.append({
                "gameId": int(gid), "playId": int(pr.playId), "passerId": qb[0],
                "coverage": str(pr.pff_passCoverageType), "yardsToGo": int(pr.yardsToGo),
                "completed": comp, "intercepted": int(pr.passResult == "IN"), "yards": yds,
                "time_to_throw": round((st["throw"] - st["snap"]) / FPS, 2),
                **{k: feat[k] for k in ("sep_arr", "lane", "depth", "pressure")},
            })
        nfl._tracking_cache.pop(gid, None)
        if progress:
            print(f"  [{gi + 1}/{len(games)}] {gid} → {len(rows)} passes", flush=True)
    df = pd.DataFrame(rows)
    df["xcomp"] = _loo_expected_completion(df)
    return df


def _weights(ref_arrays, q, coverage=None):
    w = np.ones(len(ref_arrays["sep_arr"]))
    for k, bw in BW.items():
        w *= np.exp(-((ref_arrays[k] - q[k]) ** 2) / (2 * bw * bw))
    if coverage is not None:
        w *= np.where(ref_arrays["coverage"] == coverage, 2.0, 1.0)
    return w


def _loo_expected_completion(df):
    """Leave-one-out expected completion for every historical pass (for CPOE)."""
    X = df[list(BW)].to_numpy(float)
    bws = np.array(list(BW.values()))
    comp = df["completed"].to_numpy(float)
    cov = df["coverage"].to_numpy()
    out = np.empty(len(df))
    for i0 in range(0, len(df), 500):
        blk = X[i0:i0 + 500]
        z = ((blk[:, None, :] - X[None, :, :]) / bws) ** 2
        w = np.exp(-0.5 * z.sum(axis=2))
        w *= np.where(cov[i0:i0 + 500, None] == cov[None, :], 2.0, 1.0)
        idx = np.arange(i0, i0 + len(blk))
        w[np.arange(len(blk)), idx] = 0.0  # leave the pass itself out
        out[i0:i0 + len(blk)] = (w * comp).sum(axis=1) / w.sum(axis=1)
    return np.round(out, 4)


_ref = None
_arrays = None


def get_reference():
    global _ref, _arrays
    if _ref is None:
        if os.path.exists(CACHE_PATH):
            _ref = pd.read_json(CACHE_PATH)
        else:
            print("Building pass reference table (first run, ~3 min)…", flush=True)
            _ref = build_reference()
            _ref.to_json(CACHE_PATH, orient="records")
        _arrays = {k: _ref[k].to_numpy(float) for k in BW}
        _arrays["coverage"] = _ref["coverage"].to_numpy()
        for k in ("completed", "intercepted", "yards"):
            _arrays[k] = _ref[k].to_numpy(float)
    return _ref, _arrays


# ---------------------------------------------------------------------------
# Estimating one option
# ---------------------------------------------------------------------------

def estimate(feat, coverage, yards_to_go):
    _, A = get_reference()
    w = _weights(A, feat, coverage)
    tw = w.sum()
    n_eff = tw * tw / (np.square(w).sum() + 1e-12)
    comp = float((w * A["completed"]).sum() / tw)
    intc = float((w * A["intercepted"]).sum() / tw)
    first = float((w * A["completed"] * (A["yards"] >= yards_to_go)).sum() / tw)
    cw = w * A["completed"]
    ypc = float((cw * A["yards"]).sum() / cw.sum()) if cw.sum() > 1e-9 else 0.0
    xyds = comp * ypc
    return {
        "completionProb": round(comp * 100, 1),
        "intProb": round(intc * 100, 1),
        "firstDownProb": round(first * 100, 1),
        "expectedYards": round(xyds, 1),
        "yardsIfCaught": round(ypc, 1),
        "nEff": int(round(n_eff)),
        "scores": {
            "completion": round(comp * 100, 1),
            "conversion": round(first * 100, 1),
            "gain": round(min(xyds / GAIN_FULL, 1) * 100, 1),
            "safety": round((1 - min(intc / INT_ZERO, 1)) * 100, 1),
        },
    }


def pass_score(scores, weights=DEFAULT_WEIGHTS):
    tot = sum(weights.values())
    return round(sum(scores[k] * w for k, w in weights.items()) / tot, 1)


def _evaluate_frame(st, frame_id, def_team, coverage, ytg):
    qb, recs, defs = frame_context(st["tp"], frame_id, st["roles"], def_team)
    if qb is None:
        return []
    out = []
    for rec in recs:
        feat = option_features(qb, rec, defs, st["los_x"], st["sign"])
        est = estimate(feat, coverage, ytg)
        out.append({"nflId": rec[0], "features": feat, **est,
                    "passScore": pass_score(est["scores"])})
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def play_options(game_id, play_id, frame_id=None):
    plays = nfl.load_plays()
    pr = plays[(plays["gameId"] == game_id) & (plays["playId"] == play_id)]
    if pr.empty:
        return None
    pr = pr.iloc[0]
    pff = nfl.load_pff()
    st = _play_setup(nfl.load_tracking(game_id), play_id, pff[pff["gameId"] == game_id])
    if not st:
        return None

    coverage = str(pr["pff_passCoverageType"])
    ytg = int(pr["yardsToGo"])
    names = dict(zip(nfl.load_players()["nflId"], nfl.load_players()["displayName"]))
    end = st["throw"] if st["throw"] is not None else min(st["snap"] + 30, st["last"])
    eval_frame = int(frame_id) if frame_id else end

    options = _evaluate_frame(st, eval_frame, pr["defensiveTeam"], coverage, ytg)
    for o in options:
        o["name"] = names.get(o["nflId"], f"#{o['nflId']}")

    abbrev = parse_target_from_description(str(pr["playDescription"]))
    target = next((o for o in options if _abbrev_matches(abbrev, o["name"])), None)
    target_id = target["nflId"] if target else None
    for o in options:
        o["isActualTarget"] = o["nflId"] == target_id

    # decision timeline: every option's sub-scores from snap to the throw
    timeline = []
    for fid in range(st["snap"], end + 1):
        opts = _evaluate_frame(st, fid, pr["defensiveTeam"], coverage, ytg)
        timeline.append({
            "frameId": fid,
            "t": round((fid - st["snap"]) / FPS, 1),
            "options": [{"nflId": o["nflId"], "scores": o["scores"]} for o in opts],
        })

    # precision on this play (only for the actual throw)
    precision = None
    if target and pr["passResult"] in ("C", "I", "IN") and st["throw"] is not None:
        tgt_at_throw = target if eval_frame == st["throw"] else next(
            (o for o in _evaluate_frame(st, st["throw"], pr["defensiveTeam"], coverage, ytg)
             if o["nflId"] == target_id), None)
        if tgt_at_throw:
            actual = 1.0 if pr["passResult"] == "C" else 0.0
            precision = {
                "result": str(pr["passResult"]),
                "expectedCompletion": tgt_at_throw["completionProb"],
                "cpoe": round((actual * 100) - tgt_at_throw["completionProb"], 1),
            }

    passer_id = next((nid for nid, role in st["roles"].items() if role == "Pass"), None)

    return {
        "passerId": passer_id,
        "passerName": names.get(passer_id, "") if passer_id else "",
        "evalFrame": eval_frame,
        "throwFrame": st["throw"],
        "snapFrame": st["snap"],
        "isThrowFrame": eval_frame == st["throw"],
        "timeToThrow": round((st["throw"] - st["snap"]) / FPS, 1) if st["throw"] else None,
        "coverage": coverage,
        "yardsToGo": ytg,
        "actualTargetId": target_id,
        "options": sorted(options, key=lambda o: o["passScore"], reverse=True),
        "timeline": timeline,
        "precision": precision,
        "defaultWeights": DEFAULT_WEIGHTS,
        "model": {"ballSpeed": BALL_SPEED, "releaseS": RELEASE_S, "intZero": INT_ZERO * 100,
                  "gainFull": GAIN_FULL, "nPasses": int(len(get_reference()[0]))},
    }


def qb_profile(passer_id):
    """Season precision (CPOE) and decision speed for a QB vs the league."""
    ref, _ = get_reference()
    if passer_id is None:
        return None
    me = ref[ref["passerId"] == passer_id]
    if me.empty:
        return None
    per_qb = ref.groupby("passerId").agg(n=("completed", "size"),
                                         cpoe=("completed", "mean"), x=("xcomp", "mean"),
                                         ttt=("time_to_throw", "median"))
    per_qb["cpoe"] = (per_qb["cpoe"] - per_qb["x"]) * 100
    qualified = per_qb[per_qb["n"] >= 50].sort_values("cpoe", ascending=False)
    rank = (list(qualified.index).index(passer_id) + 1) if passer_id in qualified.index else None
    me_comp, me_x = float(me["completed"].mean()), float(me["xcomp"].mean())
    return {
        "passerId": int(passer_id),
        "completionPct": round(me_comp * 100, 1),
        "expectedCompletionPct": round(me_x * 100, 1),
        "cpoe": round((me_comp - me_x) * 100, 1),
        "name": dict(zip(nfl.load_players()["nflId"], nfl.load_players()["displayName"])).get(passer_id, ""),
        "passes": int(len(me)),
        "medianTimeToThrow": round(float(me["time_to_throw"].median()), 2),
        "leagueMedianTimeToThrow": round(float(ref["time_to_throw"].median()), 2),
        "cpoeRank": rank,
        "qualifiedQbs": int(len(qualified)),
    }
