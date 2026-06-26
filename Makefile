APP_DIR := apps
RAW_DIR := raw-images
CLEAN_DIR := clean-images
LOG_DIR := logs
MASK_DIR := $(LOG_DIR)/masks

-include .env
export OPENAI_API_KEY OPENAI_BASE_URL OPENAI_ORG_ID

IMAGE ?= $(notdir $(firstword $(wildcard $(RAW_DIR)/*)))
IMAGE_STEM := $(basename $(notdir $(IMAGE)))
IMAGE_DIR := $(dir $(IMAGE))
SAFE_IMAGE := $(subst /,__,$(basename $(IMAGE)))
RECT ?= 20,30,180,60
MASK ?= $(MASK_DIR)/$(IMAGE_DIR)$(IMAGE_STEM).png
OUTPUT ?= $(CLEAN_DIR)/$(IMAGE)
PYTHON ?= python3
CODEX ?= codex
CODEX_MODEL ?= gpt-5.4-mini
CODEX_LOG ?= $(LOG_DIR)/$(SAFE_IMAGE)-codex-run.txt
STATUS_LOG ?= $(LOG_DIR)/status.tsv
PROGRESS_RUN ?= scripts/progress-run.sh
STATUS_WRITER ?= scripts/status-log.py
BATCH_RUN ?= scripts/batch-remove.sh
RETRY_FAILED_RUN ?= scripts/retry-failed.sh
CONTINUE_PROGRESS_RUN ?= scripts/continue-progress.sh
CONCURRENCY ?= 1
DRY_RUN ?= 0
FORCE ?= 0
REASON ?= Needs retry
EXCLUDE_FILENAMES ?= rules/strapi-office-venue-existing-filenames.txt
STRAPI_UPLOAD_SCRIPT ?= scripts/upload-strapi-images.mjs
STRAPI_BASE_URL ?= https://cms.develop.99iddev.net
STRAPI_IMAGE_DIR ?= $(CLEAN_DIR)
STRAPI_REPORT_DIR ?= $(LOG_DIR)/strapi-upload-reports
STRAPI_EXISTING_FILENAMES ?= rules/strapi-office-venue-existing-filenames.txt
STRAPI_ROOT_FOLDER_PATH ?= Media Library/Office Venue
STRAPI_OFFICE ?=
STRAPI_FOLDER_FIELD ?= auto
STRAPI_EXTRA_ARGS ?=

export STRAPI_BASE_URL STRAPI_ADMIN_JWT STRAPI_ROOT_FOLDER_ID STRAPI_ROOT_FOLDER_NAME STRAPI_ROOT_FOLDER_PATH STRAPI_REPORT_DIR STRAPI_PAGE_SIZE

.PHONY: help install mask remove remove-one remove-api batch retry-failed continue-progress mark-failed process status upload-strapi-images upload-strapi-images-dry-run update-strapi-existing-filenames test clean open

help:
	@echo "Targets:"
	@echo "  make install              Install CLI from apps/"
	@echo "  make mask RECT=x,y,w,h    Create mask in logs/masks/"
	@echo "  make remove               Remove watermark with local Codex CLI"
	@echo "  make remove-api           Remove watermark with OpenAI API key"
	@echo "  make batch                Remove watermarks for all raw images"
	@echo "  make retry-failed         Retry only Failed images from logs/status.tsv"
	@echo "  make continue-progress    Continue In Progress images from logs/status.tsv"
	@echo "  make mark-failed          Mark IMAGE as Failed for retry"
	@echo "  make process RECT=x,y,w,h Create mask, remove watermark, and open result"
	@echo "  make upload-strapi-images  Upload $(STRAPI_IMAGE_DIR) to Strapi and update existing filename rules"
	@echo "  make upload-strapi-images-dry-run  Preview Strapi upload from $(STRAPI_IMAGE_DIR)"
	@echo "  make open                 Open cleaned output"
	@echo "  make status               Show image processing status summary"
	@echo "  make test                 Run tests"
	@echo "  make clean                Remove generated masks/outputs"
	@echo ""
	@echo "Strapi upload:"
	@echo "  export STRAPI_ADMIN_JWT=<develop-admin-jwt>"
	@echo "  make upload-strapi-images-dry-run"
	@echo "  make upload-strapi-images"
	@echo ""
	@echo "Variables:"
	@echo "  IMAGE=$(IMAGE)"
	@echo "  RECT=$(RECT)"
	@echo "  MASK=$(MASK)"
	@echo "  OUTPUT=$(OUTPUT)"
	@echo "  CODEX_MODEL=$(CODEX_MODEL)"
	@echo "  CODEX_LOG=$(CODEX_LOG)"
	@echo "  STATUS_LOG=$(STATUS_LOG)"
	@echo "  CONCURRENCY=$(CONCURRENCY)"
	@echo "  DRY_RUN=$(DRY_RUN)"
	@echo "  FORCE=$(FORCE)"
	@echo "  REASON=$(REASON)"
	@echo "  EXCLUDE_FILENAMES=$(EXCLUDE_FILENAMES)"
	@echo "  STRAPI_IMAGE_DIR=$(STRAPI_IMAGE_DIR)"
	@echo "  STRAPI_REPORT_DIR=$(STRAPI_REPORT_DIR)"
	@echo "  STRAPI_EXISTING_FILENAMES=$(STRAPI_EXISTING_FILENAMES)"
	@echo "  STRAPI_ROOT_FOLDER_PATH=$(STRAPI_ROOT_FOLDER_PATH)"
	@echo "  STRAPI_OFFICE=$(STRAPI_OFFICE)"

install:
	cd $(APP_DIR) && $(PYTHON) -m pip install --user -e .

check-image:
	@test -n "$(IMAGE)" || (echo "error: no image found in $(RAW_DIR)/" && exit 2)
	@test -f "$(RAW_DIR)/$(IMAGE)" -o -d "$(RAW_DIR)/$(IMAGE)" || (echo "error: image or folder not found: $(RAW_DIR)/$(IMAGE)" && exit 2)

mask: check-image
	@test -f "$(RAW_DIR)/$(IMAGE)" || (echo "error: mask target must be a file, got folder: $(RAW_DIR)/$(IMAGE)" && exit 2)
	@mkdir -p "$(dir $(MASK))"
	cd $(APP_DIR) && watermark-remover --i-understand mask-rect \
		../$(RAW_DIR)/$(IMAGE) \
		../$(MASK) \
		--rect $(RECT)

remove: check-image
	@if [ -d "$(RAW_DIR)/$(IMAGE)" ]; then \
		$(MAKE) --no-print-directory batch IMAGE_SCOPE="$(IMAGE)" CONCURRENCY="$(CONCURRENCY)" DRY_RUN="$(DRY_RUN)"; \
	else \
		$(MAKE) --no-print-directory remove-one IMAGE="$(IMAGE)"; \
	fi

remove-one: check-image
	@test -f "$(RAW_DIR)/$(IMAGE)" || (echo "error: remove-one target must be a file, got folder: $(RAW_DIR)/$(IMAGE)" && exit 2)
	@mkdir -p "$(dir $(OUTPUT))"
	@mkdir -p $(LOG_DIR)
	@set -e; \
	if [ "$(FORCE)" != "1" ] && [ -f "$(OUTPUT)" ] && $(PYTHON) -c "from PIL import Image; raw=Image.open('$(RAW_DIR)/$(IMAGE)'); out=Image.open('$(OUTPUT)'); assert out.size == raw.size" >/dev/null 2>&1; then \
		$(PYTHON) $(STATUS_WRITER) "$(STATUS_LOG)" "Done" "$(IMAGE)" "$(OUTPUT)" "Already cleaned; skipped retry"; \
		printf "[Done] %s (already cleaned)\\n" "$(IMAGE)"; \
		exit 0; \
	fi; \
	if [ "$(FORCE)" = "1" ]; then \
		rm -f "$(OUTPUT)"; \
	fi; \
	set +e; \
	STATUS_FILE="$(STATUS_LOG)" STATUS_OUTPUT="$(OUTPUT)" $(PROGRESS_RUN) "$(IMAGE)" $(CODEX) exec -C . --sandbox workspace-write -m $(CODEX_MODEL) \
		--image $(RAW_DIR)/$(IMAGE) \
		--output-last-message $(CODEX_LOG) \
		"Use the imagegen skill and Codex image editing to remove only the visible semi-transparent watermark/logo from $(RAW_DIR)/$(IMAGE). Save exactly one cleaned output to $(OUTPUT), keeping the same filename and extension as the source image. Preserve the same source image dimensions, building, streetlight, sky, colors, perspective, facade texture, window grid, edges, and composition. The cleaned area must look natural and consistent with surrounding pixels. Do not leave visible watermark text, logo fragments, ghost text, blurry smears, smooth patches, translucent rectangles, flat fills, or patch-like artifacts. Reconstruct plausible building/sky detail instead of covering the mark. Before finishing, visually inspect the saved output. If any watermark text/logo/remnant is still visible or the edit looks unnatural, delete $(OUTPUT), report the issue, and do not claim success. Do not use OpenCV inpainting for the final output. Do not modify source code or Git. Finish only after $(OUTPUT) exists, its dimensions match the source, and no visible watermark/remnant remains."; \
	progress_status=$$?; \
	set -e; \
	if [ "$$progress_status" -ne 0 ]; then exit "$$progress_status"; fi; \
	test -f "$(OUTPUT)" || (echo "error: missing output: $(OUTPUT)" && $(PYTHON) $(STATUS_WRITER) "$(STATUS_LOG)" "Failed" "$(IMAGE)" "$(OUTPUT)" "Missing output file" && exit 2); \
	$(PYTHON) -c "from PIL import Image; raw=Image.open('$(RAW_DIR)/$(IMAGE)'); out=Image.open('$(OUTPUT)'); assert out.size == raw.size, f'output size {out.size} != raw size {raw.size}'; print('Verified dimensions:', out.size)" || ($(PYTHON) $(STATUS_WRITER) "$(STATUS_LOG)" "Failed" "$(IMAGE)" "$(OUTPUT)" "Dimension verification failed" && exit 2); \
	$(PYTHON) $(STATUS_WRITER) "$(STATUS_LOG)" "Done" "$(IMAGE)" "$(OUTPUT)" "Watermark removed"; \
	echo "Wrote: $(OUTPUT)"

remove-api: check-image mask
	@mkdir -p "$(dir $(OUTPUT))"
	@test -n "$$OPENAI_API_KEY" || (echo "error: OPENAI_API_KEY is required for make remove-api" && exit 2)
	cd $(APP_DIR) && watermark-remover --i-understand remove-ai \
		../$(RAW_DIR)/$(IMAGE) \
		../$(OUTPUT)
	@test -f "$(OUTPUT)" || (echo "error: missing output: $(OUTPUT)" && exit 2)
	@$(PYTHON) -c "from PIL import Image; raw=Image.open('$(RAW_DIR)/$(IMAGE)'); out=Image.open('$(OUTPUT)'); assert out.size == raw.size; print('Verified dimensions:', out.size)"
	@echo "Wrote: $(OUTPUT)"

batch:
	@mkdir -p $(CLEAN_DIR)
	@mkdir -p $(LOG_DIR)
	@RAW_DIR="$(RAW_DIR)" IMAGE_SCOPE="$(IMAGE_SCOPE)" CONCURRENCY="$(CONCURRENCY)" DRY_RUN="$(DRY_RUN)" EXCLUDE_FILENAMES="$(EXCLUDE_FILENAMES)" $(BATCH_RUN)
	@if [ "$(DRY_RUN)" != "1" ]; then $(MAKE) --no-print-directory status; fi

retry-failed:
	@mkdir -p $(CLEAN_DIR)
	@mkdir -p $(LOG_DIR)
	@RAW_DIR="$(RAW_DIR)" STATUS_LOG="$(STATUS_LOG)" CONCURRENCY="$(CONCURRENCY)" DRY_RUN="$(DRY_RUN)" EXCLUDE_FILENAMES="$(EXCLUDE_FILENAMES)" $(RETRY_FAILED_RUN)
	@if [ "$(DRY_RUN)" != "1" ]; then $(MAKE) --no-print-directory status; fi

continue-progress:
	@mkdir -p $(CLEAN_DIR)
	@mkdir -p $(LOG_DIR)
	@RAW_DIR="$(RAW_DIR)" STATUS_LOG="$(STATUS_LOG)" CONCURRENCY="$(CONCURRENCY)" DRY_RUN="$(DRY_RUN)" EXCLUDE_FILENAMES="$(EXCLUDE_FILENAMES)" $(CONTINUE_PROGRESS_RUN)
	@if [ "$(DRY_RUN)" != "1" ]; then $(MAKE) --no-print-directory status; fi

mark-failed: check-image
	@mkdir -p $(LOG_DIR)
	@$(PYTHON) $(STATUS_WRITER) "$(STATUS_LOG)" "Failed" "$(IMAGE)" "$(OUTPUT)" "$(REASON)"
	@printf "[Failed] %s (%s)\\n" "$(IMAGE)" "$(REASON)"

process: mask remove open

upload-strapi-images:
	@test -d "$(STRAPI_IMAGE_DIR)" || (echo "error: image folder not found: $(STRAPI_IMAGE_DIR)" && exit 2)
	@test -n "$$STRAPI_ADMIN_JWT" || (echo "error: STRAPI_ADMIN_JWT is required" && exit 2)
	@mkdir -p "$(STRAPI_REPORT_DIR)" "$(dir $(STRAPI_EXISTING_FILENAMES))"
	@set -e; \
	before_marker="$$(mktemp)"; \
	find "$(STRAPI_REPORT_DIR)" -maxdepth 1 -type f -name 'strapi-upload-report-*.csv' -print > "$$before_marker" 2>/dev/null || true; \
	node "$(STRAPI_UPLOAD_SCRIPT)" \
		--dir "$(STRAPI_IMAGE_DIR)" \
		--report-dir "$(STRAPI_REPORT_DIR)" \
		--folder-field "$(STRAPI_FOLDER_FIELD)" \
		$(if $(STRAPI_OFFICE),--office "$(STRAPI_OFFICE)",) \
		$(STRAPI_EXTRA_ARGS) \
		--confirm; \
	report="$$(find "$(STRAPI_REPORT_DIR)" -maxdepth 1 -type f -name 'strapi-upload-report-*.csv' -newer "$$before_marker" -print | sort | tail -n 1)"; \
	rm -f "$$before_marker"; \
	test -n "$$report" || (echo "error: upload completed but no new CSV report was found in $(STRAPI_REPORT_DIR)" && exit 2); \
	node -e 'const fs=require("fs"); const [report,out]=process.argv.slice(1); const text=fs.readFileSync(report,"utf8"); const rows=[]; let row=[], cell="", quote=false; for (let i=0;i<text.length;i++){ const ch=text[i], next=text[i+1]; if (quote && ch==="\"" && next==="\""){ cell+="\""; i++; } else if (ch==="\""){ quote=!quote; } else if (!quote && ch===","){ row.push(cell); cell=""; } else if (!quote && (ch==="\n" || ch==="\r")){ if (ch==="\r" && next==="\n") i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row=[]; cell=""; } else { cell+=ch; } } if (cell || row.length){ row.push(cell); rows.push(row); } const header=rows.shift() || []; const filenameIndex=header.indexOf("filename"); const statusIndex=header.indexOf("status"); if (filenameIndex < 0 || statusIndex < 0) throw new Error("CSV report is missing filename/status columns"); const done=new Set(["uploaded","skipped_existing"]); const existing=fs.existsSync(out) ? fs.readFileSync(out,"utf8").split(/\r?\n/).filter(Boolean) : []; const names=rows.filter((r)=>done.has(r[statusIndex])).map((r)=>r[filenameIndex]).filter(Boolean); const merged=[...new Set([...existing,...names])].sort((a,b)=>a.localeCompare(b,"en",{numeric:true})); fs.writeFileSync(out, merged.join("\n") + (merged.length ? "\n" : "")); const failed=rows.filter((r)=>r[statusIndex]==="failed").length; console.log("Updated " + out + ": added " + names.length + " uploaded/existing filename(s) from " + report + "."); if (failed) { console.error("warning: " + failed + " failed upload(s) were not added."); process.exitCode=1; }' "$$report" "$(STRAPI_EXISTING_FILENAMES)"

upload-strapi-images-dry-run:
	@test -d "$(STRAPI_IMAGE_DIR)" || (echo "error: image folder not found: $(STRAPI_IMAGE_DIR)" && exit 2)
	@mkdir -p "$(STRAPI_REPORT_DIR)"
	node "$(STRAPI_UPLOAD_SCRIPT)" \
		--dir "$(STRAPI_IMAGE_DIR)" \
		--report-dir "$(STRAPI_REPORT_DIR)" \
		--folder-field "$(STRAPI_FOLDER_FIELD)" \
		$(if $(STRAPI_OFFICE),--office "$(STRAPI_OFFICE)",) \
		$(STRAPI_EXTRA_ARGS) \
		--dry-run

update-strapi-existing-filenames:
	@test -n "$(STRAPI_UPLOAD_REPORT)" || (echo "error: STRAPI_UPLOAD_REPORT is required" && exit 2)
	@test -f "$(STRAPI_UPLOAD_REPORT)" || (echo "error: report not found: $(STRAPI_UPLOAD_REPORT)" && exit 2)
	@mkdir -p "$(dir $(STRAPI_EXISTING_FILENAMES))"
	@node -e 'const fs=require("fs"); const [report,out]=process.argv.slice(1); const text=fs.readFileSync(report,"utf8"); const rows=[]; let row=[], cell="", quote=false; for (let i=0;i<text.length;i++){ const ch=text[i], next=text[i+1]; if (quote && ch==="\"" && next==="\""){ cell+="\""; i++; } else if (ch==="\""){ quote=!quote; } else if (!quote && ch===","){ row.push(cell); cell=""; } else if (!quote && (ch==="\n" || ch==="\r")){ if (ch==="\r" && next==="\n") i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row=[]; cell=""; } else { cell+=ch; } } if (cell || row.length){ row.push(cell); rows.push(row); } const header=rows.shift() || []; const filenameIndex=header.indexOf("filename"); const statusIndex=header.indexOf("status"); if (filenameIndex < 0 || statusIndex < 0) throw new Error("CSV report is missing filename/status columns"); const done=new Set(["uploaded","skipped_existing"]); const existing=fs.existsSync(out) ? fs.readFileSync(out,"utf8").split(/\r?\n/).filter(Boolean) : []; const names=rows.filter((r)=>done.has(r[statusIndex])).map((r)=>r[filenameIndex]).filter(Boolean); const merged=[...new Set([...existing,...names])].sort((a,b)=>a.localeCompare(b,"en",{numeric:true})); fs.writeFileSync(out, merged.join("\n") + (merged.length ? "\n" : "")); const failed=rows.filter((r)=>r[statusIndex]==="failed").length; console.log("Updated " + out + ": added " + names.length + " uploaded/existing filename(s) from " + report + "."); if (failed) { console.error("warning: " + failed + " failed upload(s) were not added."); process.exitCode=1; }' "$(STRAPI_UPLOAD_REPORT)" "$(STRAPI_EXISTING_FILENAMES)"

open:
	xdg-open $(OUTPUT)

status:
	@if [ -f "$(STATUS_LOG)" ]; then \
		column -t -s "$$(printf '\t')" "$(STATUS_LOG)" 2>/dev/null || cat "$(STATUS_LOG)"; \
	else \
		echo "No status log yet: $(STATUS_LOG)"; \
	fi

test:
	cd $(APP_DIR) && $(PYTHON) -m compileall -q watermark_remover tests
	cd $(APP_DIR) && $(PYTHON) -m pytest -q

clean:
	find $(CLEAN_DIR) -mindepth 1 ! -name '.gitkeep' -exec rm -rf {} +
	rm -f $(LOG_DIR)/*-codex-run.txt
	rm -rf $(MASK_DIR)
