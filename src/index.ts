import { env } from 'cloudflare:workers'

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

        const collector = new ResourceCollector()
        const rewritten = await rewriteHtml(resp, collector)

        if (htmlJson) {
          // don't stream back - need all resources to be collected
          const html = await rewritten.text()
          return Response.json({ html, resources: collector.resources })
        }
        return new Response(rewritten.body, { headers: { 'content-type': contentType } })
      }

      console.log(req.method, source, 'simple proxy', Object.fromEntries(req.headers.entries()))
      return resp
    } catch (error) {
      console.error(error)
      return new Response(String(error), { status: 500 })
    }
  }
} satisfies ExportedHandler<Env>

async function rewriteHtml(resp: Response, collector: ResourceCollector): Promise<Response> {
  const handler = new UrlRewriteHandler(collector)

  const rewriter = new HTMLRewriter()
    .on('a[href], link[href]', handler)
    .on('img[src], img[srcset], img[data-src], img[data-srcset]', handler)
    .on('script[src]', handler)
    .on('source[src], source[srcset]', handler)
    .on('video[poster], video[src]', handler)
    .on('audio[src]', handler)
    .on('form[action]', handler)

  return rewriter.transform(resp)
}

type ResourceInfo = {
  url: string
  type: 'image' | 'script' | 'style' | 'srcset'
}

class ResourceCollector {
  resources: ResourceInfo[] = []
  private seen = new Set<string>()

  add(url: string, type: ResourceInfo['type']) {
    if (!url || this.seen.has(url)) return
    try {
      const parsed = new URL(url, PROXY_ORIGIN)
      if (parsed.origin === PROXY_ORIGIN) {
        this.seen.add(url)
        this.resources.push({ url: parsed.pathname + parsed.search, type })
      }
    } catch {
      // ignore invalid URLs
    }
  }

  addSrcset(srcset: string) {
    for (const part of srcset.split(',')) {
      const url = part.trim().split(/\s+/)[0]
      if (url) this.add(url, 'srcset')
    }
  }
}

class UrlRewriteHandler {
  constructor(private collector: ResourceCollector) {}

  element(el: Element) {
    const tag = el.tagName.toLowerCase()

    const href = el.getAttribute('href')
    if (href) {
      if (tag === 'link') {
        const rel = el.getAttribute('rel')
        if (rel?.includes('stylesheet')) {
          this.collector.add(href, 'style')
        } else if (rel?.includes('icon') || rel?.includes('preload')) {
          const as = el.getAttribute('as')
          if (as === 'image') this.collector.add(href, 'image')
          else if (as === 'script') this.collector.add(href, 'script')
          else if (as === 'style') this.collector.add(href, 'style')
        }
      }
      el.setAttribute('href', rewriteUrl(href))
    }

    const src = el.getAttribute('src')
    if (src) {
      if (tag === 'img') this.collector.add(src, 'image')
      else if (tag === 'script') this.collector.add(src, 'script')
      el.setAttribute('src', rewriteUrl(src))
    }

    const srcset = el.getAttribute('srcset')
    if (srcset) {
      this.collector.addSrcset(srcset)
      el.setAttribute('srcset', rewriteUrl(srcset))
    }

    const dataSrc = el.getAttribute('data-src')
    if (dataSrc) {
      this.collector.add(dataSrc, 'image')
      el.setAttribute('data-src', rewriteUrl(dataSrc))
    }

    const dataSrcset = el.getAttribute('data-srcset')
    if (dataSrcset) {
      this.collector.addSrcset(dataSrcset)
      el.setAttribute('data-srcset', rewriteUrl(dataSrcset))
    }

    const action = el.getAttribute('action')
    if (action) {
      el.setAttribute('action', rewriteUrl(action))
    }

    const poster = el.getAttribute('poster')
    if (poster) {
      this.collector.add(poster, 'image')
      el.setAttribute('poster', rewriteUrl(poster))
    }
  }
}

function rewriteUrl(value: string): string {
  return value.replace(quoteRE(PROXY_ORIGIN), '/').replace(quoteRE2(PROXY_ORIGIN), '/')
}

function quoteRE(str: string): RegExp {
  return new RegExp(str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g')
}

function quoteRE2(str: string): RegExp {
  return new RegExp(quoteRE(str).source.replace(/https:\/\//, 'https:\\\\/\\\\/'), 'g')
}
