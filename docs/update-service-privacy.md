# Update Service Privacy

Release-channel Tiller Hub builds check `https://updates.paperwing.dev/tiller-hub/latest`
before falling back to GitHub's public release API. The service is only a cache
and aggregate update-check counter; Tiller's self-update apply flow is unchanged.

The Hub sends exactly these application headers to the update service:

- `X-Tiller-Version`: the running Hub version, or `unknown` if unavailable.
- `X-Tiller-Channel`: `release` or `development`.

The Hub does not send cookies, Hub URLs, repository names, Cloudflare account
IDs, install IDs, prompts, code, logs, or session data to the update service.
Timeouts, non-2xx service responses, malformed JSON, or invalid
`tiller-update.json` metadata are ignored and the Hub uses the existing GitHub
lookup directly.

Set `TILLER_UPDATE_SERVICE_DISABLED=1` on the Hub Worker to skip
`updates.paperwing.dev` and use GitHub directly.
