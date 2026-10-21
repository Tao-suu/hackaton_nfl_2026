#!/usr/bin/env python3
"""
Horloge receveur vs horloge pocket (« Timing Delta »)
=====================================================
Pour chaque action (dropback), en secondes après le snap :
  t_open     : 1er instant où un coureur de route est « ouvert » :
               séparation >= OPEN_SEP_YD avec le défenseur le plus proche,
               au moins OPEN_MIN_DEPTH_YD au-delà de la ligne de mêlée,
               tenu pendant OPEN_SUSTAIN_FRAMES frames consécutives.
  t_pressure : 1er instant où un défenseur, déjà entré dans le backfield
               offensif (>= 1 yard derrière la LOS), est à <= PRESSURE_DIST_YD du QB.
  timing_delta_s = t_pressure - t_open   (> 0 : l'attaque est dans les temps)

On ne cherche t_open / t_pressure qu'entre le snap et la fin du « temps de poche »
(lancer, sack, scramble, fumble), car après, la question ne se pose plus.

Sorties (copies enrichies, les CSV d'origine ne sont pas modifiés) :
  <out>/plays_timing.csv               : plays.csv + métrique par action
  <out>/tracking/tracking_<gameId>.csv : tracking + colonnes par frame (visualiseur)
  <out>/summary.txt                    : contrôles et distributions

Usage : python compute_timing.py [--data data] [--out data_timing] [--limit N]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

# --- Paramètres de la métrique (à faire varier pour tester la robustesse) ---
OPEN_SEP_YD = 3.0             # distance mini au défenseur le plus proche
OPEN_MIN_DEPTH_YD = 5.0       # profondeur mini d une vraie route (exclut screens, flats)
OPEN_SUSTAIN_FRAMES = 3       # 0,3 s : une fenêtre doit durer pour être exploitable
PRESSURE_DIST_YD = 2.0        # défenseur à portée de bras du QB
PRESSURE_MAX_DEPTH_YD = -1.0  # ... et au moins 1 yard dans le backfield offensif
FPS = 10                      # 10 frames par seconde

SNAP_MANUAL, SNAP_AUTO = {"ball_snap"}, {"autoevent_ballsnap"}
END_MANUAL = {"pass_forward", "pass_shovel", "qb_sack", "qb_strip_sack", "run", "fumble"}
END_AUTO = {"autoevent_passforward", "autoevent_passinterrupted"}

KEY = ["playId", "frameId"]


def first_event(ev: pd.DataFrame, names: set[str]) -> pd.DataFrame:
    """Première frame (et nom de l'événement) par playId parmi `names`."""
    hit = ev[ev["event"].isin(names)].sort_values("frameId")
    return hit.drop_duplicates("playId").set_index("playId")[["frameId", "event"]]


def key_frames(trk: pd.DataFrame) -> pd.DataFrame:
    """snap_frame, end_frame, end_event par action. Manuel prioritaire sur autoevent."""
    ev = trk.loc[trk["event"].notna(), ["playId", "frameId", "event"]].drop_duplicates()
    plays = pd.Index(sorted(trk["playId"].unique()), name="playId")
    kf = pd.DataFrame(index=plays)

    snap = first_event(ev, SNAP_MANUAL).combine_first(first_event(ev, SNAP_AUTO))
    kf["snap_frame"] = snap["frameId"].reindex(plays)

    # Fin du temps de poche : premier événement de fin strictement après le snap
    ev = ev.join(kf["snap_frame"], on="playId")
    ev = ev[ev["frameId"] > ev["snap_frame"]]
    end = first_event(ev, END_MANUAL).combine_first(first_event(ev, END_AUTO)).reindex(plays)
    last = trk.groupby("playId")["frameId"].max()
    kf["end_frame"] = end["frameId"].fillna(last)
    kf["end_event"] = end["event"].fillna("fin_tracking")
    return kf


def process_game(trk: pd.DataFrame, plays_g: pd.DataFrame, pff_g: pd.DataFrame):
    """Retourne (tracking enrichi, métriques par action) pour un match."""
    trk = trk.copy()
    trk["_row"] = np.arange(len(trk))  # pour restituer l'ordre d'origine
    trk = trk.merge(pff_g[["playId", "nflId", "pff_role"]], on=["playId", "nflId"], how="left")
    trk = trk.merge(plays_g[["playId", "defensiveTeam"]], on="playId", how="left")

    kf = key_frames(trk)
    trk = trk.join(kf[["snap_frame", "end_frame"]], on="playId")
    trk["t_since_snap_s"] = ((trk["frameId"] - trk["snap_frame"]) / FPS).round(1)

    # Ligne de mêlée = x du ballon au snap. Profondeur > 0 = côté défense.
    ball = trk[(trk["team"] == "football") & (trk["frameId"] == trk["snap_frame"])]
    los = ball.groupby("playId")["x"].first()
    kf["los_x"] = los.reindex(kf.index)
    sign = np.where(trk["playDirection"] == "right", 1.0, -1.0)
    trk["depth_yd"] = sign * (trk["x"] - trk["playId"].map(los))

    is_def = trk["team"] == trk["defensiveTeam"]

    # Séparation : distance de chaque coureur de route au défenseur le plus proche
    rec = trk.loc[trk["pff_role"] == "Pass Route", KEY + ["nflId", "x", "y"]]
    dfd = trk.loc[is_def, KEY + ["x", "y"]]
    pair = rec.merge(dfd, on=KEY, suffixes=("", "_d"))
    pair["d"] = np.hypot(pair["x"] - pair["x_d"], pair["y"] - pair["y_d"])
    sep = pair.groupby(KEY + ["nflId"])["d"].min().rename("sep_nearest_def_yd")
    trk = trk.join(sep, on=KEY + ["nflId"])

    # Distance de chaque défenseur au QB (pff_role == "Pass", 1 par action)
    qb = trk.loc[trk["pff_role"] == "Pass", KEY + ["x", "y"]]
    dq = trk.loc[is_def, KEY + ["nflId", "x", "y"]].merge(qb, on=KEY, suffixes=("", "_qb"))
    dq["dist_to_qb_yd"] = np.hypot(dq["x"] - dq["x_qb"], dq["y"] - dq["y_qb"])
    trk = trk.join(dq.set_index(KEY + ["nflId"])["dist_to_qb_yd"], on=KEY + ["nflId"])

    # Indicateurs instantanés
    in_window = (trk["frameId"] >= trk["snap_frame"]) & (trk["frameId"] <= trk["end_frame"])
    trk["is_open"] = (trk["sep_nearest_def_yd"] >= OPEN_SEP_YD) & (trk["depth_yd"] >= OPEN_MIN_DEPTH_YD)
    trk["is_pressuring"] = (trk["dist_to_qb_yd"] <= PRESSURE_DIST_YD) & (
        trk["depth_yd"] <= PRESSURE_MAX_DEPTH_YD)

    # Ouverture « tenue » : ouvert sur cette frame ET les (N-1) suivantes
    trk = trk.sort_values(["playId", "nflId", "frameId"])
    g = trk.groupby(["playId", "nflId"], dropna=False)["is_open"]
    sustained = trk["is_open"].copy()
    for k in range(1, OPEN_SUSTAIN_FRAMES):
        sustained &= g.shift(-k, fill_value=False).astype(bool)

    starts = trk.loc[sustained & in_window, ["playId", "frameId", "nflId"]].sort_values("frameId")
    first_open = starts.drop_duplicates("playId").set_index("playId")
    kf["open_frame"] = first_open["frameId"].reindex(kf.index)
    kf["first_open_nflId"] = first_open["nflId"].reindex(kf.index)
    kf["pressure_frame"] = (trk[trk["is_pressuring"] & in_window]
                            .groupby("playId")["frameId"].min().reindex(kf.index))

    # Métriques par action
    s = kf["snap_frame"]
    kf["t_end_s"] = (kf["end_frame"] - s) / FPS
    kf["t_open_s"] = (kf["open_frame"] - s) / FPS
    kf["t_pressure_s"] = (kf["pressure_frame"] - s) / FPS
    kf["timing_delta_s"] = kf["t_pressure_s"] - kf["t_open_s"]
    kf["qb_hold_after_open_s"] = kf["t_end_s"] - kf["t_open_s"]

    has_o, has_p = kf["open_frame"].notna(), kf["pressure_frame"].notna()
    open_first = has_o & (~has_p | (kf["open_frame"] < kf["pressure_frame"]))
    kf["timing_label"] = np.select(
        [s.isna() | kf["los_x"].isna(),
         open_first & has_p & (kf["pressure_frame"] < kf["end_frame"]),
         open_first,
         has_p,
         ],
        ["non_calculable", "fenetre_manquee", "dans_les_temps", "receveurs_en_retard"],
        default="couverture_gagnante",
    )

    # Colonnes par frame pour le visualiseur
    fr = trk.groupby(KEY).agg(n_open=("is_open", "sum"),
                              qb_min_def_dist_yd=("dist_to_qb_yd", "min"),
                              frame_pressure=("is_pressuring", "any"))
    trk = trk.join(fr, on=KEY)
    o = trk["playId"].map(kf["open_frame"])
    p = trk["playId"].map(kf["pressure_frame"])
    f = trk["frameId"]
    trk["timing_state"] = np.select(
        [trk["snap_frame"].isna(),
         f < trk["snap_frame"],
         f > trk["end_frame"],
         p.notna() & (f >= p) & o.notna() & (o < p),
         p.notna() & (f >= p),
         o.notna() & (f >= o)],
        ["non_calculable", "avant_snap", "apres_fin", "pression_apres_ouverture",
         "pression_avant_ouverture", "receveur_ouvert"],
        default="en_developpement",
    )
    trk["timing_label"] = trk["playId"].map(kf["timing_label"])
    trk["timing_delta_s"] = trk["playId"].map(kf["timing_delta_s"])

    for c in ["is_open", "is_pressuring", "frame_pressure"]:
        trk[c] = trk[c].astype(int)
    for c in ["depth_yd", "sep_nearest_def_yd", "dist_to_qb_yd", "qb_min_def_dist_yd"]:
        trk[c] = trk[c].round(2)
    trk = trk.sort_values("_row").drop(columns=["_row", "defensiveTeam", "snap_frame", "end_frame"])

    kf = kf.drop(columns=["open_frame", "pressure_frame"]).reset_index()
    return trk, kf


def write_summary(df: pd.DataFrame, pff: pd.DataFrame, path: Path) -> str:
    """Contrôles de cohérence et distributions, écrits dans summary.txt."""
    pr = (pff.assign(p=pff[["pff_hit", "pff_hurry", "pff_sack"]].fillna(0).sum(axis=1) > 0)
          .groupby(["gameId", "playId"])["p"].any().rename("pff_pressure"))
    d = df.join(pr, on=["gameId", "playId"])
    ok = d[d["timing_label"] != "non_calculable"]
    lines = [
        f"Parametres: OPEN_SEP_YD={OPEN_SEP_YD} OPEN_MIN_DEPTH_YD={OPEN_MIN_DEPTH_YD} "
        f"OPEN_SUSTAIN_FRAMES={OPEN_SUSTAIN_FRAMES} PRESSURE_DIST_YD={PRESSURE_DIST_YD} "
        f"PRESSURE_MAX_DEPTH_YD={PRESSURE_MAX_DEPTH_YD}",
        f"Actions traitees: {len(d)}  calculables: {len(ok)}",
        "\n== Repartition des labels (%) ==",
        (d["timing_label"].value_counts(normalize=True) * 100).round(1).to_string(),
        "\n== Label x passResult (% par ligne) ==",
        (pd.crosstab(ok["timing_label"], ok["passResult"], normalize="index") * 100).round(1).to_string(),
        "\n== Label x couverture (% par colonne) ==",
        (pd.crosstab(ok["timing_label"], ok["pff_passCoverageType"], normalize="columns") * 100)
        .round(1).to_string(),
        "\n== Medianes (s apres snap) ==",
        ok[["t_open_s", "t_pressure_s", "t_end_s", "timing_delta_s"]].median().round(2).to_string(),
        "\n== Controle: pression tracking vs pression PFF (hit/hurry/sack) ==",
        pd.crosstab(ok["t_pressure_s"].notna().rename("pression_tracking"), ok["pff_pressure"]).to_string(),
        "\n== Fin du temps de poche ==",
        ok["end_event"].value_counts().to_string(),
    ]
    txt = "\n".join(lines)
    path.write_text(txt + "\n", encoding="utf-8")
    return txt


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data", type=Path)
    ap.add_argument("--out", default="data_timing", type=Path)
    ap.add_argument("--limit", type=int, default=None, help="ne traiter que N matchs (test)")
    args = ap.parse_args()

    (args.out / "tracking").mkdir(parents=True, exist_ok=True)
    plays = pd.read_csv(args.data / "plays.csv")
    pff = pd.read_csv(args.data / "pffScoutingData.csv",
                      usecols=["gameId", "playId", "nflId", "pff_role", "pff_hit", "pff_hurry", "pff_sack"])

    files = sorted((args.data / "tracking").glob("tracking_*.csv"))[: args.limit]
    per_play = []
    for i, path in enumerate(files, 1):
        trk = pd.read_csv(path)
        gid = int(trk["gameId"].iloc[0])
        enriched, kf = process_game(trk, plays[plays["gameId"] == gid], pff[pff["gameId"] == gid])
        enriched.to_csv(args.out / "tracking" / path.name, index=False)
        kf.insert(0, "gameId", gid)
        per_play.append(kf)
        print(f"[{i}/{len(files)}] {path.name}: {len(kf)} actions", flush=True)

    metrics = pd.concat(per_play, ignore_index=True)
    plays_out = plays.merge(metrics, on=["gameId", "playId"], how="left")
    plays_out["timing_label"] = plays_out["timing_label"].fillna("non_calculable")
    plays_out.to_csv(args.out / "plays_timing.csv", index=False)

    processed = plays.merge(metrics, on=["gameId", "playId"], how="inner")
    print(write_summary(processed, pff, args.out / "summary.txt"))


if __name__ == "__main__":
    main()
