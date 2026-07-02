/**
 * Core deploy logic, shared by the CLI (deploy.js) and the webhook server
 * (server.js). Renders markdown → html | next-tsx via gpt-4o-mini and commits
 * the result directly to a GitHub repo/branch.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { Octokit } = require("@octokit/rest");

const MODEL = "gpt-4o-mini";
const FORMATS = ["html", "next-tsx"];

// Invalid caller input → HTTP 400 (vs. server faults, which stay 500). The
// server maps err.status < 500 to 400; the CLI just prints the message.
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function titleFromMarkdown(md, fallback) {
  const m = String(md).match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function postedOnTimeZone() {
  return process.env.POSTED_ON_TIMEZONE || process.env.TZ || "Asia/Kolkata";
}

function formatPostedOnDate(date = new Date()) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: postedOnTimeZone(),
  }).format(date);
}

function formatPostedOnIso(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: postedOnTimeZone(),
  }).format(date);
}

function stripCodeFence(text) {
  // Remove a wrapping ```lang ... ``` fence if the model adds one.
  return String(text)
    .replace(/^\s*```(?:[a-z]+)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

// Per-post canonical URL. opts.url is treated as the SITE base (often the blog
// section index, e.g. https://site.com/blog/); the served path mirrors the repo
// path on a static site, so the true per-post URL is repoPath resolved against
// the base's origin. For next-tsx we map the app-router file to its route
// (drop a leading app/ or src/app/ segment and the trailing page.tsx). Idempotent:
// passing an already-correct full post URL returns the same value.
function canonicalUrl(baseUrl, repoPath, format) {
  if (!baseUrl || !repoPath) return baseUrl || null;
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return baseUrl; // not a parseable URL — pass through untouched
  }
  let servedPath = String(repoPath).replace(/^\/+/, "");
  if (format === "next-tsx") {
    servedPath = servedPath
      .replace(/^src\/app\//, "")
      .replace(/^app\//, "")
      .replace(/\/?page\.tsx$/i, "/");
  }
  return new URL(servedPath, origin + "/").href;
}

function metaContext(meta) {
  return [
    meta.siteName ? `Site name: ${meta.siteName}` : null,
    meta.url
      ? `THIS page's own canonical URL — use it verbatim for <link rel="canonical">, ` +
        `og:url, twitter:url, and the u=/url= value of EVERY social share link ` +
        `(Facebook, LinkedIn, Twitter/X, WhatsApp): ${meta.url}`
      : null,
    meta.title ? `Article title (H1): ${meta.title}` : null,
    // SEO Agent authored these — use them EXACTLY, do not rewrite or improvise.
    meta.metaTitle
      ? `SEO meta title (use verbatim for <title> and og:title/twitter:title): ${meta.metaTitle}`
      : null,
    meta.metaDescription
      ? `SEO meta description (use verbatim for the meta description, og:description, ` +
        `twitter:description): ${meta.metaDescription}`
      : null,
    meta.thumbnail
      ? `Social/thumbnail image URL — use it for og:image, twitter:image, and any ` +
        `hero/thumbnail <img> the layout expects: ${meta.thumbnail}`
      : null,
    Array.isArray(meta.schemaTypes) && meta.schemaTypes.length
      ? `Emit JSON-LD covering these schema.org types (one <script type="application/ld+json"> ` +
        `each, or a @graph): ${meta.schemaTypes.join(", ")}. Populate FAQPage from the ` +
        `article's FAQ section when present.`
      : null,
    meta.postedOn
      ? `Posted on date for THIS deploy/post: ${meta.postedOn}. If the page has ` +
        `any visible "Posted on", "Published on", date badge, <time> element, ` +
        `Article schema datePublished/dateModified, or article metadata date, use this date ` +
        `for the new article. Do not copy a date from the reference page.`
      : null,
    meta.postedOnIso
      ? `Machine-readable publish date for THIS deploy/post: ${meta.postedOnIso}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function chat(system, markdown, meta, reference) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const ctx = metaContext(meta);
  const parts = [];
  if (ctx) parts.push(ctx);
  if (reference) {
    parts.push(
      "Reference page from the TARGET site — match its <head> links, CSS classes, " +
        "header/nav and footer (it may be truncated in the middle):\n\n" +
        reference,
    );
  }
  parts.push("Markdown article:\n\n" + markdown);
  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: parts.join("\n\n---\n\n") },
    ],
  });
  return stripCodeFence(res.choices[0].message.content || "");
}

const HTML_SYSTEM = [
  "You are a senior web producer. Convert the given markdown article into a single,",
  "complete, production-ready standalone HTML page. Requirements:",
  '- Start with <!doctype html>; include <html lang="en">, <head>, <body>.',
  "- <head>: <meta charset>, responsive viewport, a concise <title>, a meta",
  "  description (<= 160 chars), Open Graph tags (og:title, og:description,",
  "  og:type=article, og:url when a URL is given), a Twitter summary_large_image",
  "  card, and a JSON-LD <script> with Article schema.",
  '- When a canonical URL is given, add <link rel="canonical" href="THAT url"> and',
  "  set og:url / twitter:url to the SAME url. The canonical must be this page's own",
  "  URL — never a section index or a different page.",
  "- Semantic HTML5 (article, header, h1/h2/h3, p, ul/ol, figure). The H1 is the title.",
  "- A small, clean, responsive inline <style> block. No external CSS/JS, no tracking.",
  "- When a Posted on date is given, show it near the article heading as `Posted on DATE`,",
  '  use a matching <time datetime="YYYY-MM-DD">DATE</time> when possible, and',
  "  use the same deploy/post date for JSON-LD datePublished/dateModified.",
  "- Preserve all content faithfully; do not invent facts.",
  "- Output ONLY the raw HTML document. No markdown, no code fences, no commentary.",
].join("\n");

const NEXT_SYSTEM = [
  "You are a senior Next.js engineer. Convert the markdown article into a single",
  "Next.js App Router page component file (TypeScript, .tsx). Requirements:",
  '- import type { Metadata } from "next";',
  "- Export `export const metadata: Metadata = {...}` with title, description",
  "  (<= 160 chars) and openGraph { title, description, type: 'article', and url",
  "  when one is given). When a canonical URL is given, also set",
  "  `alternates: { canonical: '<that url>' }` (this page's own URL, not an index).",
  "  This is a Server Component — do NOT add 'use client'.",
  "- `export default function Page() { return (<article>...</article>); }` rendering",
  "  the full article as semantic JSX (h1 for the title, then h2/h3, p, ul/ol/li).",
  "- When a Posted on date is given, render it near the article heading as",
  '  `Posted on DATE`, preferably with <time dateTime="YYYY-MM-DD">DATE</time>,',
  "  and use the same deploy/post date in article metadata when applicable.",
  "- Plain JSX with semantic elements only. Do NOT assume Tailwind or any CSS",
  "  framework and do NOT import CSS. No external components or libraries.",
  "- Escape JSX correctly (apostrophes, braces, < and >). Preserve all content",
  "  faithfully; do not invent facts.",
  "- Output ONLY the raw .tsx file contents. No markdown, no fences, no commentary.",
].join("\n");

// Used when a reference page from the target site is supplied: clone the site's
// chrome and CSS instead of emitting a generic standalone page.
const HTML_TEMPLATE_SYSTEM = [
  "You are a senior web producer. You are given an EXISTING page from the target",
  "website (as a layout/style reference) and a markdown article. Produce a NEW,",
  "complete standalone HTML page for the article that visually matches the site:",
  "- Reproduce the reference's <head>: keep the SAME stylesheet <link>s, font links,",
  "  favicon and asset paths EXACTLY (same relative paths, e.g. ../css/...). Only",
  "  change <title>, the meta description, and the Open Graph / Twitter / JSON-LD",
  "  tags to describe the new article (og:type=article, og:url when a URL is given).",
  '- CRITICAL for SEO — the reference\'s <link rel="canonical"> points to the',
  "  REFERENCE's own URL. You MUST replace it with THIS article's canonical URL",
  "  (given above). Never leave it as the reference's URL and never point it at a",
  "  section/blog index. Set og:url and twitter:url to the same canonical URL.",
  "- CRITICAL — the reference's social share links (Facebook sharer u=, LinkedIn",
  "  shareArticle url=, Twitter/X intent url=, WhatsApp, etc.) contain the",
  "  REFERENCE's URL. Rewrite the u=/url= value in EVERY share link to THIS",
  "  article's canonical URL, URL-encoded, and set any share title/text param to",
  "  this article's title. Do not leave any share link pointing at the reference",
  "  or at a section index.",
  "- CRITICAL — if the reference has any visible Posted on / Published on date,",
  "  date badge, <time> element, Article schema datePublished/dateModified, or",
  "  article metadata date, replace it with THIS deploy/post date supplied above.",
  "  Never copy the reference article's old date.",
  "- Reproduce the site chrome: the SAME header/nav markup and the SAME footer markup",
  "  as the reference (including any component placeholder divs it uses), so the page",
  "  inherits the site's existing CSS and navigation.",
  "- Between header and footer, render the article using the SAME content-wrapper",
  "  elements and CSS class names the reference uses for its main/article content.",
  "- Use only assets and classes that appear in the reference. Do NOT add a new inline",
  "  <style> block unless the reference styles its content inline. Preserve the",
  "  article content faithfully; do not invent facts.",
  "- The reference may be truncated in the middle (a comment marks the gap); infer a",
  "  sensible closing structure.",
  "- Output ONLY the raw HTML document. No markdown, no code fences, no commentary.",
].join("\n");

const NEXT_TEMPLATE_SYSTEM = [
  "You are a senior Next.js engineer. You are given an EXISTING App Router page from",
  "the target site (as a reference) and a markdown article. Produce a NEW page.tsx",
  "for the article that matches the reference's conventions:",
  "- Reuse the SAME imports, wrapper components, layout elements and className",
  "  conventions the reference uses; do not introduce new component libraries.",
  "- Export `export const metadata: Metadata = {...}` (title, description <= 160 chars,",
  "  openGraph { title, description, type: 'article', url when given}), matching the",
  "  reference's metadata shape. When a canonical URL is given, set",
  "  `alternates: { canonical: '<that url>' }` to THIS page's own URL — replace any",
  "  canonical the reference carried; never reuse the reference's or a section index.",
  "  Server Component — no 'use client' unless the reference uses it.",
  "- If the reference has any visible Posted on / Published on date, date badge,",
  "  <time> element, or article metadata date, replace it with THIS deploy/post date",
  "  supplied above. Never copy the reference article's old date.",
  "- Render the full article as JSX using the reference's class/wrapper conventions.",
  "  Escape JSX correctly. Preserve content faithfully; do not invent facts.",
  "- Output ONLY the raw .tsx file contents. No markdown, no fences, no commentary.",
].join("\n");

async function renderContent(format, markdown, meta, reference) {
  const system =
    format === "next-tsx"
      ? reference
        ? NEXT_TEMPLATE_SYSTEM
        : NEXT_SYSTEM
      : reference
        ? HTML_TEMPLATE_SYSTEM
        : HTML_SYSTEM;
  return chat(system, markdown, meta, reference);
}

const CARD_SYSTEM = [
  "You are given one or more EXAMPLE blog-listing cards from a website, plus the",
  "details of a NEW post. Produce exactly ONE new card block for the new post,",
  "using the SAME HTML structure, tags and CSS class names as the examples.",
  "- Use these exact values: the post link href = the given LINK (in EVERY place the",
  "  card links to the post), the card heading text = the given TITLE, the",
  "  description paragraph = the given DESCRIPTION, the image src/data-src = the given",
  "  THUMB, and the image alt text = the given TITLE.",
  "- Keep every other class, attribute and wrapper identical to the examples (same",
  "  lazyload/data-src convention, same column wrapper). Do not add or drop elements.",
  "- If the examples contain any visible Posted on / Published on date, date badge,",
  "  <time> element, or datetime attribute, use the given POSTED_ON / POSTED_ON_ISO",
  "  values for the new card. Never copy the example card's old date.",
  "- Output ONLY the raw HTML for the single card block. No markdown, no code fences,",
  "  no commentary.",
].join("\n");

// Generate one listing card that mirrors the example card markup.
async function renderCard({
  examples,
  link,
  title,
  description,
  thumb,
  postedOn,
  postedOnIso,
}) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const user =
    "Example card(s):\n\n" +
    examples +
    "\n\n---\n\nNew post:\n" +
    `LINK: ${link}\n` +
    `TITLE: ${title}\n` +
    `DESCRIPTION: ${description}\n` +
    `THUMB: ${thumb}\n` +
    `POSTED_ON: ${postedOn || ""}\n` +
    `POSTED_ON_ISO: ${postedOnIso || ""}`;
  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: CARD_SYSTEM },
      { role: "user", content: user },
    ],
  });
  return stripCodeFence(res.choices[0].message.content || "");
}

// Pull a short card description from the rendered output (its meta description),
// falling back to the first real paragraph of the markdown.
function cardDescription(rendered, format, markdown) {
  let desc = "";
  if (format === "next-tsx") {
    const m = rendered.match(/description:\s*["']([^"']+)["']/);
    desc = m ? m[1] : "";
  } else {
    const m = rendered.match(
      /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
    );
    desc = m ? m[1] : "";
  }
  if (!desc) {
    const para = String(markdown)
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("#") && !s.startsWith("-"));
    desc = (para || "").replace(/\s+/g, " ").slice(0, 160);
  }
  return desc;
}

function resolveRepoPath({
  format,
  path: explicit,
  pathPrefix,
  slug,
  title,
  stem,
}) {
  if (explicit) return explicit;
  const prefix = pathPrefix || "";
  const s = slugify(slug || title || stem || "post");
  return format === "next-tsx"
    ? `${prefix}${s}/page.tsx`
    : `${prefix}${s}.html`;
}

function loadTarget(name, configPath) {
  const file = configPath || path.resolve(process.cwd(), "deploy.config.json");
  if (!fs.existsSync(file)) throw new Error(`config not found: ${file}`);
  const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
  const target = (cfg.targets || {})[name];
  if (!target) throw new Error(`target "${name}" not in ${file}`);
  return { ...(cfg.defaults || {}), ...target };
}

// Per-site token: an explicit opts.token wins, then the env var named by the
// target's `tokenEnv` (so each site keeps its own token), then global GITHUB_TOKEN.
function resolveToken(opts) {
  if (opts.token) return opts.token;
  if (opts.tokenEnv && process.env[opts.tokenEnv]) {
    return process.env[opts.tokenEnv];
  }
  return process.env.GITHUB_TOKEN || "";
}

function ghClient(token) {
  return new Octokit({ auth: token });
}

// Read a single file from the repo; returns its text, or null if it's missing
// (404) or a directory.
async function fetchFile(octokit, owner, repo, branch, filePath) {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branch,
    });
    if (Array.isArray(data) || !data.content) return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// Choose an existing page to mirror: an explicit styleFrom path, otherwise the
// first sibling file (same folder as the target) of the right kind. next-tsx
// pages live in per-slug folders, so auto-detect only applies to html.
async function pickReferencePath(octokit, owner, repo, branch, opts) {
  if (opts.styleFrom) return opts.styleFrom;
  if (opts.format === "next-tsx") return null;
  const dir = path.posix.dirname(opts.repoPath);
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: dir === "." ? "" : dir,
      ref: branch,
    });
    if (!Array.isArray(data)) return null;
    const hit = data.find(
      (f) =>
        f.type === "file" &&
        f.path !== opts.repoPath &&
        f.name.toLowerCase().endsWith(".html"),
    );
    return hit ? hit.path : null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// Real site pages can be huge; keep the head + the head/tail of the body (which
// hold the chrome we need to mirror) and drop the repetitive middle.
function trimReference(
  html,
  { headMax = 7000, bodyHeadMax = 9000, bodyTailMax = 6000 } = {},
) {
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [""])[0].slice(
    0,
    headMax,
  );
  const body = (html.match(/<body[\s\S]*?<\/body>/i) || [html])[0];
  if (body.length <= bodyHeadMax + bodyTailMax) {
    return head ? head + "\n\n" + body : body;
  }
  const top = body.slice(0, bodyHeadMax);
  const tail = body.slice(-bodyTailMax);
  return (
    (head ? head + "\n\n" : "") +
    top +
    "\n\n<!-- … middle content omitted; footer/closing structure below … -->\n\n" +
    tail
  );
}

async function commitToGitHub({
  octokit,
  owner,
  repo,
  branch,
  repoPath,
  content,
  message,
}) {
  let sha;
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: repoPath,
      ref: branch,
    });
    if (!Array.isArray(data)) sha = data.sha;
  } catch (err) {
    if (err.status !== 404) throw err; // 404 = new file
  }
  const res = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: repoPath,
    branch,
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    sha,
  });
  return { url: res.data.content?.html_url, sha: res.data.commit?.sha };
}

/**
 * Build the listing page with a new card inserted newest-first, so a deployed
 * post is linked from the blog index. Returns the updated index HTML + the card,
 * or null if the anchor isn't found. Does not commit.
 *   index: { path, cardAnchor, linkPrefix?, thumbnail? }
 *   post:  { repoPath, title, description }
 */
async function buildIndexUpdate(indexHtml, index, post) {
  const anchor = index.cardAnchor;
  if (!anchor)
    throw badRequest("index.cardAnchor is required to insert a card");
  const at = indexHtml.indexOf(anchor);
  if (at === -1) return null; // anchor not present — skip rather than corrupt

  // A couple of existing cards as the markup model for the LLM.
  const examples = indexHtml.slice(at, at + 2600);
  const link = (index.linkPrefix || "./") + post.repoPath;
  // Prefer the post's own thumbnail (from the Thumbnail Agent), then a per-target
  // default, then the conventional per-slug path.
  const thumb =
    post.thumbnail ||
    index.thumbnail ||
    `./assets/blog/${post.repoPath.replace(/^.*\//, "").replace(/\.[^.]+$/, "")}/thumbnail.webp`;

  const card = await renderCard({
    examples,
    link,
    title: post.title,
    description: post.description,
    thumb,
    postedOn: post.postedOn,
    postedOnIso: post.postedOnIso,
  });
  if (!card || !card.includes(link)) return null; // model didn't produce a usable card

  // Insert before the first existing card, matching its line indentation.
  const lineStart = indexHtml.lastIndexOf("\n", at) + 1;
  const indent = indexHtml.slice(lineStart, at);
  const updated =
    indexHtml.slice(0, at) +
    card.trim() +
    "\n\n" +
    indent +
    indexHtml.slice(at);
  return { updated, card, link };
}

/**
 * High-level publish used by both CLI and server.
 * opts: { markdown, format?, repo?, branch?, path?, pathPrefix?, slug?, title?,
 *         stem?, siteName?, url?, message?, dryRun?, postedOn?, postedOnIso?,
 *         token?, tokenEnv?, styleFrom?, noStyle? }
 * Per-site auth: opts.token, else env[opts.tokenEnv], else GITHUB_TOKEN.
 * Style: unless noStyle, mirrors an existing page (styleFrom, else auto-detected
 * from the target folder) so output matches the site's CSS/chrome.
 * returns { format, repoPath, bytes, referencePath?, committed?{url,sha}, dryRunFile? }
 */
async function publish(opts) {
  const format = (opts.format || "html").toLowerCase();
  if (!FORMATS.includes(format)) {
    throw badRequest(
      `format must be one of ${FORMATS.join(" | ")}, got: ${format}`,
    );
  }
  const markdown = opts.markdown;
  if (!markdown || !String(markdown).trim())
    throw badRequest("markdown is required");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const branch = opts.branch || "main";
  const title = opts.title || titleFromMarkdown(markdown, opts.slug || "post");
  const repoPath = resolveRepoPath({
    format,
    path: opts.path,
    pathPrefix: opts.pathPrefix,
    slug: opts.slug,
    title,
    stem: opts.stem,
  });
  const postedOnDate = new Date();
  const postedOn =
    opts.postedOn || opts.publishDate || formatPostedOnDate(postedOnDate);
  const postedOnIso =
    opts.postedOnIso || opts.publishDateIso || formatPostedOnIso(postedOnDate);

  // Resolve the target repo + that site's token up front: we need both to read a
  // style reference and to commit.
  const token = resolveToken(opts);
  let owner, repo, octokit;
  if (opts.repo) {
    [owner, repo] = String(opts.repo).split("/");
    if (!owner || !repo)
      throw badRequest(`repo must be "owner/name", got: ${opts.repo}`);
    if (token) octokit = ghClient(token);
  }

  // Read an existing page from the target site to mirror its design.
  let reference = null;
  let referencePath = null;
  if (!opts.noStyle && octokit) {
    referencePath = await pickReferencePath(octokit, owner, repo, branch, {
      format,
      repoPath,
      styleFrom: opts.styleFrom || opts.referencePath,
    });
    if (referencePath) {
      const raw = await fetchFile(octokit, owner, repo, branch, referencePath);
      if (raw) {
        reference =
          format === "next-tsx" ? raw.slice(0, 20000) : trimReference(raw);
      } else {
        referencePath = null; // could not read it; render generically
      }
    }
  }

  // opts.url is the site/section base; derive THIS post's own canonical URL so
  // the canonical, og:url and share links point at the post (not the index).
  // An explicit opts.canonical (e.g. from the SEO Agent's brief) wins.
  const url = opts.canonical || canonicalUrl(opts.url, repoPath, format);

  const rendered = await renderContent(
    format,
    markdown,
    {
      siteName: opts.siteName,
      url,
      title,
      postedOn,
      postedOnIso,
      metaTitle: opts.metaTitle,
      metaDescription: opts.metaDescription,
      thumbnail: opts.thumbnail,
      schemaTypes: opts.schemaTypes,
    },
    reference,
  );
  const valid =
    format === "next-tsx"
      ? /export\s+default/.test(rendered)
      : /<html[\s>]/i.test(rendered);
  if (!rendered || !valid) {
    throw new Error(`model did not return a valid ${format} document`);
  }

  // Listing-page card: link the new post from the blog index (opt-in via config).
  const post = {
    repoPath,
    title,
    description: cardDescription(rendered, format, markdown),
    postedOn,
    postedOnIso,
    thumbnail: opts.thumbnail,
  };

  if (opts.dryRun) {
    const outFile = path.resolve(process.cwd(), "out", repoPath);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, rendered);
    const result = {
      format,
      repoPath,
      canonicalUrl: url,
      postedOn,
      postedOnIso,
      bytes: rendered.length,
      referencePath,
      dryRunFile: outFile,
    };
    // Preview the index update too, when a repo+token are available to read it.
    if (opts.index && opts.index.path && octokit) {
      const raw = await fetchFile(
        octokit,
        owner,
        repo,
        branch,
        opts.index.path,
      );
      const upd = raw && (await buildIndexUpdate(raw, opts.index, post));
      if (upd) {
        const idxOut = path.resolve(process.cwd(), "out", opts.index.path);
        fs.mkdirSync(path.dirname(idxOut), { recursive: true });
        fs.writeFileSync(idxOut, upd.updated);
        result.indexPath = opts.index.path;
        result.indexDryRunFile = idxOut;
        result.cardLink = upd.link;
      }
    }
    return result;
  }

  if (!opts.repo) throw badRequest("repo (owner/name) is required");
  if (!token)
    throw new Error(
      "no GitHub token (set GITHUB_TOKEN, the target's tokenEnv var, or pass token)",
    );

  const committed = await commitToGitHub({
    octokit,
    owner,
    repo,
    branch,
    repoPath,
    content: rendered,
    message: opts.message || `Publish: ${title} [deploy-agent]`,
  });

  // Add the listing card in a second commit. A failure here must not fail the
  // deploy — the post itself is already live — so surface it as indexError.
  const result = {
    format,
    repoPath,
    canonicalUrl: url,
    postedOn,
    postedOnIso,
    bytes: rendered.length,
    referencePath,
    committed,
  };
  if (opts.index && opts.index.path) {
    try {
      const raw = await fetchFile(
        octokit,
        owner,
        repo,
        branch,
        opts.index.path,
      );
      if (!raw) throw new Error(`index page not found: ${opts.index.path}`);
      const upd = await buildIndexUpdate(raw, opts.index, post);
      if (!upd) throw new Error("card anchor not found or card invalid");
      const idxCommit = await commitToGitHub({
        octokit,
        owner,
        repo,
        branch,
        repoPath: opts.index.path,
        content: upd.updated,
        message: `Add blog card: ${title} [deploy-agent]`,
      });
      result.indexPath = opts.index.path;
      result.indexCommitted = idxCommit;
      result.cardLink = upd.link;
    } catch (err) {
      result.indexError = err.message;
    }
  }
  return result;
}

module.exports = {
  publish,
  renderContent,
  commitToGitHub,
  resolveRepoPath,
  canonicalUrl,
  resolveToken,
  fetchFile,
  pickReferencePath,
  trimReference,
  buildIndexUpdate,
  cardDescription,
  loadTarget,
  slugify,
  titleFromMarkdown,
  postedOnTimeZone,
  formatPostedOnDate,
  formatPostedOnIso,
  FORMATS,
  MODEL,
};
