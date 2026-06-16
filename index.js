const express = require("express");
const bodyParser = require("body-parser");
const { WebClient } = require("@slack/web-api");
const { Octokit } = require("@octokit/rest");
const { execSync } = require("child_process");

const app = express();
app.use(bodyParser.json());

require("dotenv").config();
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OWNER = "ojm44444";
const REPO = "moon-dashboard";
const REPO_PATH = "/Users/owenmellett/moon-dashboard";
const ERROR_CHANNEL_NAME = "moon-os-support";

const slack = new WebClient(SLACK_BOT_TOKEN);
const octokit = new Octokit({ auth: GITHUB_TOKEN });

let errorChannelId = null;

// resolve channel name to ID on startup
async function resolveChannelId() {
  const result = await slack.conversations.list({ limit: 200 });
  const channel = result.channels.find(c => c.name === ERROR_CHANNEL_NAME);
  if (channel) {
    errorChannelId = channel.id;
    console.log(`✅ Error channel found: #${ERROR_CHANNEL_NAME} (${errorChannelId})`);
  } else {
    console.warn(`⚠️ Could not find channel #${ERROR_CHANNEL_NAME} — make sure the bot is invited to it`);
  }
}

async function runClaudeAndPR(prompt, channel, label) {
  const branch = `ai-${Date.now()}`;

  execSync(`git -C ${REPO_PATH} checkout main && git -C ${REPO_PATH} pull`, { stdio: "inherit" });
  execSync(`git -C ${REPO_PATH} checkout -b ${branch}`, { stdio: "inherit" });

  console.log("Running Claude Code...");
  execSync(
    `claude --dangerously-skip-permissions -p "${prompt.replace(/"/g, '\\"')}"`,
    { cwd: REPO_PATH, stdio: "inherit", timeout: 180000 }
  );

  execSync(`git -C ${REPO_PATH} add -A`, { stdio: "inherit" });

  let hasChanges = true;
  try {
    execSync(`git -C ${REPO_PATH} diff --cached --exit-code`, { stdio: "inherit" });
    hasChanges = false;
  } catch (e) {}

  if (!hasChanges) {
    await slack.chat.postMessage({
      channel,
      text: `⚠️ Claude ran but made no file changes for: "${label}"`,
    });
    execSync(`git -C ${REPO_PATH} checkout main`, { stdio: "inherit" });
    return;
  }

  execSync(`git -C ${REPO_PATH} commit -m "AI fix: ${label.substring(0, 60)}"`, { stdio: "inherit" });
  execSync(`git -C ${REPO_PATH} push origin ${branch}`, { stdio: "inherit" });

  const pr = await octokit.pulls.create({
    owner: OWNER,
    repo: REPO,
    title: `AI fix: ${label.substring(0, 60)}`,
    head: branch,
    base: "main",
    body: `Automated fix from Slack error channel.\n\nOriginal message:\n> ${label}`,
  });

  await slack.chat.postMessage({
    channel,
    text: `✅ Fix ready for review:\n${pr.data.html_url}`,
  });

  execSync(`git -C ${REPO_PATH} checkout main`, { stdio: "inherit" });
}

app.post("/slack/events", async (req, res) => {
  if (req.body.challenge) return res.send(req.body.challenge);

  const event = req.body.event;
  if (!event || !event.text || event.bot_id) return res.sendStatus(200);

  const isErrorChannel = event.channel === errorChannelId;
  const text = event.text;
  const textLower = text.toLowerCase();

  // error channel: auto-fix everything that arrives
  if (isErrorChannel) {
    console.log("Error received:", text.substring(0, 100));
    res.sendStatus(200);

    try {
      await slack.chat.postMessage({
        channel: event.channel,
        text: `🔍 Error detected — running Claude to fix it...`,
      });

      const prompt = `You are fixing a bug in the moon-dashboard app. An error was reported:\n\n${text}\n\nInvestigate the relevant files and fix the root cause. Make the minimal change needed. Do not explain, just fix it.`;
      await runClaudeAndPR(prompt, event.channel, text);
    } catch (err) {
      console.error(err);
      await slack.chat.postMessage({
        channel: event.channel,
        text: `❌ Could not auto-fix: ${err.message}`,
      });
      try { execSync(`git -C ${REPO_PATH} checkout main`, { stdio: "inherit" }); } catch (_) {}
    }
    return;
  }

  // other channels: only respond to build/fix/add/create commands
  if (!textLower.startsWith("build") && !textLower.startsWith("fix") && !textLower.startsWith("add") && !textLower.startsWith("create")) {
    return res.sendStatus(200);
  }

  console.log("Task received:", text);
  res.sendStatus(200);

  try {
    await slack.chat.postMessage({
      channel: event.channel,
      text: `🤖 On it! Running Claude on: "${text}"...`,
    });

    const prompt = `You are working on the moon-dashboard app. Task:\n\n${text}\n\nMake the necessary file changes to complete this task. Do not explain, just implement it.`;
    await runClaudeAndPR(prompt, event.channel, text);
  } catch (err) {
    console.error(err);
    await slack.chat.postMessage({
      channel: event.channel,
      text: `❌ Something went wrong: ${err.message}`,
    });
    try { execSync(`git -C ${REPO_PATH} checkout main`, { stdio: "inherit" }); } catch (_) {}
  }
});

app.listen(3000, async () => {
  console.log("🚀 MoonOS Autopilot running on port 3000");
  await resolveChannelId();
});
