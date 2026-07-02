# Content Deploy Agent

A small, **generic** deployment agent: give it a markdown article, it uses OpenAI
**`gpt-4o-mini`** to render a complete **standalone HTML page** (semantic markup,
`<title>`, meta description, Open Graph, Twitter card, JSON-LD Article schema),
then **commits the `.html` directly** to a target GitHub repo/branch (auto-publish).

Nothing is hardcoded to a specific site — the target repo/branch/path is supplied
per run, or via named targets in `deploy.config.json`. Works for any GitHub repo.

## Setup

```bash
npm install
cp .env.example .env        # add OPENAI_API_KEY and GITHUB_TOKEN
```

`GITHUB_TOKEN` needs `contents:write` on the target repo(s) (a fine-grained PAT
scoped to those repos is ideal).

## Usage

```bash
# Explicit target path
node deploy.js --content article.md --repo owner/site --path blog/my-post.html

# Derive filename from a slug (+ optional folder prefix)
node deploy.js --content article.md --repo owner/site --slug my-post --path-prefix blog/

# Named target from deploy.config.json
node deploy.js --content article.md --target grynow

# Render only — writes HTML to ./out/, no push (no GitHub token needed)
node deploy.js --content examples/sample-article.md --dry-run
```

### Flags

| Flag | Purpose |
|---|---|
| `--content <file.md>` | Markdown article to publish (required) |
| `--repo <owner/name>` | Target GitHub repo (or use `--target`) |
| `--path <repo/path.html>` | Exact destination path in the repo |
| `--slug <slug>` / `--path-prefix <dir/>` | Build the path from a slug (defaults to a slug from the H1) |
| `--format <html\|next-tsx>` | Output format (default `html`) — see below |
| `--branch <name>` | Target branch (default `main`) |
| `--target <name>` / `--config <file>` | Use a named target from `deploy.config.json` |
| `--site-name`, `--url` | Feed OG tags / schema / canonical URL |
| `--message <msg>` | Commit message |
| `--dry-run` | Render to `./out/` only |

### SEO Agent passthrough (webhook / programmatic)

When an upstream SEO agent has already decided the page's metadata, pass it so the
renderer uses those exact values instead of improvising. All optional, all honored by
both `html` and `next-tsx` formats:

| Field | Effect |
|---|---|
| `metaTitle` | verbatim `<title>` / `og:title` / `twitter:title` |
| `metaDescription` | verbatim meta description / `og:description` / `twitter:description` |
| `canonical` | exact canonical URL (overrides the URL derived from `url` + path) |
| `schemaTypes` (array) | which JSON-LD schema.org types to emit (e.g. `["Article","FAQPage"]`) |
| `thumbnail` | image URL for `og:image` / `twitter:image` and the blog-index card |

## Output formats (per target)

Different sites consume content differently, so each target declares a `format`
(in `deploy.config.json`, or via `--format`):

| `format` | Writes | Path convention | Use for |
|---|---|---|---|
| `html` (default) | full standalone HTML page (gpt-4o-mini renders semantic HTML + meta/OG/JSON-LD) | `<prefix><slug>.html` | plain static-HTML sites |
| `next-tsx` | a Next.js App Router page component (`metadata` export + JSX body) | `<prefix><slug>/page.tsx` | Next.js sites using `app/blog/<slug>/page.tsx` |

```bash
# Next.js App Router target
node deploy.js --content article.md --repo owner/next-site \
  --format next-tsx --path-prefix app/blog/
```

## How it fits a content pipeline

Decoupled by design: anything that can produce an approved markdown article can call
this. From the n8n SEO pipeline, run it after approval via an **Execute Command** node
(or wrap `deploy.js` in a thin webhook). It takes the markdown as input and handles
HTML rendering + publishing.

## Notes

- **Auto-publish:** commits land directly on the target branch — there is no PR/review
  step by design. Point `--branch` at a staging branch if you want a gate.
- The model is instructed to preserve content faithfully and not invent facts, but
  LLM output should be spot-checked for important pages (use `--dry-run` first).
# n8n-deploy-agent
