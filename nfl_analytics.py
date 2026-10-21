"""
NFL Analytics module: loads Big Data Bowl data and computes per-frame
receiver openness scores plus a "should-have-thrown" verdict.
"""
import math
import os
from functools import lru_cache

import pandas as pd

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data_nfl", "data")
TRACKING_DIR = os.path.join(DATA_DIR, "tracking")


# ---------------------------------------------------------------------------
# Data loading (cached so we only read each CSV once)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def load_games():
    df = pd.read_csv(os.path.join(DATA_DIR, "games.csv"))
    return df


@lru_cache(maxsize=1)
def load_plays():
    df = pd.read_csv(os.path.join(DATA_DIR, "plays.csv"))
    return df


@lru_cache(maxsize=1)
def load_players():
    df = pd.read_csv(os.path.join(DATA_DIR, "players.csv"))
    return df


@lru_cache(maxsize=1)
def load_pff():
    df = pd.read_csv(os.path.join(DATA_DIR, "pffScoutingData.csv"))
    return df


_tracking_cache = {}


def load_tracking(game_id):
    """Load (and cache) the tracking CSV for a single game."""
    if game_id not in _tracking_cache:
        path = os.path.join(TRACKING_DIR, f"tracking_{game_id}.csv")
        _tracking_cache[game_id] = pd.read_csv(path)
    return _tracking_cache[game_id]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PASS_EVENTS = {
    "pass_forward",
    "pass_arrived",
    "pass_outcome_caught",
    "pass_outcome_incomplete",
    "pass_outcome_interception",
    "pass_outcome_touchdown",
}

COVERED_RESULTS = {"C", "I", "IN"}  # complete, incomplete, interception


def euclid(x1, y1, x2, y2):
    return math.hypot(x2 - x1, y2 - y1)


import re

_TARGET_RE = re.compile(
    r"(?:to|for|intended for)\s+([A-Z]\.[A-Z][a-zA-Z'\-]+)"
)


def parse_target_from_description(desc):
    """Extract the targeted receiver abbreviation (e.g. 'A.Cooper') from the
    NFL play description. Returns the abbreviated name or None."""
    if not desc:
        return None
    # the first "to <X.Name>" after "pass" is the intended receiver
    # e.g. "T.Brady pass incomplete deep right to C.Godwin."
    matches = _TARGET_RE.findall(desc)
    if matches:
        return matches[0]
    return None


def match_abbrev_to_player(abbrev, candidate_players):
    """Match an abbreviated name like 'A.Cooper' to a full displayName among
    candidates [{nflId, name}]. Returns nflId or None."""
    if not abbrev or "." not in abbrev:
        return None
    first_initial, last = abbrev.split(".", 1)
    first_initial = first_initial.strip().upper()
    last = last.strip().lower()
    for p in candidate_players:
        name = p["name"]
        parts = name.split()
        if len(parts) < 2:
            continue
        p_first = parts[0]
        p_last = " ".join(parts[1:]).lower()
        # match on last name (handles 'CeeDee Lamb' / 'A.Cooper')
        if p_first[:1].upper() == first_initial and (
            p_last == last or p_last.replace(" ", "") == last.replace(" ", "")
            or p_last.split()[-1] == last.split()[-1]
        ):
            return p["nflId"]
    return None


# ---------------------------------------------------------------------------
# Game / play listing
# ---------------------------------------------------------------------------

def get_games():
    """Return a list of games with a human-friendly label."""
    games = load_games()
    result = []
    for _, r in games.iterrows():
        result.append({
            "gameId": int(r["gameId"]),
            "label": f"W{int(r['week'])}  {r['homeTeamAbbr']} vs {r['visitorTeamAbbr']}",
            "week": int(r["week"]),
            "home": r["homeTeamAbbr"],
            "visitor": r["visitorTeamAbbr"],
        })
    return result


def get_plays(game_id):
    """Return all plays for a game, flagging which are analysable passes."""
    plays = load_plays()
    plays = plays[plays["gameId"] == game_id]

    pff = load_pff()
    # count receivers per play so we can flag analysable plays
    receiver_counts = (
        pff[pff["gameId"] == game_id]
        .groupby("playId")["pff_role"]
        .apply(lambda s: (s == "Pass Route").sum())
        .to_dict()
    )

    result = []
    for _, r in plays.iterrows():
        pr = str(r.get("passResult", ""))
        result.append({
            "playId": int(r["playId"]),
            "description": str(r["playDescription"])[:90],
            "down": int(r["down"]) if pd.notna(r["down"]) else None,
            "yardsToGo": int(r["yardsToGo"]) if pd.notna(r["yardsToGo"]) else None,
            "passResult": pr,
            "playResult": int(r["playResult"]) if pd.notna(r["playResult"]) else 0,
            "numReceivers": receiver_counts.get(int(r["playId"]), 0),
            "isPass": pr in COVERED_RESULTS,
        })
    return result


# ---------------------------------------------------------------------------
# Core analysis for a single play
# ---------------------------------------------------------------------------

def analyze_play(game_id, play_id):
    """Build the full frame-by-frame data + openness + verdict for one play."""
    plays = load_plays()
    play_row = plays[(plays["gameId"] == game_id) & (plays["playId"] == play_id)]
    if play_row.empty:
        return None
    play_row = play_row.iloc[0]

    games = load_games()
    game_row = games[games["gameId"] == game_id].iloc[0]

    players_df = load_players()
    pff_df = load_pff()
    pff_play = pff_df[(pff_df["gameId"] == game_id) & (pff_df["playId"] == play_id)]

    tracking = load_tracking(game_id)
    track_play = tracking[tracking["playId"] == play_id].copy()

    if track_play.empty:
        return None

    # --- play direction normalisation (make offense always go left→right) ---
    play_dir = track_play["playDirection"].iloc[0]
    flip = play_dir == "left"

    def fx(x):
        return 120 - x if flip else x

    def fy(y):
        return 53.3 - y if flip else y

    # --- merge PFF roles onto tracking rows ---
    role_map = {}  # nflId -> (role, positionLinedUp)
    for _, p in pff_play.iterrows():
        nid = p["nflId"]
        if pd.notna(nid):
            role_map[int(nid)] = (p["pff_role"], p.get("pff_positionLinedUp", ""))

    # --- player lookup ---
    player_info = {}
    for _, p in players_df.iterrows():
        player_info[int(p["nflId"])] = {
            "name": p["displayName"],
            "position": p["officialPosition"],
        }

    possession_team = play_row["possessionTeam"]
    defensive_team = play_row["defensiveTeam"]

    # --- group frames ---
    frame_ids = sorted(track_play["frameId"].unique())
    frames_out = []

    # pre-index receivers & coverage defenders per frame for distance calc
    for fid in frame_ids:
        frame_data = track_play[track_play["frameId"] == fid]

        ball_row = frame_data[frame_data["nflId"].isna()]
        ball = None
        if not ball_row.empty:
            b = ball_row.iloc[0]
            ball = {"x": fx(b["x"]), "y": fy(b["y"]), "s": b.get("s", 0)}

        players_out = []
        receivers = []
        coverage_defenders = []

        for _, r in frame_data.iterrows():
            nid = r["nflId"]
            is_ball = pd.isna(nid)
            if is_ball:
                continue
            nid = int(nid)

            role, pos_lined = role_map.get(nid, ("", ""))
            info = player_info.get(nid, {"name": f"#{int(r['jerseyNumber'])}", "position": ""})

            pdat = {
                "nflId": nid,
                "name": info["name"],
                "position": info["position"],
                "team": r["team"],
                "jersey": int(r["jerseyNumber"]) if pd.notna(r["jerseyNumber"]) else 0,
                "x": fx(r["x"]),
                "y": fy(r["y"]),
                "s": round(float(r["s"]), 2),
                "a": round(float(r["a"]), 2),
                "o": round(float(r["o"]), 1) if pd.notna(r["o"]) else None,
                "dir": round(float(r["dir"]), 1) if pd.notna(r["dir"]) else None,
                "role": role,
                "positionLinedUp": str(pos_lined),
                "isOffense": r["team"] == possession_team,
                "isDefense": r["team"] == defensive_team,
            }
            players_out.append(pdat)

            if role == "Pass Route":
                receivers.append(pdat)
            elif role == "Coverage":
                coverage_defenders.append(pdat)

        # compute openness for each receiver
        receivers_out = []
        for rec in receivers:
            best_dist = 999
            best_def = None
            for d in coverage_defenders:
                dist = euclid(rec["x"], rec["y"], d["x"], d["y"])
                if dist < best_dist:
                    best_dist = dist
                    best_def = d
            receivers_out.append({
                "nflId": rec["nflId"],
                "name": rec["name"],
                "jersey": rec["jersey"],
                "x": rec["x"],
                "y": rec["y"],
                "team": rec["team"],
                "openness": round(best_dist, 2),
                "nearestDefenderId": best_def["nflId"] if best_def else None,
                "nearestDefenderName": best_def["name"] if best_def else None,
                "nearestDefenderX": best_def["x"] if best_def else None,
                "nearestDefenderY": best_def["y"] if best_def else None,
            })
        receivers_out.sort(key=lambda x: x["openness"], reverse=True)

        event = frame_data["event"].dropna().unique()
        event_str = event[0] if len(event) > 0 else None

        frames_out.append({
            "frameId": int(fid),
            "event": event_str,
            "ball": ball,
            "players": players_out,
            "receivers": receivers_out,
        })

    # --- analysis: pass forward frame + target detection ---
    analysis = _compute_verdict(frames_out, play_row, possession_team)

    # --- play info ---
    play_info = {
        "gameId": int(game_id),
        "playId": int(play_id),
        "description": str(play_row["playDescription"]),
        "quarter": int(play_row["quarter"]) if pd.notna(play_row["quarter"]) else None,
        "down": int(play_row["down"]) if pd.notna(play_row["down"]) else None,
        "yardsToGo": int(play_row["yardsToGo"]) if pd.notna(play_row["yardsToGo"]) else None,
        "possessionTeam": possession_team,
        "defensiveTeam": defensive_team,
        "yardlineNumber": int(play_row["yardlineNumber"]) if pd.notna(play_row["yardlineNumber"]) else None,
        "passResult": str(play_row.get("passResult", "")),
        "playResult": int(play_row["playResult"]) if pd.notna(play_row["playResult"]) else 0,
        "offenseFormation": str(play_row.get("offenseFormation", "")),
        "defendersInBox": int(play_row["defendersInBox"]) if pd.notna(play_row.get("defendersInBox")) else None,
        "pff_passCoverage": str(play_row.get("pff_passCoverage", "")),
        "pff_passCoverageType": str(play_row.get("pff_passCoverageType", "")),
        "pff_playAction": bool(play_row.get("pff_playAction", 0)) if pd.notna(play_row.get("pff_playAction")) else False,
        "week": int(game_row["week"]),
        "homeTeamAbbr": game_row["homeTeamAbbr"],
        "visitorTeamAbbr": game_row["visitorTeamAbbr"],
        "playDirection": play_dir,
    }

    return {
        "playInfo": play_info,
        "frames": frames_out,
        "analysis": analysis,
    }


def _compute_verdict(frames, play_row, possession_team):
    """Determine when the ball was thrown, who it went to, and who was openest."""
    # find pass_forward frame — prefer the manually-tagged event, but fall
    # back to the auto-detected 'autoevent_passforward' used on many plays.
    pf_frame = None
    for f in frames:
        if f["event"] == "pass_forward":
            pf_frame = f
            break
    if pf_frame is None:
        for f in frames:
            ev = str(f["event"] or "")
            if "passforward" in ev.replace("_", "") or "pass_forward" in ev:
                pf_frame = f
                break

    # find pass_arrived / outcome frame
    arrived_frame = None
    for f in frames:
        ev = str(f["event"] or "")
        if any(k in ev for k in ("pass_arrived", "pass_outcome_caught",
                                 "pass_outcome_incomplete",
                                 "pass_outcome_interception",
                                 "passinterrupted", "pass_interrupted")):
            arrived_frame = f
            break

    if pf_frame is None:
        return {
            "hasPass": False,
            "message": "No pass thrown on this play (sack or scramble).",
        }

    snap_frame_idx = next(
        (i for i, f in enumerate(frames)
         if f["event"] and "ball_snap" in str(f["event"])), 0
    )
    pf_idx = frames.index(pf_frame)
    time_to_throw = round((pf_idx - snap_frame_idx) * 0.1, 2)

    # openness at throw time
    pf_receivers = pf_frame["receivers"]
    if not pf_receivers:
        return {
            "hasPass": True,
            "passForwardFrame": pf_frame["frameId"],
            "timeToThrow": time_to_throw,
            "message": "No receivers tracked on this play.",
        }

    most_open = pf_receivers[0]  # already sorted by openness desc

    # detect target receiver.
    # PRIMARY: parse the targeted receiver name from the play description,
    #   which the NFL records explicitly ("...pass ... to C.Godwin").
    # FALLBACK: nearest receiver to the ball's landing / last tracked position.
    target = None

    desc = str(play_row.get("playDescription", ""))
    abbrev = parse_target_from_description(desc)
    if abbrev:
        target_id = match_abbrev_to_player(abbrev, pf_receivers)
        if target_id is not None:
            target = next((r for r in pf_receivers if r["nflId"] == target_id), None)

    if target is None:
        # choose the reference frame for ball landing position:
        #   1. an explicit arrived / outcome frame if present
        #   2. otherwise the last frame of the play (ball tracking truncated)
        ref_frame = arrived_frame
        if ref_frame is None or ref_frame.get("ball") is None:
            for f in reversed(frames):
                if f.get("ball"):
                    ref_frame = f
                    break

        if ref_frame and ref_frame.get("ball"):
            bx, by = ref_frame["ball"]["x"], ref_frame["ball"]["y"]
            ar_receivers = ref_frame["receivers"]
            if ar_receivers:
                target = min(ar_receivers, key=lambda r: euclid(r["x"], r["y"], bx, by))
            else:
                off_players = [p for p in ref_frame["players"]
                               if p["isOffense"] and p["role"] != "Pass"]
                if off_players:
                    target = min(off_players, key=lambda p: euclid(p["x"], p["y"], bx, by))

    # openness of the target at the throw frame
    target_openness_at_throw = None
    if target:
        match = next((r for r in pf_receivers if r["nflId"] == target["nflId"]), None)
        if match:
            target_openness_at_throw = match["openness"]

    # build verdict
    verdict_parts = {
        "hasPass": True,
        "passForwardFrame": pf_frame["frameId"],
        "timeToThrow": time_to_throw,
        "mostOpen": {
            "nflId": most_open["nflId"],
            "name": most_open["name"],
            "openness": most_open["openness"],
        },
    }

    if target:
        verdict_parts["target"] = {
            "nflId": target["nflId"],
            "name": target["name"],
            "opennessAtThrow": target_openness_at_throw,
        }
        sep_diff = round(most_open["openness"] - (target_openness_at_throw or 0), 2)

        if target["nflId"] == most_open["nflId"]:
            verdict_parts["message"] = (
                f"Good decision — {target['name']} was the most open receiver "
                f"({most_open['openness']} yds separation) and got the ball."
            )
            verdict_parts["rating"] = "good"
        elif sep_diff > 2:
            verdict_parts["message"] = (
                f"Questionable read: QB threw to {target['name']} "
                f"({target_openness_at_throw} yds) but {most_open['name']} "
                f"was wide open ({most_open['openness']} yds) — "
                f"{sep_diff} yds more separation."
            )
            verdict_parts["rating"] = "questionable"
            verdict_parts["separationDifference"] = sep_diff
        else:
            verdict_parts["message"] = (
                f"Reasonable decision. Target {target['name']} "
                f"({target_openness_at_throw} yds) vs most open "
                f"{most_open['name']} ({most_open['openness']} yds)."
            )
            verdict_parts["rating"] = "ok"
            verdict_parts["separationDifference"] = sep_diff
    else:
        verdict_parts["message"] = "Could not determine the target receiver."

    return verdict_parts
