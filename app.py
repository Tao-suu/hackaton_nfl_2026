"""
Flask app serving the NFL Play Analyzer web UI + JSON API.
Run:  python3 app.py  →  open http://localhost:5000
"""
from flask import Flask, jsonify, render_template, request

import nfl_analytics as nfl
import pass_options as po
import timing

app = Flask(__name__)


# ---- pages ----

@app.route("/")
def index():
    return render_template("index.html")


# ---- API ----

@app.route("/api/games")
def api_games():
    return jsonify(nfl.get_games())


@app.route("/api/plays/<int:game_id>")
def api_plays(game_id):
    return jsonify(nfl.get_plays(game_id))


@app.route("/api/play/<int:game_id>/<int:play_id>")
def api_play(game_id, play_id):
    data = nfl.analyze_play(game_id, play_id)
    if data is None:
        return jsonify({"error": "Play not found"}), 404
    return jsonify(data)


@app.route("/api/timing/<int:game_id>/<int:play_id>")
def api_timing(game_id, play_id):
    """Timing Delta metric (compute_timing.py) for one play, per frame."""
    data = timing.play_timing(game_id, play_id)
    if data is None:
        return jsonify({"error": "Play not found"}), 404
    return jsonify(data)


@app.route("/api/timing-labels/<int:game_id>")
def api_timing_labels(game_id):
    return jsonify({str(k): v for k, v in timing.play_labels(game_id).items()})


@app.route("/api/options/<int:game_id>/<int:play_id>")
def api_options(game_id, play_id):
    """Multi-criteria evaluation of every pass option (default: at the throw).
    Optional ?frame=<frameId> evaluates the options at another moment."""
    frame = request.args.get("frame", type=int)
    data = po.play_options(game_id, play_id, frame)
    if data is None:
        return jsonify({"error": "Play not found"}), 404
    return jsonify(data)


@app.route("/api/qb/<int:passer_id>")
def api_qb(passer_id):
    """Season precision (CPOE) and decision speed of a QB."""
    data = po.qb_profile(passer_id)
    if data is None:
        return jsonify({"error": "QB not found"}), 404
    return jsonify(data)


if __name__ == "__main__":
    print("NFL Play Analyzer → http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=True)
