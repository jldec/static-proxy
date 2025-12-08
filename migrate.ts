/*
# migrate.ts
This script works with bun or nodejs.
Populates /public directory with static assets based on output of /html-json/ and /proxy-capture.

```sh
curl http://localhost:3000/html-json/ > out.json
bun migrate.ts

# modify OUTFILE = out2.json below (TODO: make this a command line argument)
curl http://localhost:3000/reset-proxy-capture
# use browser to trigger missing resources
curl http://localhost:3000/proxy-capture > out2.json
bun migrate.ts
```

## ampcode thread:
- https://ampcode.com/threads/T-fd437bac-b100-4b6e-9a1f-c92e7a8f1f0c
- read file `out.json` (typescript JSON format can be imported with `import HtmlJsonResponse from src/index.ts` 
- for each htmlObj in HtmlJsonResponse.html write into a file into /public/... using htmlObj.path as the filename
  if the path has no extension, add .html
  if the path ends in a /, use the path as a folder path (mkdirp), and add index.html
- for each resource in HtmlJsonResponse.resources, fetch the resource from PROXY_ORIGIN + resource.path and write it to a file with the same name as resource.path (without query params).
- don't fetch concurrently (do one at a time)
- ignore HtmlJsonResponse.pages
*/

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { HtmlJsonResponse } from "./src/index"

const PROXY_ORIGIN = "http://localhost:3001"
const PUBLIC_DIR = "./public"
const OUTFILE = "./out2.json"

const json: HtmlJsonResponse = JSON.parse(await readFile(OUTFILE, "utf-8"))

for (const htmlObj of json.html || []) {
  let filePath = htmlObj.path
  if (filePath.endsWith("/")) {
    filePath = filePath + "index.html"
  } else if (!filePath.includes(".")) {
    filePath = filePath + ".html"
  }
  const fullPath = PUBLIC_DIR + filePath
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, htmlObj.html ?? "")
  console.log(`Wrote ${fullPath}`)
}

for (const resourcePath of json.resources || []) {
  const pathWithoutQuery = resourcePath.split("?")[0]
  const url = PROXY_ORIGIN + resourcePath
  console.log(`Fetching ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    console.error(`Failed to fetch ${url}: ${response.status}`)
    continue
  }
  const fullPath = PUBLIC_DIR + pathWithoutQuery
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, Buffer.from(await response.arrayBuffer()))
  console.log(`Wrote ${fullPath}`)
}
