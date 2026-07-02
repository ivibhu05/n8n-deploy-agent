#!/usr/bin/env node
/**
 * Content Deploy Agent — CLI
 *
 * markdown → standalone HTML or Next.js App Router page (gpt-4o-mini) → committed
 * directly to a target GitHub repo/branch. Core logic lives in lib.js (shared with
 * server.js).
 *
 * Usage:
 *   node deploy.js --content article.md --repo owner/site --path blog/my-post.html
 *   node deploy.js --content article.md --repo owner/next --format next-tsx --path-prefix app/blog/
 *   node deploy.js --content article.md --target grynow        # deploy.config.json
 *   node deploy.js --content article.md --dry-run              # render to ./out/, no push
 *
 * Env (.env): OPENAI_API_KEY, GITHUB_TOKEN
 */
const fs = require("fs");
const path = require("path");
const { publish, loadTarget } = require("./lib");

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : fallback;
}
const has = (name) => args.includes(name);

if (has("--help") || args.length === 0) {
  console.log(
    [
      "Content Deploy Agent — markdown → HTML | next-tsx (gpt-4o-mini) → GitHub commit",
      "",
      "Required:",
      "  --content <file.md>        Markdown article to publish",
      "  --repo <owner/name>        Target GitHub repo (or use --target)",
      "",
      "Target path (one of):",
      "  --path <repo/path>         Exact destination path in the repo",
      "  --slug <slug>              Filename from slug (default: slug from the H1)",
      "  --path-prefix <dir/>       Folder prefix used with --slug",
      "",
      "Optional:",
      "  --format <html|next-tsx>   Output format (default: html)",
      "  --branch <name>            Target branch (default: main)",
      "  --target <name>            Named target from deploy.config.json",
      "  --config <file>            Config file (default: ./deploy.config.json)",
      "  --site-name <name>         Used in OG tags / schema",
      "  --url <canonical-url>      Canonical / og:url for the page",
      "  --message <msg>            Commit message",
      "  --dry-run                  Render to ./out/ only; no push",
      "",
      "Style matching (match the target site's CSS/chrome):",
      "  --style-from <repo/path>   Existing page to mirror (default: auto-detect)",
      "  --no-style                 Render a generic standalone page instead",
      "  --no-index                 Skip adding a card to the blog listing page",
      "",
      "Auth (per-site token):",
      "  --token-env <VAR>          Env var holding this site's token (else GITHUB_TOKEN)",
      "",
      "Env: OPENAI_API_KEY, GITHUB_TOKEN (or a per-site token via --token-env / tokenEnv)",
    ].join("\n"),
  );
  process.exit(0);
}

async function main() {
  const targetName = flag("--target");
  const base = targetName ? loadTarget(targetName, flag("--config")) : {};

  const contentFile = flag("--content");
  if (!contentFile) throw new Error("Missing --content <file.md>");
  if (!fs.existsSync(contentFile)) {
    throw new Error(`Content file not found: ${contentFile}`);
  }

  const markdown = fs.readFileSync(contentFile, "utf-8");
  const stem = path.basename(contentFile).replace(/\.md$/i, "");

  const opts = {
    markdown,
    stem,
    format: flag("--format", base.format || "html"),
    repo: flag("--repo", base.repo),
    branch: flag("--branch", base.branch || "main"),
    path: flag("--path", base.path),
    pathPrefix: flag("--path-prefix", base.pathPrefix),
    slug: flag("--slug"),
    siteName: flag("--site-name", base.siteName),
    url: flag("--url", base.url),
    message: flag("--message"),
    dryRun: has("--dry-run"),
    tokenEnv: flag("--token-env", base.tokenEnv),
    styleFrom: flag("--style-from", base.referencePath),
    noStyle: has("--no-style") || base.noStyle === true,
    index: has("--no-index") ? undefined : base.index,
  };

  console.log(`\n=== Deploy: ${contentFile} ===`);
  console.log(`Format: ${opts.format}`);
  console.log(
    `Target: ${opts.repo || "(dry-run)"} @ ${opts.branch} (${opts.dryRun ? "dry-run" : "commit"})`,
  );
  console.log(`\nRendering with gpt-4o-mini...`);

  const r = await publish(opts);
  console.log(`✓ Rendered ${opts.format} (${r.bytes} chars) → ${r.repoPath}`);
  if (r.canonicalUrl) console.log(`  Canonical: ${r.canonicalUrl}`);
  console.log(
    r.referencePath
      ? `  Style: matched ${r.referencePath}`
      : `  Style: generic (no reference page used)`,
  );
  if (r.dryRunFile) {
    console.log(`[dry-run] Wrote ${r.dryRunFile} — no push.`);
    if (r.indexDryRunFile)
      console.log(
        `[dry-run] Index card → ${r.indexDryRunFile} (${r.cardLink})`,
      );
    console.log("");
  } else {
    console.log(`✓ Committed (${(r.committed.sha || "").slice(0, 7)}).`);
    if (r.committed.url) console.log(`  ${r.committed.url}`);
    if (r.indexCommitted)
      console.log(
        `✓ Listing card added to ${r.indexPath} (${(r.indexCommitted.sha || "").slice(0, 7)}) → ${r.cardLink}`,
      );
    else if (r.indexError)
      console.log(`⚠ Listing card NOT added: ${r.indexError}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error(
    "Deploy error:",
    err.status ? `${err.status} ` : "",
    err.message,
  );
  process.exit(1);
});
