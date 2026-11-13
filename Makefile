# ID-JAG MCP caller UI: run locally or build the container images.
# `make` (or `make help`) lists the targets. Override any variable on the command line,
# e.g. `make image IMAGE=ghcr.io/acme/idjag-mcp-caller-ui TAG=v1`.

IMAGE     ?= idjag-mcp-caller-ui
TAG       ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
PLATFORMS ?= linux/amd64,linux/arm64
DOCKER    ?= docker
# Architecture of the Docker engine (arm64 on Apple Silicon): picks the image `image-run` starts.
HOST_ARCH ?= $(shell $(DOCKER) version -f '{{.Server.Arch}}' 2>/dev/null || echo amd64)

PORT      ?= 5173
MCP_URL   ?= http://localhost:8000/mcp
# Inside a container, localhost is the container itself: reach an MCP server running on
# your machine through the Docker host alias instead.
DOCKER_MCP_URL ?= http://host.docker.internal:8000/mcp

# One local image per architecture, tagged IMAGE:TAG-<arch>. The Dockerfile has no RUN step,
# so building the non-native one needs no emulation: it only pulls that platform's layers.
define build_image
$(DOCKER) build --platform linux/$(1) -t $(IMAGE):$(TAG)-$(1) .
endef

.DEFAULT_GOAL := help
.PHONY: help run image image-amd64 image-arm64 image-run push clean

help: ## List the targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo
	@echo "  Variables: IMAGE=$(IMAGE) TAG=$(TAG) PLATFORMS=$(PLATFORMS) HOST_ARCH=$(HOST_ARCH) PORT=$(PORT) MCP_URL=$(MCP_URL)"

run: ## Run the UI with local Node (http://127.0.0.1:PORT)
	PORT=$(PORT) MCP_URL=$(MCP_URL) node server.js

image: image-amd64 image-arm64 ## Build both local images: linux/amd64, then linux/arm64

image-amd64: ## Build the linux/amd64 image, tagged IMAGE:TAG-amd64
	$(call build_image,amd64)

image-arm64: ## Build the linux/arm64 image, tagged IMAGE:TAG-arm64
	$(call build_image,arm64)

image-run: image-$(HOST_ARCH) ## Build and run this machine's image hardened (read-only, no caps) on PORT
	$(DOCKER) run --rm --name idjag-mcp-caller-ui-local -p $(PORT):8080 \
		--read-only --cap-drop ALL --security-opt no-new-privileges \
		--add-host host.docker.internal:host-gateway \
		-e MCP_URL=$(DOCKER_MCP_URL) \
		$(IMAGE):$(TAG)-$(HOST_ARCH)

push: ## Build for PLATFORMS and push one multi-arch IMAGE:TAG (needs buildx and a registry login)
	$(DOCKER) buildx build --platform $(PLATFORMS) -t $(IMAGE):$(TAG) --push .

clean: ## Remove the local IMAGE:TAG-amd64 and IMAGE:TAG-arm64 images
	-$(DOCKER) image rm $(IMAGE):$(TAG)-amd64 $(IMAGE):$(TAG)-arm64
