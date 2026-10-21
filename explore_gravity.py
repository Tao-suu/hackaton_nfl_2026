#!/usr/bin/env python3
"""Exploration rapide de la « gravité » des receveurs.

A chaque frame (snap -> fin du temps de poche), chaque défenseur en couverture
répartit 1 unité d'attention entre les coureurs de route, proportionnellement
à 1/d² (d plancher à 1 yard). Gravité d'un receveur = somme des parts reçues.
Indice de gravité = gravité / (n_couverture / n_routes) : 1.0 = part équitable.
Lit les copies enrichies de data_timing_tmp/ (produites par compute_timing.py).
"""
from pathlib import Path
import sys
import numpy as np
import pandas as pd

DATA, OUT = Path("data"), Path("data_timing_tmp")
limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
cols = ["gameId", "playId", "nflId", "frameId", "team", "x", "y", "pff_role",
        "sep_nearest_def_yd", "timing_state"]
K = ["gameId", "playId", "frameId"]
parts, ends = [], []
for f in sorted((OUT / "tracking").glob("tracking_*.csv*"))[:limit]:
    t = pd.read_csv(f, usecols=cols)
    t = t[~t["timing_state"].isin(["avant_snap", "apres_fin", "non_calculable"])]
    r = t.loc[t.pff_role == "Pass Route", K + ["nflId", "x", "y"]]
    d = t.loc[t.pff_role == "Coverage", K + ["nflId", "x", "y"]]
    p = r.merge(d, on=K, suffixes=("", "_d"))
    p["w"] = 1.0 / np.maximum(np.hypot(p.x - p.x_d, p.y - p.y_d), 1.0) ** 2
    p["share"] = p.w / p.groupby(K + ["nflId_d"]).w.transform("sum")
    g = p.groupby(K + ["nflId"]).share.sum().rename("gravity").reset_index()
    nr = r.groupby(K).size().rename("n_routes")
    nd = d.groupby(K).size().rename("n_cov")
    g = g.join(nr, on=K).join(nd, on=K)
    g["gindex"] = g.gravity / (g.n_cov / g.n_routes)
    parts.append(g.groupby(["gameId", "playId", "nflId"]).agg(
        gindex=("gindex", "mean"), n_routes=("n_routes", "first")).reset_index())
    last = r.merge(t[K + ["nflId", "sep_nearest_def_yd"]], on=K + ["nflId"])
    last = last.sort_values("frameId").groupby(["gameId", "playId", "nflId"]).tail(1)
    ends.append(last[["gameId", "playId", "nflId", "sep_nearest_def_yd"]])

rp = pd.concat(parts).merge(pd.concat(ends), on=["gameId", "playId", "nflId"])
players = pd.read_csv(DATA / "players.csv", usecols=["nflId", "displayName", "officialPosition"])
plays = pd.read_csv(DATA / "plays.csv", usecols=["gameId", "playId", "passResult", "pff_passCoverageType"])
rp = rp.merge(players, on="nflId").merge(plays, on=["gameId", "playId"])
rp.to_csv(OUT / "gravity_routes.csv", index=False)

print(f"{rp[['gameId','playId']].drop_duplicates().shape[0]} actions, {len(rp)} routes")
print("\n== Indice moyen par poste ==")
print(rp.groupby("officialPosition").gindex.agg(["mean", "median", "size"]).round(2).to_string())
print("\n== Man vs Zone ==")
print(rp.groupby(["pff_passCoverageType", "officialPosition"]).gindex.mean().unstack().round(2).to_string())

lb = rp.groupby(["displayName", "officialPosition"]).agg(
    routes=("gindex", "size"), gindex=("gindex", "mean")).reset_index()
lb = lb[lb.routes >= 150].sort_values("gindex", ascending=False)
print("\n== Top 15 gravite (>=150 routes) ==")
print(lb.head(15).round(2).to_string(index=False))
print("\n== Bottom 5 ==")
print(lb.tail(5).round(2).to_string(index=False))

# Effet sur les coéquipiers : le receveur qui aspire le plus libère-t-il les autres ?
rp["rank"] = rp.groupby(["gameId", "playId"]).gindex.rank(ascending=False, method="first")
top = rp[rp["rank"] == 1].set_index(["gameId", "playId"])
others = rp[rp["rank"] > 1].groupby(["gameId", "playId"]).sep_nearest_def_yd.max()
pl = top[["gindex", "officialPosition", "passResult", "n_routes"]].join(others.rename("best_other_sep"))
pl = pl[pl.n_routes.between(3, 5)].dropna()
pl["q"] = pd.qcut(pl.gindex, 4, labels=["Q1 faible", "Q2", "Q3", "Q4 forte"])
print("\n== Gravite du receveur le plus 'aspirant' vs coequipiers (3-5 routes) ==")
print(pl.groupby(["n_routes", "q"], observed=True).agg(
    best_other_sep=("best_other_sep", "median"),
    completion=("passResult", lambda s: (s == "C").mean()),
    n=("gindex", "size")).round(2).to_string())
