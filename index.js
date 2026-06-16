const express = require("express");
const bodyParser = require("body-parser");
const { WebClient } = require("@slack/web-api");
const { Octokit } = require("@octokit/rest");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER = "ojm44444";
const REPO = "moon-dashboard";
const ERROR_CHANNEL_NAME = "moon-os-support";

const slack = new WebClient(SLACK_BOT_TOKEN);
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

let errorChannelId = null;
let lastTriageTs = null; // timestamp of last triage run

async function resolveChannelId() {
  const result = await slack.conversations.list({ limit: 200 });
  const channel = result.channels.find(c => c.name === ERROR_CHANNEL_NAME);
  if (channel) {
    errorChannelId = channel.id;
    console.log(`✅ Error channel found: #${ERROR_CHANNEL_NAME} (${errorChannelId})`);
  } else {
    console.warn(`⚠️ Could not find channel #${ERROR_CHANNEL_NAME}`);
  }
}

async function getRepoFiles() {
  const ignore = ["node_modules", ".git", ".next", "dist", "build"];
  const extensions = [".js", ".jsx", ".ts", ".tsx", ".css", ".json", ".md"];
  const files = [];

  async function listDir(dirPath) {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: dirPath });
    for (const item of data) {
      if (ignore.some(ig => item.name === ig)) continue;
      if (item.type === "dir") {
        await listDir(item.path);
      } else if (extensions.includes(path.extname(item.name))) {
        files.push(item.path);
      }
    }
  }

  await listDir("");
  return files.slice(0, 25);
}

async function getFileContent(filePath) {
  try {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: filePath });
    return Buffer.from(data.content, "base64").toString("utf8").slice(0, 2000);
  } catch (_) {
    return "";
  }
}

async function runClaudeAndPR(taskDescription, channel, label) {
  const branch = `ai-${Date.now()}`;

  // Get main branch SHA
  const { data: refData } = await octokit.git.getRef({ owner: OWNER, repo: REPO, ref: "heads/main" });
  const mainSha = refData.object.sha;

  // Create new branch
  await octokit.git.createRef({ owner: OWNER, repo: REPO, ref: `refs/heads/${branch}`, sha: mainSha });

  // Get repo context
  const filePaths = await getRepoFiles();
  let repoContext = "";
  for (const fp of filePaths) {
    const content = await getFileContent(fp);
    if (content) repoContext += `\n\n--- ${fp} ---\n${content}`;
  }

  console.log("Calling Claude API...");
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `You are working on the moon-dashboard Next.js app. Here are the current files:\n${repoContext}\n\nTask: ${taskDescription}\n\nRespond with ONLY the files to create or modify. For each file use this exact format:\n\n<file path="relative/path/to/file.tsx">\nfile contents here\n</file>\n\nDo not explain, just output the file blocks.`
    }]
  });

  const responseText = message.content[0].text;
  const fileMatches = [...responseText.matchAll(/<file path="([^"]+)">([\s\S]*?)<\/file>/g)];

  if (fileMatches.length === 0) {
    await slack.chat.postMessage({ channel, text: `⚠️ Claude didn't produce any file changes for: "${label}"` });
    return;
  }

  // Commit each file via GitHub API
  for (const [, filePath, fileContent] of fileMatches) {
    const content = fileContent.trim();
    const encoded = Buffer.from(content).toString("base64");

    // Check if file exists (to get SHA for update)
    let fileSha;
    try {
      const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: filePath, ref: branch });
      fileSha = data.sha;
    } catch (_) {}

    await octokit.repos.createOrUpdateFileContents({
      owner: OWNER, repo: REPO,
      path: filePath,
      message: `AI: ${label.substring(0, 60)}`,
      content: encoded,
      branch,
      ...(fileSha ? { sha: fileSha } : {}),
    });
    console.log(`✅ Committed ${filePath}`);
  }

  const pr = await octokit.pulls.create({
    owner: OWNER, repo: REPO,
    title: `AI: ${label.substring(0, 60)}`,
    head: branch, base: "main",
    body: `Automated change from Slack.\n\nTask:\n> ${label}`,
  });

  // Auto-merge the PR
  await octokit.pulls.merge({
    owner: OWNER, repo: REPO,
    pull_number: pr.data.number,
    merge_method: "squash",
  });

  await slack.chat.postMessage({ channel, text: `✅ Done! Code merged and deploying:\n${pr.data.html_url}` });
}

async function triageErrors(channel) {
  // Fetch messages from channel — all if first run, else since last triage
  const params = { channel, limit: 200 };
  if (lastTriageTs) params.oldest = lastTriageTs;

  const result = await slack.conversations.history(params);
  const messages = result.messages || [];

  // Filter out bot messages and triage commands
  const errors = messages
    .filter(m => !m.bot_id && !m.text.toLowerCase().startsWith("triage"))
    .map(m => m.text)
    .filter(t => t && t.trim().length > 10)
    .reverse(); // oldest first

  if (errors.length === 0) {
    await slack.chat.postMessage({ channel, text: `✅ No new errors since last triage!` });
    return;
  }

  await slack.chat.postMessage({ channel, text: `🔍 Found ${errors.length} error(s) — analysing and triaging...` });

  // Ask Claude to triage
  const triageMessage = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: `You are triaging errors for the moon-dashboard app. Here are the errors reported:\n\n${errors.map((e, i) => `${i + 1}. ${e}`).join("\n\n")}\n\nPlease:\n1. Remove duplicates\n2. Rank by severity (Critical / High / Medium / Low)\n3. Give a one-line summary of each unique issue\n4. List which ones you will fix (top 3 max)\n\nFormat as a clean Slack message.`
    }]
  });

  const summary = triageMessage.content[0].text;
  await slack.chat.postMessage({ channel, text: summary });

  // Fix top 3 unique errors
  const fixMessage = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `From these errors in the moon-dashboard app:\n\n${errors.join("\n\n")}\n\nList the top 3 most important unique issues to fix, one per line. Just the issue description, nothing else.`
    }]
  });

  const toFix = fixMessage.content[0].text.split("\n").filter(l => l.trim()).slice(0, 3);
  lastTriageTs = String(Date.now() / 1000);

  for (const issue of toFix) {
    await slack.chat.postMessage({ channel, text: `🔧 Fixing: ${issue}` });
    try {
      await runClaudeAndPR(issue, channel, issue);
    } catch (err) {
      await slack.chat.postMessage({ channel, text: `❌ Could not fix: ${err.message}` });
    }
  }
}

app.post("/slack/events", async (req, res) => {
  if (req.body.challenge) return res.send(req.body.challenge);

  const event = req.body.event;
  if (!event || !event.text || event.bot_id) return res.sendStatus(200);

  const isErrorChannel = event.channel === errorChannelId;
  const text = event.text;
  const textLower = text.toLowerCase();

  const isMentioned = text.includes("<@U0BB2LN6AKB>");
  const isTriageCommand = textLower.trim() === "triage";
  const isTaskCommand = textLower.startsWith("build") || textLower.startsWith("fix") || textLower.startsWith("add") || textLower.startsWith("create");

  if (isErrorChannel && isTriageCommand) {
    console.log("Triage requested");
    res.sendStatus(200);
    try {
      await triageErrors(event.channel);
    } catch (err) {
      console.error(err);
      await slack.chat.postMessage({ channel: event.channel, text: `❌ Triage failed: ${err.message}` });
    }
    return;
  }

  if (!isTaskCommand && !isMentioned) {
    return res.sendStatus(200);
  }

  console.log("Task received:", text);
  res.sendStatus(200);

  try {
    await slack.chat.postMessage({ channel: event.channel, text: `🤖 On it! Running Claude on: "${text}"...` });
    await runClaudeAndPR(text, event.channel, text);
  } catch (err) {
    console.error(err);
    await slack.chat.postMessage({ channel: event.channel, text: `❌ Something went wrong: ${err.message}` });
  }
});

app.listen(3000, async () => {
  console.log("🚀 MoonOS Autopilot running on port 3000");
  await resolveChannelId();
});
