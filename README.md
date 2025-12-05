# static-proxy
Converts WordPress site into static site hosted on Cloudflare.
Migrates HTML pages with linked resources (css, js, images etc.) to workers assets.
May be run once, or repeatedly e.g. if using original WP site for CMS.

### Usage
- fork this repo
- configure env vars in wrangler.jsonc

### Worker
- Serves only static assets in production
- Depends on workers assets routes being served first (proxied content indicates missing static assets)
- Can serve subset of routes on any existing domain by using page-rules to trigger only on specific routes
  e.g. /, /conferences/, /certifications/, /wp-content/*, /wp-includes/*

### Build container
- Updates workers assets by running wrangler deploy against a directory inside the container.
- Container includes git, cloned repo, pnpm install (for wrangler etc.), bun/deno, puppeteer.

### /rewrite-page/url...
- Fetches a page from /url at wordpress origin and uses HTMLRewriter to munge the HTML.
- See https://developers.cloudflare.com/workers/runtime-apis/html-rewriter (more links in src/index.ts)
- Typically called from the /update-pages script running in the container
- Rewrites links e.g. to replace same origin with relative urls
- Removes unwanted elements.
- Collects resource paths for images, styles, scripts etc. including srcset in `<img>` elements.
- Collects page paths from `<a href=...`.
- Returns JSON {html, resources, pages}.

Using a worker for this is not strictly necessary - the same thing could could be done from inside the update-pages container script, using an alternative HTML parser (html-rewriter is specific to workers). This design allows for periodic scheduling to check for modified origin pages, and self-update the static assets by launching the container only when something changed.

### /update-pages
- Launched by the update-pages.sh entrypoint script in the container
- first git pull latest version of the repo
- for each proxied page url (optionally recursing from root pages)
  - call /rewrite-page/url
  - save page content as static asset
  - fetch and save top-level resources as static assets
  - invoke puppeteer on the proxied page (freshly rewritten static HTML)
  - detect missing (proxied) 2nd-level resources e.g. fonts
  - save those as static assets as well
  - invoke proxied page again to validate no missing resources
- if script ran without errors and made changes
  - git commit changes and git push repo
  - re-deploy proxy worker

### Known issues, TODOs
- log to R2, stream logs back to user
- 