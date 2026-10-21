#!/usr/bin/env python3
"""
Pipeline global : data/ -> data_enriched/ (timing + gravité, tous les champs)
=============================================================================
Part des CSV d'origine (non modifiés) et produit :

  <out>/tracking/tracking_<gameId>.csv.gz
      Toutes les colonnes du tracking d'origine (ordre des lignes conservé) +
      joueur   : displayName, officialPosition, pff_role, pff_positionLinedUp
      timing   : t_since_snap_s, depth_yd, sep_nearest_def_yd, dist_to_qb_yd,
                 is_open, is_pressuring, n_open, qb_min_def_dist_yd,
                 frame_pressure, timing_state, timing_label, timing_delta_s
      gravité  : gravity, gravity_index            (coureurs de route)
                 def_focus_nflId, def_focus_share   (défenseurs en couverture)
  <out>/plays_enriched.csv   : plays.csv + métriques timing + gravité par action
  <out>/routes_enriched.csv  : une ligne par (action, coureur de route)
  <out>/summary.txt          : contrôles et distributions

Timing (voir compute_timing.py) : t_open = 1er receveur ouvert (>= 3 yd du
défenseur le plus proche, >= 5 yd au-delà de la LOS, tenu 0,3 s) ;
t_pressure = 1er défenseur à <= 2 yd du QB dans le backfield ;
timing_delta_s = t_pressure - t_open.

Gravité : à chaque frame entre le snap et la fin du temps de poche, chaque
défenseur en couverture répartit 1 unité d'attention entre les coureurs de
route, proportionnellement à 1/d² (d plancher à 1 yd).
  gravity        = somme des parts reçues par le receveur
  gravity_index  = gravity / (n_couverture / n_routes)  -> 1.0 = part équitable
  def_focus_*    = receveur auquel le défenseur consacre le plus d'attention

Usage : python build_dataset.py [--data data] [--out data_enriched]
                                [--limit N] [--jobs 4] [--no-gzip]
"""
from __future__ import annotations

import argparse
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

import compute_timing as ct

K = ["playId", "frameId"]
GRAVITY_MIN_DIST_YD = 1.0          # évite 1/d² infini quand deux joueurs se touchent
OUT_OF_WINDOW = {"avant_snap", "apres_fin", "non_calculable"}

_G: dict = {}                      # données statiques, chargées une fois par processus


def load_static(data_dir: Path) -> dict:
    plays = pd.read_csv(data_dir / "plays.csv")
    pff = pd.read_csv(data_dir / "pffScoutingData.csv",
                      usecols=["gameId", "playId", "nflId", "pff_role", "pff_positionLinedUp",
                               "pff_hit", "pff_hurry", "pff_sack"])
    players = pd.read_csv(data_dir / "players.csv",
                          usecols=["nflId", "displayName", "officialPosition"])
    return {"plays": plays, "pff": pff, "players": players}


def _init_worker(data_dir: str) -> None:
    _G.update(load_static(Path(data_dir)))


def add_gravity(trk: pd.DataFrame):
    """Ajoute les colonnes de gravité. Retourne (trk, résumé par route)."""
    win = ~trk["timing_state"].isin(OUT_OF_WINDOW)
    r = trk.loc[win & (trk["pff_role"] == "Pass Route"), K + ["nflId", "x", "y"]]
    d = trk.loc[win & (trk["pff_role"] == "Coverage"), K + ["nflId", "x", "y"]]

    p = r.merge(d, on=K, suffixes=("", "_d"))
    p["w"] = 1.0 / np.maximum(np.hypot(p["x"] - p["x_d"], p["y"] - p["y_d"]), GRAVITY_MIN_DIST_YD) ** 2
    p["share"] = p["w"] / p.groupby(K + ["nflId_d"])["w"].transform("sum")

    g = p.groupby(K + ["nflId"])["share"].sum().rename("gravity").to_frame()
    g = g.join(r.groupby(K).size().rename("n_routes"), on=K)
    g = g.join(d.groupby(K).size().rename("n_cov"), on=K)
    g["gravity_index"] = g["gravity"] / (g["n_cov"] / g["n_routes"])

    focus = p.loc[p.groupby(K + ["nflId_d"])["share"].idxmax(), K + ["nflId_d", "nflId", "share"]]
    focus = focus.rename(columns={"nflId": "def_focus_nflId", "nflId_d": "nflId",
                                  "share": "def_focus_share"}).set_index(K + ["nflId"])

    n0 = len(trk)
    trk = trk.join(g[["gravity", "gravity_index"]].round(3), on=K + ["nflId"])
    trk = trk.join(focus.round(3), on=K + ["nflId"])
    assert len(trk) == n0, "la jointure gravité a dupliqué des lignes"

    routes = (g.reset_index().groupby(["playId", "nflId"])
              .agg(gravity_index_mean=("gravity_index", "mean"),
                   gravity_index_max=("gravity_index", "max"),
                   gravity_frames=("gravity_index", "size"))
              .reset_index())
    return trk, routes


def process_file(path: Path, out_dir: Path, gzip: bool):
    plays, pff, players = _G["plays"], _G["pff"], _G["players"]
    raw = pd.read_csv(path)
    gid = int(raw["gameId"].iloc[0])
    pff_g = pff[pff["gameId"] == gid]

    trk, kf = ct.process_game(raw, plays[plays["gameId"] == gid], pff_g)
    trk, routes = add_gravity(trk)

    # Infos joueur (nom, poste, alignement) pour le visualiseur
    trk = trk.merge(players, on="nflId", how="left")
    trk = trk.merge(pff_g[["playId", "nflId", "pff_positionLinedUp"]], on=["playId", "nflId"], how="left")

    # Contrôles : mêmes lignes, mêmes colonnes d'origine, mêmes valeurs
    assert len(trk) == len(raw)
    assert list(trk.columns[: len(raw.columns)]) == list(raw.columns)
    assert np.allclose(trk["x"].to_numpy(), raw["x"].to_numpy())

    front = list(raw.columns) + ["displayName", "officialPosition", "pff_role", "pff_positionLinedUp"]
    trk = trk[front + [c for c in trk.columns if c not in front]]

    name = path.stem + (".csv.gz" if gzip else ".csv")
    comp = {"method": "gzip", "compresslevel": 1} if gzip else None
    trk.to_csv(out_dir / "tracking" / name, index=False, compression=comp)

    # Gravité par action : receveur qui a le plus aspiré la défense
    top = routes.sort_values("gravity_index_mean").groupby("playId").tail(1).set_index("playId")
    kf = kf.join(top[["nflId", "gravity_index_mean"]]
                 .rename(columns={"nflId": "gravity_top_nflId",
                                  "gravity_index_mean": "gravity_top_index"}), on="playId")
    kf.insert(0, "gameId", gid)
    routes.insert(0, "gameId", gid)
    return path.name, kf, routes


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data", type=Path)
    ap.add_argument("--out", default="data_enriched", type=Path)
    ap.add_argument("--limit", type=int, default=None, help="ne traiter que N matchs (test)")
    ap.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    ap.add_argument("--no-gzip", action="store_true", help="écrire des .csv non compressés")
    args = ap.parse_args()

    (args.out / "tracking").mkdir(parents=True, exist_ok=True)
    static = load_static(args.data)
    files = sorted((args.data / "tracking").glob("tracking_*.csv"))[: args.limit]

    per_play, per_route = [], []
    with ProcessPoolExecutor(args.jobs, initializer=_init_worker, initargs=(str(args.data),)) as ex:
        futs = [ex.submit(process_file, f, args.out, not args.no_gzip) for f in files]
        for i, fut in enumerate(futs, 1):
            name, kf, routes = fut.result()
            per_play.append(kf)
            per_route.append(routes)
            print(f"[{i}/{len(files)}] {name}: {len(kf)} actions", flush=True)

    plays, players = static["plays"], static["players"]
    metrics = pd.concat(per_play, ignore_index=True)
    plays_out = plays.merge(metrics, on=["gameId", "playId"], how="left")
    plays_out["timing_label"] = plays_out["timing_label"].fillna("non_calculable")
    plays_out.to_csv(args.out / "plays_enriched.csv", index=False)

    routes = (pd.concat(per_route, ignore_index=True)
              .merge(players, on="nflId", how="left")
              .merge(static["pff"][["gameId", "playId", "nflId", "pff_positionLinedUp"]],
                     on=["gameId", "playId", "nflId"], how="left")
              .merge(plays_out[["gameId", "playId", "passResult", "pff_passCoverageType",
                                "timing_label", "first_open_nflId"]], on=["gameId", "playId"], how="left"))
    routes["is_first_open"] = routes["nflId"] == routes["first_open_nflId"]
    routes = routes.drop(columns="first_open_nflId")
    routes.to_csv(args.out / "routes_enriched.csv", index=False)

    processed = plays.merge(metrics, on=["gameId", "playId"], how="inner")
    txt = ct.write_summary(processed, static["pff"], args.out / "summary.txt")
    grav = ("\n\n== Gravite: indice moyen par poste ==\n"
            + routes.groupby("officialPosition")["gravity_index_mean"].agg(["mean", "size"]).round(2).to_string())
    with open(args.out / "summary.txt", "a", encoding="utf-8") as fh:
        fh.write(grav + "\n")
    print(txt + grav)


if __name__ == "__main__":
    main()
