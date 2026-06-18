APP_DIR := apps
RAW_DIR := raw-images
CLEAN_DIR := clean-images

IMAGE ?= 1_capital-place-capital-place_20170410041740_35444.jpg
BASENAME := $(basename $(notdir $(IMAGE)))
RECT ?= 20,30,180,60
MASK ?= $(CLEAN_DIR)/$(BASENAME)-mask.png
OUTPUT ?= $(CLEAN_DIR)/$(BASENAME)-clean.jpg
PYTHON ?= python3

.PHONY: help install mask remove test clean open

help:
	@echo "Targets:"
	@echo "  make install              Install CLI from apps/"
	@echo "  make mask RECT=x,y,w,h    Create mask in clean-images/"
	@echo "  make remove               Create clean image from mask"
	@echo "  make open                 Open cleaned output"
	@echo "  make test                 Run tests"
	@echo "  make clean                Remove generated masks/outputs"
	@echo ""
	@echo "Variables:"
	@echo "  IMAGE=$(IMAGE)"
	@echo "  RECT=$(RECT)"
	@echo "  MASK=$(MASK)"
	@echo "  OUTPUT=$(OUTPUT)"

install:
	cd $(APP_DIR) && $(PYTHON) -m pip install --user -e .

mask:
	mkdir -p $(CLEAN_DIR)
	cd $(APP_DIR) && watermark-remover --i-understand mask-rect \
		../$(RAW_DIR)/$(IMAGE) \
		../$(MASK) \
		--rect $(RECT)

remove:
	mkdir -p $(CLEAN_DIR)
	cd $(APP_DIR) && watermark-remover --i-understand remove \
		../$(RAW_DIR)/$(IMAGE) \
		../$(MASK) \
		../$(OUTPUT)

open:
	xdg-open $(OUTPUT)

test:
	cd $(APP_DIR) && $(PYTHON) -m compileall -q watermark_remover tests
	cd $(APP_DIR) && $(PYTHON) -m pytest -q

clean:
	rm -f $(CLEAN_DIR)/*-mask.png $(CLEAN_DIR)/*-clean.jpg
