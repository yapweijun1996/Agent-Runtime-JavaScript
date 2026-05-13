import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const outDir = join(root, "_site");

async function copyPath(from, to) {
  await cp(join(root, from), join(outDir, to), {
    dereference: true,
    errorOnExist: false,
    force: true,
    recursive: true
  });
}

async function writeText(path, content) {
  await mkdir(dirname(join(outDir, path)), { recursive: true });
  await writeFile(join(outDir, path), content, "utf8");
}

function landingPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>agrun.js</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.5;
      }
      body {
        margin: 0;
        background: Canvas;
        color: CanvasText;
      }
      main {
        width: min(920px, calc(100% - 32px));
        margin: 0 auto;
        padding: 56px 0;
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(2rem, 6vw, 4rem);
        line-height: 1;
      }
      p {
        max-width: 64ch;
        margin: 0 0 28px;
        color: color-mix(in srgb, CanvasText 72%, transparent);
        font-size: 1.0625rem;
      }
      nav {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }
      a {
        min-height: 112px;
        border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
        border-radius: 8px;
        padding: 18px;
        color: inherit;
        text-decoration: none;
        background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
      }
      a:focus-visible,
      a:hover {
        outline: 2px solid Highlight;
        outline-offset: 2px;
      }
      strong {
        display: block;
        margin-bottom: 8px;
        font-size: 1rem;
      }
      span {
        color: color-mix(in srgb, CanvasText 68%, transparent);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>agrun.js</h1>
      <p>Static distribution bundle for the JavaScript agent runtime, including the UMD runtime, generated docs, changelog, and browser example.</p>
      <nav aria-label="Published artifacts">
        <a href="./example/"><strong>Browser example</strong><span>Open the static React workspace demo.</span></a>
        <a href="./agrun.md"><strong>Distribution docs</strong><span>Start with the generated usage and API index.</span></a>
        <a href="./agrun.js"><strong>Runtime bundle</strong><span>Download or inspect the UMD runtime file.</span></a>
        <a href="./CHANGELOG.md"><strong>Changelog</strong><span>Review release notes and unreleased changes.</span></a>
      </nav>
    </main>
  </body>
</html>
`;
}

async function rewriteExampleForPages() {
  const indexPath = join(outDir, "example/index.html");
  const html = await readFile(indexPath, "utf8");
  await writeFile(
    indexPath,
    html
      .replaceAll('href="/favicon.svg"', 'href="./favicon.svg"')
      .replaceAll('src="/assets/', 'src="./assets/')
      .replaceAll('href="/assets/', 'href="./assets/'),
    "utf8"
  );

  const jsPath = join(outDir, "example/assets/index-J-Ep46YO.js");
  const js = await readFile(jsPath, "utf8");
  await writeFile(
    jsPath,
    js.replaceAll('"/skills/manifest.json"', '"./skills/manifest.json"'),
    "utf8"
  );
}

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });

await Promise.all([
  copyPath("agrun.js", "agrun.js"),
  copyPath("agrun.md", "agrun.md"),
  copyPath("CHANGELOG.md", "CHANGELOG.md"),
  copyPath("agrun_docs", "agrun_docs"),
  copyPath("example", "example")
]);

await writeText(".nojekyll", "");
await writeText("index.html", landingPage());
await rewriteExampleForPages();

console.log(`Built GitHub Pages artifact at ${outDir}`);
