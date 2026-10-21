PYTHON     ?= python3
DATA_REPO  := https://github.com/ThompsonJamesBliss/nfl-big-data-bowl-regional-event-data.git
DATA_DIR   := data_nfl
TIMING_DIR := data_timing_tmp
ENRICH_DIR := data_enriched

.PHONY: all data_install data_build launch

all: data_install data_build launch

# Clone le jeu de données (≈1 GB) dans data_nfl/ (ignoré s'il est déjà présent)
data_install:
	@if [ -d "$(DATA_DIR)/.git" ]; then \
		echo "$(DATA_DIR)/ déjà présent, clone ignoré"; \
	else \
		git clone "$(DATA_REPO)" "$(DATA_DIR)"; \
	fi

# explore_gravity.py lit ./data et ./data_timing_tmp (chemins en dur) :
# on expose data_nfl/data via un lien symbolique ./data, que les autres scripts
# utilisent aussi comme valeur par défaut de --data.
data_build:
	@test -d "$(DATA_DIR)/data" || { echo "$(DATA_DIR)/data introuvable, lancer 'make data_install'"; exit 1; }
	ln -sfn "$(DATA_DIR)/data" data
	$(PYTHON) compute_timing.py --data data --out $(TIMING_DIR)
	$(PYTHON) explore_gravity.py
	$(PYTHON) build_dataset.py --data data --out $(ENRICH_DIR)

# Lance le front Flask sur http://localhost:5000
launch:
	$(PYTHON) app.py
