const express = require("express");
const bodyParser = require("body-parser");
const { WebClient } = require("@slack/web-api");
const { Octokit } = require("@octokit/rest");
const Anthropic = require("@anthropic-ai/sdk");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

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

function getRepoFiles(dir, baseDir = dir, fileList = []) {
  const ignore = ["node_modules", ".git", ".next", "dist", "build", ".env"];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignore.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      getRepoFiles(fullPath, baseDir, fileList);
    } else {
      const ext = path.extname(entry.name);
      if ([".js", ".jsx", ".ts", ".tsx", ".css", ".json", ".md"].includes(ext)) {
        fileList.push(path.relative(baseDir, fullPath));
      }
    }
  }
  return fileList;
}

async function runClaudeAndPR(taskDescription, channel, label) {
  const branch = `ai-${Date.now()}`;
  const repoPath = path.join(os.tmpdir(), `moon-dashboard-${Date.now()}`);

  try {
    // Clone the repo fresh into /tmp
    console.log("Cloning repo...");
    execSync(
      `git clone https://${GITHUB_TOKEN}@github.com/${OWNER}/${REPO}.git ${repoPath}`,
      { stdio: "inherit" }
    );
    execSync(`git -C ${repoPath} config user.email "ojm221100@gmail.com"`, { stdio: "inherit" });
    execSync(`git -C ${repoPath} config user.name "MoonOS Autopilot"`, { stdio: "inherit" });
    execSync(`git -C ${repoPath} checkout -b ${branch}`, { stdio: "inherit" });

    // Build context from repo files
    const files = getRepoFiles(repoPath);
    let repoContext = "";
    for (const file of files.slice(0, 30)) {
      try {
        const content = fs.readFileSync(path.join(repoPath, file), "utf8");
        repoContext += `\n\n--- ${file} ---\n${content.slice(0, 2000)}`;
      } catch (_) {}
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

    for (const [, filePath, fileContent] of fileMatches) {
      const fullPath = path.join(repoPath, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, fileContent.trim());
      console.log(`✅ Wrote ${filePath}`);
    }

    execSync(`git -C ${repoPath} add -A`, { stdio: "inherit" });

    let hasChanges = true;
    try {
      execSync(`git -C ${repoPath} diff --cached --exit-code`, { stdio: "inherit" });
      hasChanges = false;
    } catch (e) {}

    if (!hasChanges) {
      await slack.chat.postMessage({ channel, text: `⚠️ Claude ran but made no file changes for: "${label}"` });
      return;
    }

    execSync(`git -C ${repoPath} commit -m "AI: ${label.substring(0, 60)}"`, { stdio: "inherit" });
    execSync(`git -C ${repoPath} push https://${GITHUB_TOKEN}@github.com/${OWNER}/${REPO}.git ${branch}`, { stdio: "inherit" });

    const pr = await octokit.pulls.create({
      owner: OWNER, repo: REPO,
      title: `AI: ${label.substring(0, 60)}`,
      head: branch, base: "main",
      body: `Automated change from Slack.\n\nTask:\n> ${label}`,
    });

    await slack.chat.postMessage({ channel, text: `✅ PR ready for review:\n${pr.data.html_url}` });

  } finally {
    // Clean up temp folder
    try { execSync(`rm -rf ${repoPath}`); } catch (_) {}
  }
}

app.post("/slack/events", async (req, res) => {
  if (req.body.challenge) return res.send(req.body.challenge);

  const event = req.body.event;
  if (!event || !event.text || event.bot_id) return res.sendStatus(200);

  const isErrorChannel = event.channel === errorChannelId;
  const text = event.text;
  const textLower = text.toLowerCase();

  if (isErrorChannel) {
    console.log("Error received:", text.substring(0, 100));
    res.sendStatus(200);
    try {
      await slack.chat.postMessage({ channel: event.channel, text: `🔍 Error detected — running Claude to fix it...` });
      const prompt = `An error was reported in the moon-dashboard app:\n\n${text}\n\nInvestigate the relevant files and fix the root cause. Make the minimal change needed.`;
      await runClaudeAndPR(prompt, event.channel, text);
    } catch (err) {
      console.error(err);
      await slack.chat.postMessage({ channel: event.channel, text: `❌ Could not auto-fix: ${err.message}` });
    }
    return;
  }

  if (!textLower.startsWith("build") && !textLower.startsWith("fix") && !textLower.startsWith("add") && !textLower.startsWith("create")) {
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
