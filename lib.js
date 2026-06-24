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

function stripCodeFence(text) {
  // Remove a wrapping ```lang ... ``` fence if the model adds one.
  return String(text)
    .replace(/^\s*```(?:[a-z]+)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

function metaContext(meta) {
  return [
    meta.siteName ? `Site name: ${meta.siteName}` : null,
    meta.url ? `Canonical URL / og:url: ${meta.url}` : null,
    meta.title ? `Article title (H1): ${meta.title}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function chat(system, markdown, meta) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const ctx = metaContext(meta);
  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: (ctx ? ctx + "\n\n" : "") + "Markdown article:\n\n" + markdown,
      },
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
  "- Semantic HTML5 (article, header, h1/h2/h3, p, ul/ol, figure). The H1 is the title.",
  "- A small, clean, responsive inline <style> block. No external CSS/JS, no tracking.",
  "- Preserve all content faithfully; do not invent facts.",
  "- Output ONLY the raw HTML document. No markdown, no code fences, no commentary.",
].join("\n");

const NEXT_SYSTEM = [
  "You are a senior Next.js engineer. Convert the markdown article into a single",
  "Next.js App Router page component file (TypeScript, .tsx). Requirements:",
  '- import type { Metadata } from "next";',
  "- Export `export const metadata: Metadata = {...}` with title, description",
  "  (<= 160 chars) and openGraph { title, description, type: 'article', and url",
  "  when one is given). This is a Server Component — do NOT add 'use client'.",
  "- `export default function Page() { return (<article>...</article>); }` rendering",
  "  the full article as semantic JSX (h1 for the title, then h2/h3, p, ul/ol/li).",
  "- Plain JSX with semantic elements only. Do NOT assume Tailwind or any CSS",
  "  framework and do NOT import CSS. No external components or libraries.",
  "- Escape JSX correctly (apostrophes, braces, < and >). Preserve all content",
  "  faithfully; do not invent facts.",
  "- Output ONLY the raw .tsx file contents. No markdown, no fences, no commentary.",
].join("\n");

async function renderContent(format, markdown, meta) {
  return chat(
    format === "next-tsx" ? NEXT_SYSTEM : HTML_SYSTEM,
    markdown,
    meta,
  );
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

async function commitToGitHub({
  owner,
  repo,
  branch,
  repoPath,
  content,
  message,
}) {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
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
 * High-level publish used by both CLI and server.
 * opts: { markdown, format?, repo?, branch?, path?, pathPrefix?, slug?, title?,
 *         stem?, siteName?, url?, message?, dryRun? }
 * returns { format, repoPath, bytes, committed?{url,sha}, dryRunFile? }
 */
async function publish(opts) {
  const format = (opts.format || "html").toLowerCase();
  if (!FORMATS.includes(format)) {
    throw new Error(
      `format must be one of ${FORMATS.join(" | ")}, got: ${format}`,
    );
  }
  const markdown = opts.markdown;
  if (!markdown || !String(markdown).trim())
    throw new Error("markdown is required");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const title = opts.title || titleFromMarkdown(markdown, opts.slug || "post");
  const repoPath = resolveRepoPath({
    format,
    path: opts.path,
    pathPrefix: opts.pathPrefix,
    slug: opts.slug,
    title,
    stem: opts.stem,
  });

  const rendered = await renderContent(format, markdown, {
    siteName: opts.siteName,
    url: opts.url,
    title,
  });
  const valid =
    format === "next-tsx"
      ? /export\s+default/.test(rendered)
      : /<html[\s>]/i.test(rendered);
  if (!rendered || !valid) {
    throw new Error(`model did not return a valid ${format} document`);
  }

  if (opts.dryRun) {
    const outFile = path.resolve(process.cwd(), "out", repoPath);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, rendered);
    return { format, repoPath, bytes: rendered.length, dryRunFile: outFile };
  }

  if (!opts.repo) throw new Error("repo (owner/name) is required");
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN missing");
  const [owner, repo] = String(opts.repo).split("/");
  if (!owner || !repo)
    throw new Error(`repo must be "owner/name", got: ${opts.repo}`);

  const committed = await commitToGitHub({
    owner,
    repo,
    branch: opts.branch || "main",
    repoPath,
    content: rendered,
    message: opts.message || `Publish: ${title} [deploy-agent]`,
  });
  return { format, repoPath, bytes: rendered.length, committed };
}

module.exports = {
  publish,
  renderContent,
  commitToGitHub,
  resolveRepoPath,
  loadTarget,
  slugify,
  titleFromMarkdown,
  FORMATS,
  MODEL,
};
