APP_DIR := apps
RAW_DIR := raw-images
CLEAN_DIR := clean-images

IMAGE ?= $(notdir $(firstword $(wildcard $(RAW_DIR)/*)))
BASENAME := $(basename $(notdir $(IMAGE)))
RECT ?= 20,30,180,60
MASK ?= $(CLEAN_DIR)/$(BASENAME)-mask.png
OUTPUT ?= $(CLEAN_DIR)/$(BASENAME)-clean.jpg
AI_OUTPUT ?= $(CLEAN_DIR)/$(BASENAME)-clean-ai.png
PYTHON ?= python3

.PHONY: help install mask remove process test clean open

help:
	@echo "Targets:"
	@echo "  make install              Install CLI from apps/"
	@echo "  make mask RECT=x,y,w,h    Create mask in clean-images/"
	@echo "  make remove               Create clean image; creates mask first if missing"
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

remove: check-image mask
	mkdir -p $(CLEAN_DIR)
	@if [ -f "$(AI_OUTPUT)" ]; then \
		echo "Using existing AI-cleaned image: $(AI_OUTPUT)"; \
		$(PYTHON) -c "from PIL import Image; Image.open('$(AI_OUTPUT)').convert('RGB').save('$(OUTPUT)', quality=95)"; \
	else \
		cd $(APP_DIR) && watermark-remover --i-understand remove \
			../$(RAW_DIR)/$(IMAGE) \
			../$(MASK) \
			../$(OUTPUT); \
		$(PYTHON) -c "from PIL import Image; Image.open('$(OUTPUT)').convert('RGB').save('$(AI_OUTPUT)')"; \
	fi
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
	rm -f $(CLEAN_DIR)/*-mask.png $(CLEAN_DIR)/*-clean.jpg
