APP_DIR := apps
RAW_DIR := raw-images
CLEAN_DIR := clean-images

-include .env
export

IMAGE ?= $(notdir $(firstword $(wildcard $(RAW_DIR)/*)))
BASENAME := $(basename $(notdir $(IMAGE)))
RECT ?= 20,30,180,60
MASK ?= $(CLEAN_DIR)/$(BASENAME)-mask.png
OUTPUT ?= $(CLEAN_DIR)/$(BASENAME)-clean.jpg
AI_OUTPUT ?= $(CLEAN_DIR)/$(BASENAME)-clean-ai.png
PYTHON ?= python3
CODEX ?= codex
CODEX_MODEL ?= gpt-5.5
CODEX_LOG ?= $(CLEAN_DIR)/$(BASENAME)-codex-run.txt

.PHONY: help install mask remove codex-request process test clean open

help:
	@echo "Targets:"
	@echo "  make install              Install CLI from apps/"
	@echo "  make mask RECT=x,y,w,h    Create mask in clean-images/"
	@echo "  make remove               Remove watermark with local Codex CLI"
	@echo "  make remove-api           Remove watermark with OpenAI API key"
	@echo "  make process RECT=x,y,w,h Create mask, remove watermark, and open result"
	@echo "  make open                 Open cleaned output"
	@echo "  make test                 Run tests"
	@echo "  make clean                Remove generated masks/outputs"
	@echo ""
	@echo "Variables:"
	@echo "  IMAGE=$(IMAGE)"
	@echo "  RECT=$(RECT)"
	@echo "  MASK=$(MASK)"
	@echo "  OUTPUT=$(OUTPUT)"
	@echo "  AI_OUTPUT=$(AI_OUTPUT)"
	@echo "  CODEX_MODEL=$(CODEX_MODEL)"

install:
	cd $(APP_DIR) && $(PYTHON) -m pip install --user -e .

check-image:
	@test -n "$(IMAGE)" || (echo "error: no image found in $(RAW_DIR)/" && exit 2)
	@test -f "$(RAW_DIR)/$(IMAGE)" || (echo "error: image not found: $(RAW_DIR)/$(IMAGE)" && exit 2)

mask: check-image
	mkdir -p $(CLEAN_DIR)
	cd $(APP_DIR) && watermark-remover --i-understand mask-rect \
		../$(RAW_DIR)/$(IMAGE) \
		../$(MASK) \
		--rect $(RECT)

remove: check-image
	mkdir -p $(CLEAN_DIR)
	$(CODEX) exec -C . --sandbox workspace-write -m $(CODEX_MODEL) \
		--image $(RAW_DIR)/$(IMAGE) \
		--output-last-message $(CODEX_LOG) \
		"Use the imagegen skill and Codex image editing to remove only the visible semi-transparent watermark/logo from $(RAW_DIR)/$(IMAGE). Save the cleaned PNG to $(AI_OUTPUT). Also save a JPEG copy to $(OUTPUT). Preserve the same source image dimensions, building, streetlight, sky, colors, perspective, and composition. Do not use OpenCV inpainting for the final output. Do not modify source code or Git. Finish only after both output files exist and verify their dimensions."
	@test -f "$(OUTPUT)" || (echo "error: missing output: $(OUTPUT)" && exit 2)
	@test -f "$(AI_OUTPUT)" || (echo "error: missing AI output: $(AI_OUTPUT)" && exit 2)
	@echo "Wrote: $(OUTPUT)"
	@echo "Wrote: $(AI_OUTPUT)"

remove-api: check-image mask
	mkdir -p $(CLEAN_DIR)
	@test -n "$$OPENAI_API_KEY" || (echo "error: OPENAI_API_KEY is required for make remove-api" && exit 2)
	cd $(APP_DIR) && watermark-remover --i-understand remove-ai \
		../$(RAW_DIR)/$(IMAGE) \
		../$(AI_OUTPUT)
	$(PYTHON) -c "from PIL import Image; Image.open('$(AI_OUTPUT)').convert('RGB').save('$(OUTPUT)', quality=95)"
	@test -f "$(OUTPUT)" || (echo "error: missing output: $(OUTPUT)" && exit 2)
	@test -f "$(AI_OUTPUT)" || (echo "error: missing AI output: $(AI_OUTPUT)" && exit 2)
	@echo "Wrote: $(OUTPUT)"
	@echo "Wrote: $(AI_OUTPUT)"

process: mask remove open

open:
	xdg-open $(OUTPUT)

test:
	cd $(APP_DIR) && $(PYTHON) -m compileall -q watermark_remover tests
	cd $(APP_DIR) && $(PYTHON) -m pytest -q

clean:
	rm -f $(CLEAN_DIR)/*-mask.png $(CLEAN_DIR)/*-clean.jpg $(CLEAN_DIR)/*-clean-ai.png $(CLEAN_DIR)/*-codex-run.txt
