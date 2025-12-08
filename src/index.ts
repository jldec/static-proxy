export interface HtmlObj {
  path: string
  html?: string
}

export interface HtmlJsonResponse {
  html: HtmlObj[]
  resources: string[]
  pages: string[]
}

export interface ProxyCaptureResources {
  resources: string[]
}

let proxyCaptureResources = new Set<string>()

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url)
    const path = url.pathname
    const proxyOrigin = url.searchParams.get('proxy-origin') || env.PROXY_ORIGIN
    if (!proxyOrigin) {
      return new Response('Proxy origin is required', { status: 400 })
    }
    const rewriteOrigin = url.searchParams.get('rewrite-origin') || env.REWRITE_ORIGIN || proxyOrigin

    // html-json mode
    if (path.startsWith('/html-json/')) {
      const resources = new Set<string>()
      const pages = new Set<string>()

      const encoder = new TextEncoder()
      const { readable, writable } = new TransformStream<string, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(encoder.encode(chunk))
        }
      })
      const writer = writable.getWriter()

      // default to just the current path
      let rewritePaths = [path.slice('/html-json'.length)]
      const pathsParam = url.searchParams.get('rewrite-paths')
      if (pathsParam) {
        rewritePaths = pathsParam.split(',')
      } else if (env.REWRITE_PATHS) {
        rewritePaths = env.REWRITE_PATHS
      }

      ctx.waitUntil(
        (async () => {
          try {
            await writer.write('{"html":[\n')
            for (let index = 0; index < rewritePaths.length; index++) {
              const path = rewritePaths[index]
              const proxyUrl = new URL(path, proxyOrigin).toString()
              const response = await fetch(proxyUrl)
              const contentType = response.headers.get('content-type')
              const htmlObj: HtmlObj = { path }
              if (response.ok && contentType?.includes('text/html')) {
                console.log(`rewriting ${path}`)
                const rewrittenResp = capturingRewriter(rewriteOrigin, resources, pages).transform(response)
                htmlObj.html = await rewrittenResp.text()
              } else {
                console.log(`rewrite failed: ${req.method} ${proxyUrl} ${response.status} ${contentType}`)
              }
              await writer.write(JSON.stringify(htmlObj, null, 2))
              if (index < rewritePaths.length - 1) {
                await writer.write(',\n')
              }
            }
            await writer.write('\n]')
            await writer.write(',\n"resources":\n')
            await writer.write(JSON.stringify(Array.from(resources), null, 2))
            await writer.write(',\n"pages":\n')
            await writer.write(JSON.stringify(Array.from(pages), null, 2))
            await writer.write('\n}\n')
          } catch (error) {
            console.error(`Error rewriting ${path}: ${error}`)
          } finally {
            await writer.close()
          }
        })()
      )
      return new Response(readable, { headers: { 'content-type': 'application/json' } })
    }

    if (path === '/reset-proxy-capture') {
      proxyCaptureResources = new Set<string>()
      return new Response('Proxy capture mode reset\n')
    }

    if (path === '/proxy-capture') {
      return new Response(JSON.stringify({ resources: Array.from(proxyCaptureResources) }, null, 2), {
        headers: { 'content-type': 'application/json' }
      })
    }

    // vanilla proxy mode
    const proxyUrl = new URL(path + url.search, proxyOrigin).toString()
    try {
      // pass headers and method - using req as fetch options breaks follow-redirects
      const response = await fetch(proxyUrl, { headers: req.headers, method: req.method })
      const contentType = response.headers.get('content-type')
      // proxy all non-HTML responses including 304 and errors
      if (!response.ok || !contentType?.includes('text/html')) {
        console.log(`PROXY: ${req.method} ${proxyUrl} ${response.status} ${contentType}`)
        if (response.ok || response.status === 304) {
          proxyCaptureResources.add(path + url.search)
        }
        return response
      }
      const rewrittenResp = capturingRewriter(rewriteOrigin).transform(response)
      return new Response(rewrittenResp.body, { headers: { 'content-type': contentType } })
    } catch (error) {
      console.error(`Error fetching ${proxyUrl}: ${error}`)
      return new Response(String(error), { status: 500 })
    }
  }
}

// HTMLRewriter
// https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/
// https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/#selectors
// https://developers.cloudflare.com/workers/examples/rewrite-links/
// https://blog.cloudflare.com/introducing-htmlrewriter/
// https://blog.cloudflare.com/html-parsing-1/
// https://blog.cloudflare.com/html-parsing-2/
// https://github.com/cloudflare/lol-html
// https://docs.rs/lol_html/latest/lol_html/struct.Selector.html#supported-selector
//
// rewrite URLs to remove rewriteOrigin
// capture resources (images, scripts, stylesheets)
// capture links to other pages
function capturingRewriter(rewriteOrigin: string, resources = new Set<string>(), pages = new Set<string>()) {
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

  // remove origin from urls, with or without escaped /
  // see below for usage examples
  function rewriteUrls(url: string) {
    const search1 = rewriteOrigin
    const search2 = rewriteOrigin.replaceAll('/', '\\/')
    return url.replaceAll(search1, '').replaceAll(search2, '')
  }

  // capture links to other pages on the same origin
  function anchorHref(): HTMLRewriterElementContentHandlers {
    return {
      element(el: Element) {
        const href = el.getAttribute('href')
        if (href) {
          try {
            // capture relative urls as well as absolute
            const parsed = new URL(href, rewriteOrigin)
            if (parsed.origin === rewriteOrigin) {
              pages.add(parsed.pathname + parsed.search)
              el.setAttribute('href', rewriteUrls(href))
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
      const parsed = new URL(url, rewriteOrigin)
      if (parsed.origin === rewriteOrigin) {
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
