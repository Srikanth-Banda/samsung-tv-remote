#!/bin/bash
set -e

IMAGE=ghcr.io/srikanth-banda/samsung-tv-remote

docker pull ${IMAGE}:latest
docker compose -f ~/deploy/samsung-tv-remote/docker-compose.yml up -d
docker image prune -f
