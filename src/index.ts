import { env } from 'cloudflare:workers'

const SOURCE_ORIGIN = env.SOURCE_ORIGIN
const PROXY_ORIGIN = env.PROXY_ORIGIN

export default {
  async fetch(req) {
    const url = new URL(req.url)
    let sourcePath = url.pathname
    let htmlJson = false

    if (sourcePath.startsWith('/rewrite-page/')) {
      htmlJson = true
      sourcePath = sourcePath.slice('/rewrite-page'.length)
    }

    const source = new URL(PROXY_ORIGIN + sourcePath + url.search).toString()
    try {
      const resp = await fetch(source, req)
      if (!resp.ok) return new Response(await resp.text(), { status: resp.status })

      const contentType = resp.headers.get('content-type')
      if (contentType?.includes('text/html')) {
        console.log(req.method, source, 'rewriting HTML')

        const resources = new Set<string>()
        const pages = new Set<string>()
        const rewrittenResp = capturingRewriter(resources, pages).transform(resp)

        if (htmlJson) {
          const html = await rewrittenResp.text()
          return Response.json({ html, resources: [...resources], pages: [...pages] })
        }
        return new Response(rewrittenResp.body, { headers: { 'content-type': contentType } })
      }

      console.log(req.method, source, 'simple proxy')
      return resp
    } catch (error) {
      console.error(error)
      return new Response(String(error), { status: 500 })
    }
  }
} satisfies ExportedHandler<Env>

// HTMLRewriter
// https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/
// https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/#selectors
// https://developers.cloudflare.com/workers/examples/rewrite-links/
// https://blog.cloudflare.com/introducing-htmlrewriter/
// https://blog.cloudflare.com/html-parsing-1/
// https://blog.cloudflare.com/html-parsing-2/
// https://github.com/cloudflare/lol-html
// https://docs.rs/lol_html/latest/lol_html/struct.Selector.html#supported-selector

// rewrite URLs to remove source origin
// capture resources (images, scripts, stylesheets)
// capture links to other pages
function capturingRewriter(resources: Set<string>, pages: Set<string>) {
  return (
    new HTMLRewriter()
      // selectors should be as specific as possible
      // overlapping selectors like * trigger all handlers even if elements are removed in one
      .on('a[href]', anchorHref())
      .on('img[src]', fixImg())
      .on('form[action]', fixAttr('action'))
      .on('div[data-settings]', fixAttr('data-settings'))
      .on('link[rel="stylesheet"][href]', fixAttr('href', true))
      .on('link[rel*="icon"][href]', fixAttr('href', true))
      .on('meta[name="msapplication-TileImage"][content]', fixAttr('content', true))
      .on('script[src]', fixAttr('src', true))
      .on('script:not([src])', fixScript())
      // remove unwanted elements
      .on(
        `
        meta[name="generator"],
        link[rel="alternate"],
        link[rel="canonical"],
        link[rel="shortlink"],
        link[rel="EditURI"],
        link[rel="profile"],
        link[rel="https://api.w.org/"]`,
        {
          element(el: Element) {
            el.remove()
          }
        }
      )
  )

  function anchorHref(): HTMLRewriterElementContentHandlers {
    return {
      element(el: Element) {
        const href = el.getAttribute('href')
        if (href) {
          try {
            el.setAttribute('href', rewriteUrls(href))
            // capture relative urls as well as absolute
            const parsed = new URL(href, SOURCE_ORIGIN)
            if (parsed.origin === SOURCE_ORIGIN) {
              pages.add(parsed.pathname + parsed.search)
            }
          } catch {
            // ignore invalid URLs
            console.error(`Invalid URL: ${href}`)
          }
        }
      }
    }
  }

  // rewrite urls and capture resources for img src and srcsets which are hard to capture by other means - examples:
  // <img fetchpriority="high" width="412" height="256" src="https://futuremedia-concepts.com/wp-content/uploads/2025/03/fmc_logo_05.png" class="attachment-full size-full wp-image-14" alt="" srcset="https://futuremedia-concepts.com/wp-content/uploads/2025/03/fmc_logo_05.png 412w, https://futuremedia-concepts.com/wp-content/uploads/2025/03/fmc_logo_05-300x186.png 300w" sizes="(max-width: 412px) 100vw, 412px" />
  // <script src="https://futuremedia-concepts.com/wp-includes/js/dist/i18n.min.js?ver=5e580eb46a90c2b997e6" id="wp-i18n-js"></script>
  function fixImg(): HTMLRewriterElementContentHandlers {
    return {
      element(el: Element) {
        const src = el.getAttribute('src')
        if (src) {
          captureSrc(src)
          el.setAttribute('src', rewriteUrls(src))
        }
        const srcset = el.getAttribute('srcset')
        if (srcset) {
          captureSrcset(srcset)
          el.setAttribute('srcset', rewriteUrls(srcset))
        }
      }
    }
  }

  function captureSrc(url: string) {
    try {
      // capture relative urls as well as absolute
      const parsed = new URL(url, SOURCE_ORIGIN)
      if (parsed.origin === SOURCE_ORIGIN) {
        resources.add(parsed.pathname + parsed.search)
      }
    } catch {
      // ignore invalid URLs
      console.error(`Invalid URL: ${url}`)
    }
  }

  function captureSrcset(srcset: string) {
    for (const part of srcset.split(',')) {
      const url = part.trim().split(/\s+/)[0]
      if (url) captureSrc(url)
    }
  }

  // remove origin from urls, with or without escaped /
  function rewriteUrls(url: string) {
    const search1 = SOURCE_ORIGIN
    const search2 = SOURCE_ORIGIN.replaceAll('/', '\\/')
    return url.replaceAll(search1, '').replaceAll(search2, '')
  }

  // rewrite urls in HTML attributes, optionally capturing resources
  // example with / escaped url:
  // <div class="elementor-element... data-settings="{&quot;source_json&quot;:{&quot;url&quot;:&quot;https:\/\/futuremedia-concepts.com\/wp-content\/uploads\/2025\..">
  function fixAttr(attr: string, capture: boolean = false): HTMLRewriterElementContentHandlers {
    return {
      element(el: Element) {
        const value = el.getAttribute(attr)
        if (value) {
          el.setAttribute(attr, rewriteUrls(value))
          if (capture) captureSrc(value)
        }
      }
    }
  }

  // rewrite urls in inline scripts
  // example with / escaped url:
  // var ElementorProFrontendConfig = {"ajaxurl":"https:\/\/futuremedia-concepts.com\/wp-admin\/admin-ajax.php",...
  function fixScript(): HTMLRewriterElementContentHandlers {
    return {
      text(chunk) {
        // https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/#global-types
        chunk.replace(rewriteUrls(chunk.text), { html: true })
      }
    }
  }
}
