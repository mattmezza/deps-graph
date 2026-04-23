# deps-graph build & dev tasks
#
# Usage:
#   make install   # install npm dev deps
#   make dev       # tailwind --watch + browser-sync (live reload) on src/
#   make build     # produce optimized dist/
#   make serve     # serve already-built dist/ statically
#   make clean     # remove dist/ and generated dev artifacts
#
# Dev mode serves files directly from src/. Tailwind writes src/styles.css
# in --watch mode, and browser-sync auto-reloads on any change in src/.

SHELL    := /bin/bash
SRC_DIR  := src
DIST_DIR := dist
PORT     ?= 3000

NODE_BIN := ./node_modules/.bin

TAILWIND := $(NODE_BIN)/tailwindcss
ESBUILD  := $(NODE_BIN)/esbuild
SERVE    := $(NODE_BIN)/live-server

.PHONY: help install dev dev-css dev-server build build-css build-js build-html \
        serve clean distclean release

help:
	@echo "Targets:"
	@echo "  install     - npm install dev dependencies"
	@echo "  dev         - run Tailwind --watch + browser-sync live reload (src/)"
	@echo "  build       - produce optimized dist/"
	@echo "  serve       - statically serve dist/ on port $(PORT)"
	@echo "  clean       - remove build artifacts (dist/, src/styles.css)"
	@echo "  distclean   - clean + remove node_modules"
	@echo "  release     - tag & publish a GitHub release (e.g. make release name=v1.2)"

# ---------- install ----------
install: node_modules
node_modules: package.json
	npm install
	@touch node_modules

# ---------- dev ----------
dev: node_modules
	@echo ">> dev: tailwind --watch + live-server on http://localhost:$(PORT)"
	@trap 'kill 0' EXIT INT TERM; \
	  $(TAILWIND) -i $(SRC_DIR)/input.css -o $(SRC_DIR)/styles.css --watch & \
	  $(SERVE) $(SRC_DIR) --port=$(PORT) --no-browser --quiet & \
	  wait

# ---------- build ----------
build: build-css build-js build-html
	@echo ">> build complete -> $(DIST_DIR)/"

$(DIST_DIR):
	@mkdir -p $(DIST_DIR)

build-css: node_modules | $(DIST_DIR)
	$(TAILWIND) -i $(SRC_DIR)/input.css -o $(DIST_DIR)/styles.css --minify

build-js: node_modules | $(DIST_DIR)
	$(ESBUILD) $(SRC_DIR)/app.js --bundle --minify --target=es2020 \
	    --outfile=$(DIST_DIR)/app.js

build-html: | $(DIST_DIR)
	cp $(SRC_DIR)/index.html $(DIST_DIR)/index.html

# ---------- serve prod ----------
serve: build
	$(SERVE) $(DIST_DIR) --port=$(PORT) --no-browser --quiet

# ---------- clean ----------
clean:
	rm -rf $(DIST_DIR) $(SRC_DIR)/styles.css

distclean: clean
	rm -rf node_modules

# ---------- release ----------
# Usage: make release name=v1.2
# Creates an annotated git tag, pushes it, and creates a GitHub release with
# auto-generated notes via gh CLI. Triggers the Pages deploy workflow.
release:
	@command -v gh >/dev/null || { echo "gh CLI not found. Install: https://cli.github.com"; exit 1; }
	@if [ -z "$(name)" ]; then echo "Usage: make release name=vX.Y"; exit 1; fi
	@echo "$(name)" | grep -Eq '^v[0-9]+\.[0-9]+$$' || { echo "Version must match vX.Y (e.g. v1.2)"; exit 1; }
	@if [ -n "$$(git status --porcelain)" ]; then echo "Working tree not clean. Commit or stash first."; exit 1; fi
	@branch=$$(git rev-parse --abbrev-ref HEAD); \
	  if [ "$$branch" != "main" ]; then echo "Refusing to release from '$$branch' (must be main)."; exit 1; fi
	@if git rev-parse "$(name)" >/dev/null 2>&1; then echo "Tag $(name) already exists."; exit 1; fi
	git push origin main
	git tag -a "$(name)" -m "Release $(name)"
	git push origin "$(name)"
	gh release create "$(name)" --title "$(name)" --generate-notes
	@echo ">> release $(name) published. Pages deploy will run via GitHub Actions."
