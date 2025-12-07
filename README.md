# static-proxy
HTML rewriting proxy worker, for migrating static sites e.g. from WordPress to Cloudflare.

## usage

- `/path?proxy-origin=https://example.com`  
  Fetch path, rewrite HTML to remove origin from URLs, proxy all other requests.

- `/html-json/path?proxy-origin...`  
  Return JSON with rewritten HTML and linked resources.

**params:**
Parameters may be passed on the URL, or via worker env vars.
- proxy-origin (required) - where to fetch HTML (env.PROXY_ORIGIN)
- rewrite-origin - origin to match in URLs to rewrite (defaults to proxy-origin - env.REWRITE_ORIGIN)
- rewrite-paths - fetch multiple pages and include in JSON stream (html-json mode only - env.REWRITE_PATHS)
- rewrite-depth - recurse links and include in JSON stream (html-json mode only - env.REWRITE_DEPTH)

## Suggested workflow
- Clone this repo locally, and run `pnpm install`
- Configure PROXY_ORIGIN to point to your existing site, and run `pnpm dev`
- Test proxy manually in browser, adjust code if necessary e.g. to rewrite/remove elements
- Configure PROXY_PATHS or RECURSE_DEPTH and run `pnpm migrate`.
  This uses /html-json/ to to populate /public (static dir) with migrated assets.
- Once migrated, the worker will serve static assets first, and only proxy missing paths.
  Check logs for `PROXY:` missing resources, and migrate manually (or adjust code to capture)
- Commit static assets from /public to non-proxying production site.
- Check for 404's.
