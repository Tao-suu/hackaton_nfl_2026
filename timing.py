"""
Bridge between compute_timing.py (the Timing Delta metric) and the web viewer.

Instead of depending on the 1.4 GB data_timing/ export, we call the exact same
compute_timing.process_game() on demand, one game at a time, and cache the
result in memory. Same metric, single source of truth.
"""
import math
from collections import OrderedDict

import pandas as pd

import compute_timing as ct
import nfl_analytics as nfl

_CACHE = OrderedDict()   # gameId -> (enriched tracking, per-play metrics)
_CACHE_MAX = 6

_PFF_COLS = ["gameId", "playId", "nflId", "pff_role", "pff_hit", "pff_hurry", "pff_sack"]


def _clean(v):
    """NaN/NumPy → JSON-friendly Python values."""
    if v is None:
        return None
    try:
        if isinstance(v, float) and math.isnan(v):
            return None
    except TypeError:
        pass
    if hasattr(v, "item"):
        v = v.item()
        if isinstance(v, float) and math.isnan(v):
            return None
    return v


def get_game_timing(game_id):
    if game_id in _CACHE:
        _CACHE.move_to_end(game_id)
        return _CACHE[game_id]
    plays = nfl.load_plays()
    pff = nfl.load_pff()[_PFF_COLS]
    trk = nfl.load_tracking(game_id)
    enriched, kf = ct.process_game(trk, plays[plays["gameId"] == game_id],
                                   pff[pff["gameId"] == game_id])
    kf = kf.set_index("playId")
    _CACHE[game_id] = (enriched, kf)
    if len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)
    return enriched, kf


def play_labels(game_id):
    """{playId: timing_label} for the play selector."""
    _, kf = get_game_timing(game_id)
    return kf["timing_label"].to_dict()


def play_timing(game_id, play_id):
    """Per-play metrics + per-frame state/open/pressure for the viewer."""
    enriched, kf = get_game_timing(game_id)
    if play_id not in kf.index:
        return None
    row = kf.loc[play_id]
    tp = enriched[enriched["playId"] == play_id]

    frames = {}
    for fid, g in tp.groupby("frameId"):
        frames[int(fid)] = {
            "state": str(g["timing_state"].iloc[0]),
            "t": _clean(g["t_since_snap_s"].iloc[0]),
            "openIds": [int(x) for x in g.loc[g["is_open"] == 1, "nflId"].dropna()],
            "pressureIds": [int(x) for x in g.loc[g["is_pressuring"] == 1, "nflId"].dropna()],
            "qbMinDist": _clean(g["qb_min_def_dist_yd"].iloc[0]),
        }

    snap = row.get("snap_frame")

    def to_frame(t):
        t = _clean(t)
        if t is None or _clean(snap) is None:
            return None
        return int(round(snap + t * ct.FPS))

    return {
        "label": str(row["timing_label"]),
        "tOpen": _clean(row["t_open_s"]),
        "tPressure": _clean(row["t_pressure_s"]),
        "tEnd": _clean(row["t_end_s"]),
        "delta": _clean(row["timing_delta_s"]),
        "holdAfterOpen": _clean(row["qb_hold_after_open_s"]),
        "firstOpenId": _clean(row["first_open_nflId"]),
        "endEvent": str(row["end_event"]),
        "snapFrame": _clean(snap),
        "openFrame": to_frame(row["t_open_s"]),
        "pressureFrame": to_frame(row["t_pressure_s"]),
        "endFrame": to_frame(row["t_end_s"]),
        "frames": frames,
        "params": {
            "openSepYd": ct.OPEN_SEP_YD,
            "openMinDepthYd": ct.OPEN_MIN_DEPTH_YD,
            "pressureDistYd": ct.PRESSURE_DIST_YD,
        },
    }
