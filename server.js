#!/usr/bin/env node
/**
 * Webhook wrapper around the deploy agent so the n8n Review workflow can publish
 * an approved article over HTTP.
 *
 *   POST /deploy   { markdown, target?|repo, format?, branch?, path?|pathPrefix?|slug?,
 *                    siteName?, url?, message?, dryRun?,
 *                    // SEO Agent passthrough (all optional): use the brief's exact
 *                    // metadata/schema/thumbnail instead of letting the renderer improvise
 *                    metaTitle?, metaDescription?, canonical?, schemaTypes?[], thumbnail? }
 *   GET  /health   → { ok: true }
 *
 * Auth: if DEPLOY_TOKEN is set, requests must send header `x-deploy-token: <token>`.
 * Env: OPENAI_API_KEY, GITHUB_TOKEN, PORT (default 7331), DEPLOY_TOKEN (optional)
 */
require("dotenv").config();
const http = require("http");
const { publish, loadTarget } = require("./lib");

const PORT = parseInt(process.env.PORT || "7331", 10);
const TOKEN = process.env.DEPLOY_TOKEN || "";

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5_000_000) reject(new Error("payload too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true });
  }
  if (req.method !== "POST" || req.url.split("?")[0] !== "/deploy") {
    return send(res, 404, { ok: false, error: "not found" });
  }
  if (TOKEN && req.headers["x-deploy-token"] !== TOKEN) {
    return send(res, 401, { ok: false, error: "unauthorized" });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return send(res, 400, { ok: false, error: err.message });
  }

  // A named target supplies repo/branch/format/path defaults; the body overrides.
  let opts = body;
  if (body.target) {
    try {
      opts = { ...loadTarget(body.target, body.config), ...body };
    } catch (err) {
      return send(res, 400, { ok: false, error: err.message });
    }
  }

  try {
    const result = await publish(opts);
    console.log(
      `[deploy] ${result.format} → ${opts.repo || "(dry-run)"} ${result.repoPath}` +
        (result.referencePath ? ` (style: ${result.referencePath})` : "") +
        (result.committed
          ? ` (${(result.committed.sha || "").slice(0, 7)})`
          : " [dry-run]"),
    );
    return send(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error(`[deploy] error: ${err.message}`);
    return send(res, err.status && err.status < 500 ? 400 : 500, {
      ok: false,
      error: err.message,
    });
  }
});

server.listen(PORT, () => {
  console.log(`deploy-agent webhook listening on :${PORT}`);
  console.log(`  POST /deploy   GET /health`);
  if (!TOKEN)
    console.log("  (no DEPLOY_TOKEN set — endpoint is unauthenticated)");
});
