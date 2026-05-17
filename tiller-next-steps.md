# Tiller Architecture

## Workspaces

Currently Tiller uses either Cloudflare Containers or Tiller Host-managed Docker
containers. Fly.io is no longer part of the supported runtime.

Sometimes you don't need an entire container however. In that case we use cloudflare dynamic workers. These are not linux environments, and can't run claude code

## Interacting

Through a computer you interact via a CLI which boots into your remote environments. Through the phone we still provide a way to type this in, but it's janky. Via the phone it is expected that you'll interact with voice.

## Future Work

- If we want to add a "light tier", then we need to add "@cloudflare/shell" so that the files can be shared between the two.
