# ID-JAG MCP caller UI: run locally or build the container image.
# `make` (or `make help`) lists the targets. Override any variable on the command line,
# e.g. `make image IMAGE=ghcr.io/acme/idjag-mcp-caller-ui TAG=v1`.

IMAGE     ?= idjag-mcp-caller-ui
TAG       ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
PLATFORMS ?= linux/amd64,linux/arm64
DOCKER    ?= docker

PORT      ?= 5173
MCP_URL   ?= http://localhost:8000/mcp
# Inside a container, localhost is the container itself: reach an MCP server running on
# your machine through the Docker host alias instead.
DOCKER_MCP_URL ?= http://host.docker.internal:8000/mcp

.DEFAULT_GOAL := help
.PHONY: help run image image-run push clean

help: ## List the targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo
	@echo "  Variables: PLATFORMS=$(PLATFORMS) IMAGE=$(IMAGE) TAG=$(TAG) PORT=$(PORT) MCP_URL=$(MCP_URL)"

run: ## Run the UI with local Node (http://127.0.0.1:PORT)
	PORT=$(PORT) MCP_URL=$(MCP_URL) node server.js

image: ## Build the image for this machine's platform, tagged TAG and latest
	$(DOCKER) build -t $(IMAGE):$(TAG) -t $(IMAGE):latest .

image-run: image ## Build, then run the image hardened (read-only, no caps) on PORT
	$(DOCKER) run --rm --name idjag-mcp-caller-ui-local -p $(PORT):8080 \
		--read-only --cap-drop ALL --security-opt no-new-privileges \
		--add-host host.docker.internal:host-gateway \
		-e MCP_URL=$(DOCKER_MCP_URL) \
		$(IMAGE):$(TAG)

push: ## Build for PLATFORMS and push IMAGE:TAG (needs buildx and a registry login)
	$(DOCKER) buildx build --platform $(PLATFORMS) -t $(IMAGE):$(TAG) --push .

clean: ## Remove the local IMAGE:TAG and IMAGE:latest images
	-$(DOCKER) image rm $(IMAGE):$(TAG) $(IMAGE):latest
