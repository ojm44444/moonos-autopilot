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

const CHANNELS = {
  "moon-os-support": { repo: "moon-dashboard", mode: "fix" },
  "moon-os-build":   { repo: "moon-dashboard", mode: "build" },
  "memo-build":      { repo: "memo",            mode: "build" },
};

const slack = new WebClient(SLACK_BOT_TOKEN);
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

let channelMap = {}; // name -> { id, repo, mode }
let lastTriageTs = null;

async function resolveChannelIds() {
  const result = await slack.conversations.list({ limit: 200, types: "public_channel,private_channel" });
  for (const channel of result.channels) {
    if (CHANNELS[channel.name]) {
      channelMap[channel.id] = { name: channel.name, ...CHANNELS[channel.name] };
      console.log(`✅ Channel #${channel.name} (${channel.id}) → repo: ${CHANNELS[channel.name].repo}, mode: ${CHANNELS[channel.name].mode}`);
    }
  }
}

async function getRepoFiles(repo = "moon-dashboard") {
  const ignore = ["node_modules", ".git", ".next", "dist", "build"];
  const extensions = [".js", ".jsx", ".ts", ".tsx", ".css", ".json", ".md"];
  const files = [];

  async function listDir(dirPath) {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo, path: dirPath });
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

async function getFileContent(filePath, repo = "moon-dashboard") {
  try {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo, path: filePath });
    return Buffer.from(data.content, "base64").toString("utf8").slice(0, 2000);
  } catch (_) {
    return "";
  }
}

async function runClaudeAndPR(taskDescription, channel, label, repo = "moon-dashboard") {
  const branch = `ai-${Date.now()}`;

  // Get main branch SHA
  const { data: refData } = await octokit.git.getRef({ owner: OWNER, repo, ref: "heads/main" });
  const mainSha = refData.object.sha;

  // Create new branch
  await octokit.git.createRef({ owner: OWNER, repo, ref: `refs/heads/${branch}`, sha: mainSha });

  // Get repo context
  const filePaths = await getRepoFiles(repo);
  let repoContext = "";
  for (const fp of filePaths) {
    const content = await getFileContent(fp, repo);
    if (content) repoContext += `\n\n--- ${fp} ---\n${content}`;
  }

  console.log("Calling Claude API...");
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `You are working on the ${repo} app. Here are the current files:\n${repoContext}\n\nTask: ${taskDescription}\n\nRespond with ONLY the files to create or modify. For each file use this exact format:\n\n<file path="relative/path/to/file.tsx">\nfile contents here\n</file>\n\nDo not explain, just output the file blocks.`
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
      const { data } = await octokit.repos.getContent({ owner: OWNER, repo, path: filePath, ref: branch });
      fileSha = data.sha;
    } catch (_) {}

    await octokit.repos.createOrUpdateFileContents({
      owner: OWNER, repo,
      path: filePath,
      message: `AI: ${label.substring(0, 60)}`,
      content: encoded,
      branch,
      ...(fileSha ? { sha: fileSha } : {}),
    });
    console.log(`✅ Committed ${filePath} to ${repo}`);
  }

  const pr = await octokit.pulls.create({
    owner: OWNER, repo,
    title: `AI: ${label.substring(0, 60)}`,
    head: branch, base: "main",
    body: `Automated change from Slack.\n\nTask:\n> ${label}`,
  });

  // Auto-merge the PR
  await octokit.pulls.merge({
    owner: OWNER, repo,
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

  const ch = channelMap[event.channel];
  if (!ch) return res.sendStatus(200); // not a channel we care about

  const text = event.text;
  const textLower = text.toLowerCase();
  const isMentioned = text.includes("<@U0BB2LN6AKB>");

  // Fix channel: triage command or task keywords/mentions
  if (ch.mode === "fix") {
    const isTriageCommand = textLower.trim() === "triage";
    const isTaskCommand = isMentioned ||
      textLower.startsWith("build") || textLower.startsWith("fix") ||
      textLower.startsWith("add") || textLower.startsWith("create");

    if (isTriageCommand) {
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

    if (!isTaskCommand) return res.sendStatus(200);
  }

  // Build channels: every message is a task (no keyword needed)
  console.log(`Task received in #${ch.name} (${ch.repo}):`, text);
  res.sendStatus(200);

  try {
    let contextBlock = "";
    try {
      const history = await slack.conversations.history({ channel: event.channel, limit: 20 });
      const recentMessages = (history.messages || [])
        .filter(m => !m.bot_id)
        .reverse()
        .map(m => m.text)
        .join("\n");
      if (recentMessages) contextBlock = `\n\nRecent channel context:\n${recentMessages}`;
    } catch (_) {}

    await slack.chat.postMessage({ channel: event.channel, text: `🤖 On it! (→ ${ch.repo})` });
    await runClaudeAndPR(text + contextBlock, event.channel, text, ch.repo);
  } catch (err) {
    console.error(err);
    await slack.chat.postMessage({ channel: event.channel, text: `❌ Something went wrong: ${err.message}` });
  }
});

app.listen(3000, async () => {
  console.log("🚀 MoonOS Autopilot running on port 3000");
  await resolveChannelIds();
});
