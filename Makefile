APP_DIR := apps
RAW_DIR := raw-images
CLEAN_DIR := clean-images
LOG_DIR := logs

-include .env
export OPENAI_API_KEY OPENAI_BASE_URL OPENAI_ORG_ID

IMAGE ?= $(notdir $(firstword $(wildcard $(RAW_DIR)/*)))
IMAGE_STEM := $(basename $(notdir $(IMAGE)))
IMAGE_DIR := $(dir $(IMAGE))
SAFE_IMAGE := $(subst /,__,$(basename $(IMAGE)))
RECT ?= 20,30,180,60
MASK ?= $(CLEAN_DIR)/$(IMAGE_DIR)$(IMAGE_STEM)-mask.png
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
CONCURRENCY ?= 2
DRY_RUN ?= 0
FORCE ?= 0
REASON ?= Needs retry

.PHONY: help install mask remove remove-one remove-api batch retry-failed continue-progress mark-failed process status test clean open

help:
	@echo "Targets:"
	@echo "  make install              Install CLI from apps/"
	@echo "  make mask RECT=x,y,w,h    Create mask in clean-images/"
	@echo "  make remove               Remove watermark with local Codex CLI"
	@echo "  make remove-api           Remove watermark with OpenAI API key"
	@echo "  make batch                Remove watermarks for all raw images"
	@echo "  make retry-failed         Retry only Failed images from logs/status.tsv"
	@echo "  make continue-progress    Continue In Progress images from logs/status.tsv"
	@echo "  make mark-failed          Mark IMAGE as Failed for retry"
	@echo "  make process RECT=x,y,w,h Create mask, remove watermark, and open result"
	@echo "  make open                 Open cleaned output"
	@echo "  make status               Show image processing status summary"
	@echo "  make test                 Run tests"
	@echo "  make clean                Remove generated masks/outputs"
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
	STATUS_FILE="$(STATUS_LOG)" STATUS_OUTPUT="$(OUTPUT)" $(PROGRESS_RUN) "$(IMAGE)" $(CODEX) exec -C . --sandbox workspace-write -m $(CODEX_MODEL) \
		--image $(RAW_DIR)/$(IMAGE) \
		--output-last-message $(CODEX_LOG) \
		"Use the imagegen skill and Codex image editing to remove only the visible semi-transparent watermark/logo from $(RAW_DIR)/$(IMAGE). Save exactly one cleaned output to $(OUTPUT), keeping the same filename and extension as the source image. Preserve the same source image dimensions, building, streetlight, sky, colors, perspective, and composition. Do not use OpenCV inpainting for the final output. Do not modify source code or Git. Finish only after $(OUTPUT) exists and verify its dimensions match the source."; \
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
	@RAW_DIR="$(RAW_DIR)" IMAGE_SCOPE="$(IMAGE_SCOPE)" CONCURRENCY="$(CONCURRENCY)" DRY_RUN="$(DRY_RUN)" $(BATCH_RUN)
	@if [ "$(DRY_RUN)" != "1" ]; then $(MAKE) --no-print-directory status; fi

retry-failed:
	@mkdir -p $(CLEAN_DIR)
	@mkdir -p $(LOG_DIR)
	@RAW_DIR="$(RAW_DIR)" STATUS_LOG="$(STATUS_LOG)" CONCURRENCY="$(CONCURRENCY)" DRY_RUN="$(DRY_RUN)" $(RETRY_FAILED_RUN)
	@if [ "$(DRY_RUN)" != "1" ]; then $(MAKE) --no-print-directory status; fi

continue-progress:
	@mkdir -p $(CLEAN_DIR)
	@mkdir -p $(LOG_DIR)
	@RAW_DIR="$(RAW_DIR)" STATUS_LOG="$(STATUS_LOG)" CONCURRENCY="$(CONCURRENCY)" DRY_RUN="$(DRY_RUN)" $(CONTINUE_PROGRESS_RUN)
	@if [ "$(DRY_RUN)" != "1" ]; then $(MAKE) --no-print-directory status; fi

mark-failed: check-image
	@mkdir -p $(LOG_DIR)
	@$(PYTHON) $(STATUS_WRITER) "$(STATUS_LOG)" "Failed" "$(IMAGE)" "$(OUTPUT)" "$(REASON)"
	@printf "[Failed] %s (%s)\\n" "$(IMAGE)" "$(REASON)"

process: mask remove open

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
